// Repo introspection: what kind of checkout this is and where things live.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists, gitFor, gitMust, run } from "./process.ts";
import { DEFAULT_SCOPE, SCOPE_FILE, scopeFrom } from "./scope.ts";
import type { ScopeConfig } from "./types.ts";

export async function isRepo(cwd?: string): Promise<boolean> {
  const r = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout === "true";
}

export async function currentBranch(cwd?: string): Promise<string> {
  return (await gitFor(cwd)("branch", "--show-current")).stdout;
}

export async function defaultBranch(cwd?: string): Promise<string> {
  const git = gitFor(cwd);
  const r = await git("symbolic-ref", "refs/remotes/origin/HEAD");
  if (r.code === 0 && r.stdout) return r.stdout.replace("refs/remotes/origin/", "");
  for (const cand of ["main", "master"]) {
    if ((await git("show-ref", "--verify", `refs/remotes/origin/${cand}`)).code === 0) return cand;
  }
  return "main";
}

export async function workingTreeDirty(cwd?: string): Promise<boolean> {
  return (await gitMust(cwd, "status", "--porcelain")).length > 0;
}

export async function originUrl(cwd?: string): Promise<string> {
  const r = await gitFor(cwd)("remote", "get-url", "origin");
  return r.code === 0 ? r.stdout : "";
}

export async function ownerRepo(cwd?: string): Promise<string | null> {
  const m = (await originUrl(cwd)).match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m?.[1] ?? null;
}

export function repoRoot(cwd?: string): Promise<string> {
  return gitMust(cwd, "rev-parse", "--show-toplevel");
}

export async function absoluteGitDir(cwd?: string): Promise<string | null> {
  const r = await run("git", ["rev-parse", "--absolute-git-dir"], { cwd });
  return r.code === 0 && r.stdout ? r.stdout : null;
}

// Where Beacon keeps its local, never-committed state: <git-dir>/beacon/
// (inside .git so `git add -A` can never sweep it into a commit).
export async function beaconDir(cwd?: string): Promise<string> {
  return join((await absoluteGitDir(cwd)) ?? join(await repoRoot(cwd), ".git"), "beacon");
}

// The branch's scope, or the defaults when scope.json is missing or malformed.
export async function loadScope(cwd?: string): Promise<ScopeConfig> {
  const path = join(await repoRoot(cwd), SCOPE_FILE);
  if (await exists(path)) {
    try {
      return scopeFrom(JSON.parse(await readFile(path, "utf8")), DEFAULT_SCOPE);
    } catch {
      /* malformed scope — fall back to defaults */
    }
  }
  return DEFAULT_SCOPE;
}

// Precondition shared by most commands.
export async function requireRepo(cwd?: string): Promise<void> {
  if (!(await isRepo(cwd))) throw new Error("not a git repository");
}
