// start: branch off the latest default branch and declare its scope —
// .beacon/scope.json plus a plain-language CLAUDE.md section, committed as
// the branch's FIRST commit — then install the guard.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installGuard, removeLegacyGuard } from "./hooks.ts";
import { exists, gitFor, gitMust } from "./process.ts";
import { defaultBranch, repoRoot, requireRepo, workingTreeDirty } from "./repo.ts";
import { DEFAULT_ALLOW, DEFAULT_DENY, DEFAULT_PROTOTYPE, SCOPE_FILE } from "./scope.ts";

export function slugify(name: unknown): string {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// --- scope declaration -------------------------------------------------------

// (Re)write .beacon/scope.json for this branch. Always rewritten on start so a
// scope.json inherited from a merged branch never leaks onto a new one.
export async function writeScope({ cwd, branch, task }: { cwd?: string; branch?: string; task?: string } = {}) {
  const root = await repoRoot(cwd);
  await mkdir(join(root, ".beacon"), { recursive: true });
  const scope = {
    _comment:
      "Beacon branch scope — the enforced rule for this branch/task. Edits may touch files matching `allow` (the front end); `deny` always wins (backend, auth, routing, DB schema, API handlers, infra config). Beacon's Claude Code PreToolUse hook checks every file write against this: out-of-scope writes are flagged (never blocked) and revertable via `beacon review` before the PR goes out. `prototype` paths are the mock zone: when the UI needs backend behaviour, it gets prototyped there against fixtures instead of touching the real backend. Tune the globs per repo.",
    branch,
    task: task || branch,
    createdAt: new Date().toISOString(),
    allow: DEFAULT_ALLOW,
    deny: DEFAULT_DENY,
    prototype: DEFAULT_PROTOTYPE,
  };
  await writeFile(join(root, SCOPE_FILE), `${JSON.stringify(scope, null, 2)}\n`);
  return { path: join(root, SCOPE_FILE) };
}

// --- CLAUDE.md guidance (plain language, marker-delimited) -------------------

const CLAUDE_START = "<!-- beacon:scope -->";
const CLAUDE_END = "<!-- /beacon:scope -->";

function claudeSection(branch: string | undefined): string {
  return `${CLAUDE_START}
## Branch scope (Beacon)

This branch (\`${branch}\`) is scoped to **front-end / presentation files only** —
components, styles, view templates, static assets, and front-end test files.
See \`.beacon/scope.json\` for the enforced rule (allowed and denied path patterns).

**Never modify backend, auth, routing, database-schema, API, or infra-config
files** — a developer owns those. Beacon watches every file write: anything
outside the scope is flagged (not blocked) and reviewed — and revertable —
before a PR is opened.

### Needs backend to work? Prototype in front of it

If the change depends on backend behaviour that doesn't exist yet, don't build
the backend — build a **working prototype in front of it**:

- Put everything mock under \`.beacon/prototype/\`: fixture data plus a stubbed
  service/API layer exposing the same interface the real backend would.
- Build the real UI with the repo's **actual components, styles, and design
  tokens** — only the data behind it is fake.
- Render it separately: a sandbox entry (story, standalone page, or harness)
  inside \`.beacon/prototype/\`. Never wire mocks into production entry points
  and never register real routes.
- List the backend work needed to make it real in
  \`.beacon/prototype/README.md\` — Beacon includes it in the PR so the
  reviewing developer knows exactly what to productionize.
${CLAUDE_END}`;
}

// Append (or refresh) the Beacon section in CLAUDE.md; create the file if the
// repo doesn't have one. Marker-delimited so re-running replaces, never stacks.
export async function writeClaudeMd({ cwd, branch }: { cwd?: string; branch?: string } = {}) {
  const root = await repoRoot(cwd);
  const path = join(root, "CLAUDE.md");
  const section = claudeSection(branch);
  if (!(await exists(path))) {
    await writeFile(path, `${section}\n`);
    return { path, created: true };
  }
  const cur = await readFile(path, "utf8");
  const si = cur.indexOf(CLAUDE_START);
  const ei = cur.indexOf(CLAUDE_END);
  const next = si !== -1 && ei !== -1
    ? cur.slice(0, si) + section + cur.slice(ei + CLAUDE_END.length)
    : `${cur.replace(/\n*$/, "\n\n")}${section}\n`;
  await writeFile(path, next);
  return { path, created: false };
}

// --- start -------------------------------------------------------------------

// Create the branch off the latest default branch, declare its scope, commit
// both as the branch's FIRST commit — the declaration shows in the PR diff
// before any change does — then install the local Claude Code guard.
export async function start({ cwd, name }: { cwd?: string; name?: string }) {
  await requireRepo(cwd);
  const slug = slugify(name);
  if (!slug) throw new Error(`could not derive a branch name from "${name}"`);
  if (await workingTreeDirty(cwd)) throw new Error("working tree has uncommitted changes — commit or stash first");
  const def = await defaultBranch(cwd);
  await gitMust(cwd, "fetch", "origin", def);
  if ((await gitFor(cwd)("show-ref", "--verify", `refs/heads/${slug}`)).code === 0) {
    throw new Error(`branch "${slug}" already exists`);
  }
  await gitMust(cwd, "switch", "-c", slug, `origin/${def}`, "--no-track");

  // Clear any pre-Beacon commit-blocking hook BEFORE committing the scope —
  // it would otherwise reject the declaration commit itself.
  const legacy = await removeLegacyGuard(cwd);

  await writeScope({ cwd, branch: slug, task: String(name).trim() });
  const claude = await writeClaudeMd({ cwd, branch: slug });

  await gitMust(cwd, "add", "--", SCOPE_FILE, "CLAUDE.md");
  let committed = false;
  if ((await gitFor(cwd)("diff", "--cached", "--quiet")).code !== 0) {
    await gitMust(cwd, "commit", "-m", `Beacon: declare front-end scope for ${slug}`);
    committed = true;
  }

  const guard = await installGuard(cwd);
  return {
    branch: slug,
    base: `origin/${def}`,
    scopePath: SCOPE_FILE,
    claudeMdCreated: claude.created,
    committed,
    guardInstalled: guard.installed,
    guardNote: guard.reason || null,
    legacyGuardRemoved: legacy.removed,
  };
}
