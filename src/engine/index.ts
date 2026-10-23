// Beacon engine — pure logic, no console output, no process.exit, and never
// blocking: git and gh run as child processes, so every function is async.
// Each takes an options object (always including `cwd`, the repo to operate
// on) and RESOLVES to structured data or rejects with an Error. Both the CLI
// and the Electron app consume this module (built to out/engine.mjs).

export { isRepo, currentBranch, defaultBranch, workingTreeDirty, ownerRepo } from "./repo.ts";
export { ghReady, ghIdentity, ghStatus, listPullRequests, pullRequestDetail } from "./gh.ts";
export { getContext } from "./context.ts";
export { listBranches, checkout, deleteBranch, fetchRemote, pull, remoteState, branchLog } from "./branches.ts";
export { SCOPE_FILE, PROTO_NOTES, DEFAULT_PROTOTYPE, DEFAULT_ALLOW, DEFAULT_DENY } from "./scope.ts";
export { status } from "./status.ts";
export { slugify, writeScope, writeClaudeMd, start } from "./start.ts";
export { installGuard } from "./hooks.ts";
export { review, revertOutOfScope } from "./review.ts";
export { plan } from "./describe.ts";
export { ship } from "./ship.ts";
export { commit, workingChanges, discard } from "./working.ts";
export { stash, stashList, stashPop, stashRename, dropStash, stashDetail } from "./stash.ts";

export type * from "./types.ts";
