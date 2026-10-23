// Stashes: setting changes aside without committing, and managing the list.

import { statusWord } from "./diff.ts";
import { gitFor, gitMust } from "./process.ts";
import { requireRepo } from "./repo.ts";

// Set current changes aside (including untracked) without committing.
export function stash({ cwd, message }: { cwd?: string; message?: string } = {}) {
  requireRepo(cwd);
  const args = ["stash", "push", "-u"];
  if (message && message.trim()) args.push("-m", message.trim());
  const r = gitFor(cwd)(...args);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "stash failed");
  const nothing = /no local changes/i.test(r.stdout);
  return { stashed: !nothing, note: r.stdout };
}

export function stashList({ cwd }: { cwd?: string } = {}): string[] {
  const r = gitFor(cwd)("stash", "list");
  return (r.stdout || "").split("\n").filter(Boolean);
}

// Bring back the most recently stashed changes.
export function stashPop({ cwd }: { cwd?: string } = {}) {
  const r = gitFor(cwd)("stash", "pop");
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "nothing to restore");
  return { popped: true };
}

// Rename a stash entry. Git can't rename in place, so we re-store the same
// commit under the new message, then drop the original (content stays referenced
// the whole time). Renaming moves the entry to the top of the stash list.
export function stashRename({ cwd, index = 0, message }: { cwd?: string; index?: number; message?: string } = {}) {
  if (!message || !message.trim()) throw new Error("a stash name is required");
  const sha = gitFor(cwd)("rev-parse", `stash@{${index}}`).stdout;
  if (!sha) throw new Error(`no stash at index ${index}`);
  // Drop the entry, then re-store the same commit under the new message. The
  // commit object survives the drop (dangling until GC), so content is safe.
  gitMust(cwd, "stash", "drop", `stash@{${index}}`);
  gitMust(cwd, "stash", "store", "-m", message.trim(), sha);
  return { renamed: true, message: message.trim() };
}

// Discard a stash entry without restoring it. Destructive — the entry is gone.
export function dropStash({ cwd, index = 0 }: { cwd?: string; index?: number } = {}) {
  requireRepo(cwd);
  const r = gitFor(cwd)("stash", "drop", `stash@{${index}}`);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "could not delete stash");
  return { dropped: index };
}

// Files inside a specific stash entry.
export function stashDetail({ cwd, index = 0 }: { cwd?: string; index?: number } = {}) {
  const r = gitFor(cwd)("stash", "show", "--name-status", `stash@{${index}}`);
  const files = (r.stdout || "").split("\n").filter(Boolean).map((line) => {
    const parts = line.split(/\t/);
    return { status: statusWord(parts[0]?.[0]), file: parts[parts.length - 1]! };
  });
  return { index, files };
}
