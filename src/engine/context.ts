// A full snapshot the UI can render on load.

import { ghReady } from "./gh.ts";
import { currentBranch, defaultBranch, isRepo, originUrl, ownerRepo, workingTreeDirty } from "./repo.ts";

export interface RepoContext {
  cwd?: string;
  isRepo: boolean;
  branch?: string;
  defaultBranch?: string;
  dirty?: boolean;
  ownerRepo?: string | null;
  originUrl?: string;
  ghReady?: boolean;
}

export async function getContext(cwd?: string): Promise<RepoContext> {
  if (!(await isRepo(cwd))) return { cwd, isRepo: false };
  return {
    cwd,
    isRepo: true,
    branch: await currentBranch(cwd),
    defaultBranch: await defaultBranch(cwd),
    dirty: await workingTreeDirty(cwd),
    ownerRepo: await ownerRepo(cwd),
    originUrl: await originUrl(cwd),
    ghReady: await ghReady(),
  };
}
