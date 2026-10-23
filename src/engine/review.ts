// review — flagged / out-of-scope changes on this branch, pre-PR — and the
// per-file revert that undoes them.

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { baseRef, untrackedFiles } from "./diff.ts";
import { readFlagEvents, readFlags } from "./flags.ts";
import { exists, gitFor, gitMust, tempFile } from "./process.ts";
import { beaconDir, defaultBranch, loadScope, repoRoot, requireRepo } from "./repo.ts";
import { PROTO_NOTES, isOutOfScope, scopeReason } from "./scope.ts";
import { status } from "./status.ts";

// Everything on this branch that sits outside the declared scope — the diff is
// the source of truth (it catches writes the hook never saw), enriched with
// the guard's flag log (when/how the agent drifted). Files that were flagged
// but no longer differ from base are resolved, so they don't appear.
export async function review({ cwd, fetch: doFetch = false }: { cwd?: string; fetch?: boolean } = {}) {
  const s = await status({ cwd, fetch: doFetch });
  const cfg = await loadScope(cwd);
  const flags = await readFlags(await beaconDir(cwd), s.branch);
  const flagged = s.files
    .filter((f) => f.outOfScope)
    .map((f) => {
      const flag = flags.get(f.file) || null;
      return { ...f, flag, reason: (flag && flag.reason) || scopeReason(f.file, cfg) };
    });
  const prototype = s.files.filter((f) => f.prototype);
  // The guard's recent activity, newest first. An event whose file no longer
  // differs from base is resolved (reverted, or the agent self-corrected).
  const stillFlagged = new Set(flagged.map((f) => f.file));
  const events = (await readFlagEvents(await beaconDir(cwd), s.branch)).slice(-20).reverse()
    .map((e) => ({ ...e, resolved: !stillFlagged.has(e.file) }));
  return {
    branch: s.branch,
    defaultBranch: s.defaultBranch,
    totalChanges: s.files.length,
    inScope: s.files.length - flagged.length - prototype.length,
    flagged,
    prototype,
    protoNotes: await readProtoNotes(cwd),
    events,
    files: s.files,
    stat: s.stat,
  };
}

// The prototype's "what the backend needs to provide" doc, if the agent wrote
// one — lifted into the PR description and shown in review.
export async function readProtoNotes(cwd?: string): Promise<string | null> {
  const path = join(await repoRoot(cwd), PROTO_NOTES);
  if (!(await exists(path))) return null;
  try {
    let lines = (await readFile(path, "utf8")).split("\n").slice(0, 40);
    // Drop a leading title — the PR section supplies its own heading.
    while (lines.length && !lines[0]!.trim()) lines.shift();
    if (lines.length && /^#\s/.test(lines[0]!)) lines.shift();
    return lines.join("\n").trim() || null;
  } catch { return null; }
}

// Revert out-of-scope changes on this branch — uncommitted AND already-committed
// — back to the base (default branch), leaving in-scope work untouched. Pass
// `files` to revert specific flagged files (the per-item revert in review);
// omit it to revert everything out of scope. Anything that was committed is
// undone with one new commit (no history rewrite, so it's safe on a pushed
// branch / open PR).
export async function revertOutOfScope({ cwd, files }: { cwd?: string; files?: string[] } = {}) {
  await requireRepo(cwd);
  const root = await repoRoot(cwd);
  const cfg = await loadScope(cwd);
  const base = await baseRef(cwd, await defaultBranch(cwd));
  const g = gitFor(cwd);

  // Every path that differs from base: committed, staged, unstaged, or untracked.
  const paths = new Set<string>();
  for (const range of [`${base}...HEAD`, "HEAD", "--cached"]) {
    for (const p of ((await g("diff", "--name-only", range)).stdout || "").split("\n").filter(Boolean)) paths.add(p);
  }
  for (const p of await untrackedFiles(cwd)) paths.add(p);
  let targets = [...paths].filter((f) => isOutOfScope(f, cfg));
  if (files && files.length) {
    const wanted = new Set(files);
    targets = targets.filter((f) => wanted.has(f));
  }
  if (!targets.length) return { reverted: 0, committed: false, files: [] };

  for (const f of targets) {
    if ((await g("cat-file", "-e", `${base}:${f}`)).code === 0) {
      await g("checkout", base, "--", f); // restore the base version (stages it)
    } else if ((await g("cat-file", "-e", `HEAD:${f}`)).code === 0) {
      await g("rm", "-f", "--", f); // added & committed on the branch → stage a deletion
    } else {
      try { await rm(join(root, f), { force: true }); } catch { /* already gone */ }
      await g("reset", "-q", "--", f); // untracked new file → just remove it, unstaged
    }
  }

  // If undoing committed changes staged anything, land it as one commit.
  let committed = false;
  if ((await g("diff", "--cached", "--quiet")).code !== 0) {
    const msg = targets.length === 1
      ? `Beacon: revert out-of-scope change to ${targets[0]}`
      : "Beacon: revert out-of-scope changes";
    await gitMust(cwd, "commit", "-F", await tempFile("msg.txt", msg));
    committed = true;
  }
  return { reverted: targets.length, committed, files: targets };
}
