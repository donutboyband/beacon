// status: every change on the branch vs its base, with zones and reuse signal.

import { analyzeAddedLines, baseRef, changedFiles, fullDiff } from "./diff.ts";
import { gitFor, run } from "./process.ts";
import { currentBranch, defaultBranch, loadScope, requireRepo } from "./repo.ts";
import type { StatusResult } from "./types.ts";

export function status({ cwd, fetch: doFetch = true }: { cwd?: string; fetch?: boolean } = {}): StatusResult {
  requireRepo(cwd);
  const branch = currentBranch(cwd);
  if (!branch) throw new Error("detached HEAD — checkout a branch first");
  const def = defaultBranch(cwd);
  if (doFetch) run("git", ["fetch", "origin", def], { cwd });
  const cfg = loadScope(cwd);
  const base = baseRef(cwd, def);
  const files = changedFiles(cwd, base, cfg);
  const signal = analyzeAddedLines(fullDiff(cwd, base));
  const stat = gitFor(cwd)("diff", "--shortstat", base).stdout || "";
  return { branch, defaultBranch: def, files, signal, stat };
}
