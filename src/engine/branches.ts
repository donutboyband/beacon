// Branches and sync: list, switch, delete, fetch/pull, ahead/behind, and the
// branch's own commit log.

import { baseRef } from "./diff.ts";
import { gitFor, gitMust, run } from "./process.ts";
import { currentBranch, defaultBranch, isRepo, requireRepo, workingTreeDirty } from "./repo.ts";

// All local branches, most-recently-committed first, with the current and
// default branch flagged. Read-only — safe to call on every repo load.
export function listBranches({ cwd }: { cwd?: string } = {}) {
  if (!isRepo(cwd)) return { current: "", defaultBranch: "main", branches: [] };
  const cur = currentBranch(cwd);
  const def = defaultBranch(cwd);
  const r = gitFor(cwd)(
    "for-each-ref", "refs/heads", "--sort=-committerdate",
    "--format=%(refname:short)%09%(committerdate:unix)%09%(objectname:short)%09%(upstream:short)"
  );
  const branches = (r.stdout || "").split("\n").filter(Boolean).map((line) => {
    const [name = "", ts, oid, upstream] = line.split("\t");
    return {
      name,
      oid: oid || "",
      upstream: upstream || null,
      date: ts ? new Date(Number(ts) * 1000).toISOString() : null,
      current: name === cur,
      isDefault: name === def,
    };
  });
  return { current: cur, defaultBranch: def, branches };
}

// Switch to an existing local branch. Refuses on a dirty tree (like `start`)
// so uncommitted work is never silently disturbed. Purely reversible.
export function checkout({ cwd, branch }: { cwd?: string; branch?: string } = {}) {
  requireRepo(cwd);
  if (!branch) throw new Error("no branch given");
  if (workingTreeDirty(cwd)) throw new Error("working tree has uncommitted changes — commit or stash first");
  gitMust(cwd, "switch", branch);
  return { branch };
}

// Delete a local branch. Refuses the current or default branch. Without force,
// git refuses branches with unmerged commits — the UI re-calls with force after
// a second confirmation. Never touches the remote.
export function deleteBranch({ cwd, branch, force = false }: { cwd?: string; branch?: string; force?: boolean } = {}) {
  requireRepo(cwd);
  if (!branch) throw new Error("no branch given");
  if (branch === currentBranch(cwd)) throw new Error("can't delete the branch you're on — switch away first");
  if (branch === defaultBranch(cwd)) throw new Error("can't delete the default branch");
  const r = gitFor(cwd)("branch", force ? "-D" : "-d", branch);
  if (r.code !== 0) {
    const msg = r.stderr || r.stdout || "could not delete branch";
    if (/not fully merged/i.test(msg)) throw new Error("unmerged");
    throw new Error(msg);
  }
  return { deleted: branch, forced: force };
}

// Fetch remote refs (no working-tree changes). Safe to call anytime.
export function fetchRemote({ cwd }: { cwd?: string } = {}) {
  requireRepo(cwd);
  const r = gitFor(cwd)("fetch", "origin", "--prune");
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "fetch failed");
  return { fetched: true };
}

// Pull the current branch (fast-forward only — never creates a merge or leaves
// conflicts; if it can't fast-forward it errors cleanly for the UI to surface).
export function pull({ cwd }: { cwd?: string } = {}) {
  requireRepo(cwd);
  const branch = currentBranch(cwd);
  if (!branch) throw new Error("detached HEAD — checkout a branch first");
  if (workingTreeDirty(cwd)) throw new Error("you have uncommitted changes — save or set them aside first");
  const r = gitFor(cwd)("pull", "--ff-only");
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "pull failed");
  return { pulled: true, note: r.stdout };
}

// How far the current branch is ahead/behind its upstream. Optionally fetches
// first so the answer reflects the real remote. Drives the "pull first" prompt.
export function remoteState({ cwd, fetch = false }: { cwd?: string; fetch?: boolean } = {}) {
  if (!isRepo(cwd)) return { behind: 0, ahead: 0, upstream: null };
  if (fetch) run("git", ["fetch", "origin", "--prune"], { cwd });
  const branch = currentBranch(cwd);
  if (!branch) return { behind: 0, ahead: 0, upstream: null };
  const up = gitFor(cwd)("rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`);
  if (up.code !== 0 || !up.stdout) return { behind: 0, ahead: 0, upstream: null };
  const counts = gitFor(cwd)("rev-list", "--left-right", "--count", `${branch}...${up.stdout}`);
  const parts = (counts.stdout || "0 0").split(/\s+/);
  return { ahead: Number(parts[0]) || 0, behind: Number(parts[1]) || 0, upstream: up.stdout };
}

// The "saves" (commits) made on this branch since it left the default branch,
// newest first, each with its own change counts. Powers the branch activity view.
export function branchLog({ cwd }: { cwd?: string } = {}) {
  requireRepo(cwd);
  const branch = currentBranch(cwd);
  const def = defaultBranch(cwd);
  const base = baseRef(cwd, def);
  // \x1e separates commits, \x1f separates fields; numstat lines follow each header.
  const raw = gitFor(cwd)("log", `${base}..HEAD`, "--numstat", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s").stdout || "";
  const commits = raw.split("\x1e").filter((c) => c.trim()).map((chunk) => {
    const lines = chunk.split("\n");
    const [oid, author, date, ...rest] = (lines[0] ?? "").split("\x1f");
    let additions = 0, deletions = 0, files = 0;
    for (const l of lines.slice(1)) {
      if (!l.trim()) continue;
      const [a, d] = l.split("\t");
      files++;
      if (a !== "-") additions += Number(a) || 0;
      if (d !== "-") deletions += Number(d) || 0;
    }
    return { oid: (oid || "").slice(0, 7), author, date, message: rest.join("\x1f"), files, additions, deletions };
  });
  return { branch, defaultBranch: def, count: commits.length, commits };
}
