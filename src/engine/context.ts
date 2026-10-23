// A full snapshot the UI can render on load.

import { ghReady } from "./gh.ts";
import { currentBranch, defaultBranch, isRepo, originUrl, ownerRepo, workingTreeDirty } from "./repo.ts";

export function getContext(cwd?: string) {
  if (!isRepo(cwd)) return { cwd, isRepo: false };
  return {
    cwd,
    isRepo: true,
    branch: currentBranch(cwd),
    defaultBranch: defaultBranch(cwd),
    dirty: workingTreeDirty(cwd),
    ownerRepo: ownerRepo(cwd),
    originUrl: originUrl(cwd),
    ghReady: ghReady(),
  };
}
