// The local Claude Code PreToolUse guard (alert-and-flag, never block), and
// cleanup of the pre-Beacon hook it replaces.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, run } from "./process.ts";
import { absoluteGitDir, beaconDir, repoRoot } from "./repo.ts";

// The built guard sits beside the built engine (out/guard.mjs next to
// out/engine.mjs); `start` copies it into each repo it guards.
const GUARD_SOURCE = fileURLToPath(new URL("./guard.mjs", import.meta.url));

// Make sure a repo-local git exclude covers a path (kept out of commits without
// touching the repo's committed .gitignore).
async function ensureExcluded(cwd: string | undefined, pattern: string): Promise<void> {
  const gitDir = await absoluteGitDir(cwd);
  if (!gitDir) return;
  const info = join(gitDir, "info");
  await mkdir(info, { recursive: true });
  const path = join(info, "exclude");
  const cur = (await exists(path)) ? await readFile(path, "utf8") : "";
  if (cur.split("\n").includes(pattern)) return;
  await writeFile(path, `${cur.replace(/\n*$/, "\n")}${pattern}\n`);
}

// Remove the pre-Beacon (Devsigner-era) commit-blocking pre-commit guard, if
// this repo still has one. Beacon flags — it never blocks — so the old hook
// would fight the new model. Restores any backed-up original hook.
export async function removeLegacyGuard(cwd?: string): Promise<{ removed: boolean }> {
  const r = await run("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd });
  if (r.code !== 0 || !r.stdout) return { removed: false };
  const dir = r.stdout;
  const pre = join(dir, "pre-commit");
  if (!(await exists(pre)) || !(await readFile(pre, "utf8")).includes("devsigner-editable-zone-guard")) return { removed: false };
  const backup = join(dir, "pre-commit.pre-graft");
  if (await exists(backup)) {
    await writeFile(pre, await readFile(backup, "utf8"));
    await rm(backup, { force: true });
  } else {
    await rm(pre, { force: true });
  }
  await rm(join(dir, "devsigner-zone-check.mjs"), { force: true });
  return { removed: true };
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: unknown }[];
}

// Install the PreToolUse guard (idempotent):
//   <git-dir>/beacon/guard.mjs        the checker (flags.jsonl lands beside it)
//   .claude/settings.local.json      registers the hook for Claude Code
// The settings file is added to .git/info/exclude so it never rides along in a
// commit. Returns installed:false (with a reason) rather than throwing, so a
// hook problem never stops a branch from being created.
export async function installGuard(cwd?: string): Promise<{ installed: boolean; guardPath?: string; reason?: string }> {
  const root = await repoRoot(cwd);
  const dir = await beaconDir(cwd);
  await mkdir(dir, { recursive: true });
  const guardPath = join(dir, "guard.mjs");
  await writeFile(guardPath, await readFile(GUARD_SOURCE, "utf8"));

  // $CLAUDE_PROJECT_DIR keeps the registration portable while the git dir sits
  // at <root>/.git; a linked worktree gets the absolute path instead.
  const command = dir === join(root, ".git", "beacon")
    ? `node "$CLAUDE_PROJECT_DIR/.git/beacon/guard.mjs"`
    : `node "${guardPath}"`;

  const settingsPath = join(root, ".claude", "settings.local.json");
  let settings: { hooks?: { PreToolUse?: HookEntry[] } } & Record<string, unknown> = {};
  if (await exists(settingsPath)) {
    try { settings = JSON.parse(await readFile(settingsPath, "utf8")); }
    catch { return { installed: false, reason: ".claude/settings.local.json is not valid JSON — fix it and re-run start" }; }
  }
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  const present = settings.hooks.PreToolUse.some((entry) =>
    (entry.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("beacon/guard.mjs")));
  if (!present) {
    settings.hooks.PreToolUse.push({
      matcher: "Write|Edit|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command }],
    });
  }
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await ensureExcluded(cwd, ".claude/settings.local.json");
  return { installed: true, guardPath };
}
