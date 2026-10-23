// status: every change on the branch vs its base, with zones and reuse signal.

import { analyzeAddedLines, baseRef, changedFiles, fullDiff } from "./diff.ts";
import { gitFor, run } from "./process.ts";
import { currentBranch, defaultBranch, loadScope, requireRepo } from "./repo.ts";
import type { StatusResult } from "./types.ts";

export async function status({ cwd, fetch: doFetch = true }: { cwd?: string; fetch?: boolean } = {}): Promise<StatusResult> {
  await requireRepo(cwd);
  const branch = await currentBranch(cwd);
  if (!branch) throw new Error("detached HEAD — checkout a branch first");
  const def = await defaultBranch(cwd);
  if (doFetch) await run("git", ["fetch", "origin", def], { cwd });
  const cfg = await loadScope(cwd);
  const base = await baseRef(cwd, def);
  const files = await changedFiles(cwd, base, cfg);
  const signal = analyzeAddedLines(await fullDiff(cwd, base));
  const stat = (await gitFor(cwd)("diff", "--shortstat", base)).stdout || "";
  return { branch, defaultBranch: def, files, signal, stat };
}
