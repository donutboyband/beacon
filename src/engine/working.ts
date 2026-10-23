// The working tree: uncommitted changes, saving them ("Save" in the UI), and
// throwing them away.

import { gitMust, run, tempFile } from "./process.ts";
import { currentBranch, loadScope, requireRepo } from "./repo.ts";
import { fileZone } from "./scope.ts";
import { status } from "./status.ts";
import type { ChangedFile } from "./types.ts";

// Current uncommitted changes (staged + unstaged + untracked) — the working tree,
// independent of the base comparison. Used for the always-visible working-tree view.
// NOTE: porcelain output is parsed raw (no trim) — the two status columns can
// legitimately start with a space, and trimming would eat the first path's
// leading character. -uall lists files inside untracked directories.
export async function workingChanges({ cwd }: { cwd?: string } = {}): Promise<{ branch: string; files: ChangedFile[] }> {
  await requireRepo(cwd);
  const cfg = await loadScope(cwd);
  const res = await run("git", ["status", "--porcelain", "-uall"], { cwd, trim: false });
  const files = res.stdout.split("\n").filter(Boolean).map((line) => {
    const x = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(" -> ")) file = file.split(" -> ")[1]!; // renames
    file = file.replace(/^"|"$/g, "");
    let status = "modified";
    if (x === "??" || x.includes("A")) status = "added";
    else if (x.includes("D")) status = "deleted";
    else if (x.includes("R")) status = "renamed";
    const zone = fileZone(file, cfg);
    return { file, status, outOfScope: zone === "out", prototype: zone === "prototype" };
  });
  return { branch: await currentBranch(cwd), files };
}

// Stage and commit ("Save" in the UI). Out-of-scope files are allowed but
// flagged: the UI passes allowFlagged so a designer can save freely (and the
// change shows in the save list); the flagged files surface in the branch view
// and the pre-PR review instead of blocking mid-task.
//
// Pass `files` to save just those files (the per-row Save button): only their
// uncommitted changes are committed — everything else stays exactly as it is,
// staged or not.
export async function commit({ cwd, message, allowFlagged = false, files }: { cwd?: string; message?: string; allowFlagged?: boolean; files?: string[] } = {}) {
  await requireRepo(cwd);

  let targets: ChangedFile[];      // the changes this commit will contain
  let pathspec: string[] | null = null; // non-null = per-file save
  if (files && files.length) {
    const wanted = new Set(files);
    targets = (await workingChanges({ cwd })).files.filter((f) => wanted.has(f.file));
    if (!targets.length) throw new Error("no unsaved changes in the selected file(s)");
    pathspec = targets.map((f) => f.file);
  } else {
    targets = (await status({ cwd, fetch: false })).files;
    if (!targets.length) throw new Error("nothing to commit — no changes yet");
  }

  const flagged = targets.filter((f) => f.outOfScope).map((f) => f.file);
  if (flagged.length && !allowFlagged) {
    throw new Error(`can't commit — ${flagged.length} file(s) outside this branch's scope:\n${flagged.map((f) => `  ${f}`).join("\n")}`);
  }

  const fallback = pathspec && pathspec.length === 1 ? `Update ${pathspec[0]!.split("/").pop()}` : "Update";
  const finalMessage = (message && message.trim()) || fallback;
  const msgFile = await tempFile("msg.txt", finalMessage);

  if (pathspec) {
    // Stage the chosen files (covers untracked adds and deletions), then commit
    // only that pathspec — other staged work is left untouched for a later save.
    await gitMust(cwd, "add", "--", ...pathspec);
    await gitMust(cwd, "commit", "-F", msgFile, "--", ...pathspec);
  } else {
    await gitMust(cwd, "add", "-A");
    await gitMust(cwd, "commit", "-F", msgFile);
  }
  return { committed: true, message: finalMessage, files: targets.length, flagged: flagged.length };
}

// Throw away all uncommitted changes (tracked reset + untracked removed). Destructive.
export async function discard({ cwd }: { cwd?: string } = {}) {
  await requireRepo(cwd);
  await gitMust(cwd, "reset", "--hard", "HEAD");
  await run("git", ["clean", "-fd"], { cwd });
  return { discarded: true };
}
