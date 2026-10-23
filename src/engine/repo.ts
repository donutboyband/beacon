// Repo introspection: what kind of checkout this is and where things live.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gitFor, gitMust, run } from "./process.ts";
import { DEFAULT_SCOPE, SCOPE_FILE, scopeFrom } from "./scope.ts";
import type { ScopeConfig } from "./types.ts";

export function isRepo(cwd?: string): boolean {
  const r = run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout === "true";
}

export function currentBranch(cwd?: string): string {
  return gitFor(cwd)("branch", "--show-current").stdout;
}

export function defaultBranch(cwd?: string): string {
  const git = gitFor(cwd);
  const r = git("symbolic-ref", "refs/remotes/origin/HEAD");
  if (r.code === 0 && r.stdout) return r.stdout.replace("refs/remotes/origin/", "");
  for (const cand of ["main", "master"]) {
    if (git("show-ref", "--verify", `refs/remotes/origin/${cand}`).code === 0) return cand;
  }
  return "main";
}

export function workingTreeDirty(cwd?: string): boolean {
  return gitMust(cwd, "status", "--porcelain").length > 0;
}

export function originUrl(cwd?: string): string {
  const r = gitFor(cwd)("remote", "get-url", "origin");
  return r.code === 0 ? r.stdout : "";
}

export function ownerRepo(cwd?: string): string | null {
  const m = originUrl(cwd).match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m?.[1] ?? null;
}

export function repoRoot(cwd?: string): string {
  return gitMust(cwd, "rev-parse", "--show-toplevel");
}

export function absoluteGitDir(cwd?: string): string | null {
  const r = run("git", ["rev-parse", "--absolute-git-dir"], { cwd });
  return r.code === 0 && r.stdout ? r.stdout : null;
}

// Where Beacon keeps its local, never-committed state: <git-dir>/beacon/
// (inside .git so `git add -A` can never sweep it into a commit).
export function beaconDir(cwd?: string): string {
  return join(absoluteGitDir(cwd) ?? join(repoRoot(cwd), ".git"), "beacon");
}

// The branch's scope, or the defaults when scope.json is missing or malformed.
export function loadScope(cwd?: string): ScopeConfig {
  const path = join(repoRoot(cwd), SCOPE_FILE);
  if (existsSync(path)) {
    try {
      return scopeFrom(JSON.parse(readFileSync(path, "utf8")), DEFAULT_SCOPE);
    } catch {
      /* malformed scope — fall back to defaults */
    }
  }
  return DEFAULT_SCOPE;
}

// Precondition shared by most commands.
export function requireRepo(cwd?: string): void {
  if (!isRepo(cwd)) throw new Error("not a git repository");
}
