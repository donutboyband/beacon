// The window.beacon API, built over ipcRenderer. Each method's argument and
// reply are typed by the IPC contract. Kept apart from preload.ts so the
// renderer's types can import BeaconApi without touching the preload entry,
// which stays a pure side effect (expose, nothing exported).

import type { IpcRenderer } from "electron";
import { CHANGED, type ArgOf, type Channel, type DataOf, type Result } from "../ipc/contract.ts";

export function createApi(ipcRenderer: IpcRenderer) {
  const invoke = <C extends Channel>(channel: C, ...arg: ArgOf<C> extends void ? [] : [ArgOf<C>]): Promise<Result<DataOf<C>>> =>
    ipcRenderer.invoke(channel, ...arg);

  return {
    pickFolder: () => invoke("beacon:pickFolder"),
    watch: (cwd: string) => invoke("beacon:watch", cwd),
    onChanged: (cb: () => void) => { ipcRenderer.on(CHANGED, () => cb()); },
    context: (cwd: string) => invoke("beacon:context", cwd),
    resolveAccount: (account: string) => invoke("beacon:resolveAccount", account),
    start: (cwd: string, name: string) => invoke("beacon:start", { cwd, name }),
    status: (cwd: string) => invoke("beacon:status", cwd),
    review: (cwd: string) => invoke("beacon:review", cwd),
    plan: (cwd: string) => invoke("beacon:plan", { cwd }),
    ship: (opts: ArgOf<"beacon:ship">) => invoke("beacon:ship", opts),
    openExternal: (url: string) => invoke("beacon:openExternal", url),
    detectAgents: () => invoke("beacon:detectAgents"),
    ghStatus: () => invoke("beacon:ghStatus"),
    ghAuthLogin: () => invoke("beacon:ghAuthLogin"),
    ghAuthSwitch: () => invoke("beacon:ghAuthSwitch"),
    openIn: (app: string, cwd: string) => invoke("beacon:openIn", { app, cwd }),
    commit: (cwd: string, message?: string, allowFlagged?: boolean, files?: string[]) => invoke("beacon:commit", { cwd, message, allowFlagged, files }),
    stash: (cwd: string, message?: string) => invoke("beacon:stash", { cwd, message }),
    stashList: (cwd: string) => invoke("beacon:stashList", cwd),
    // Restores the newest stash — the renderer's index argument is ignored.
    stashPop: (cwd: string) => invoke("beacon:stashPop", cwd),
    stashDetail: (cwd: string, index?: number) => invoke("beacon:stashDetail", { cwd, index }),
    stashRename: (cwd: string, index?: number, message?: string) => invoke("beacon:stashRename", { cwd, index, message }),
    workingChanges: (cwd: string) => invoke("beacon:workingChanges", cwd),
    discard: (cwd: string) => invoke("beacon:discard", cwd),
    revertOutOfScope: (cwd: string, files?: string[]) => invoke("beacon:revertOutOfScope", { cwd, files }),
    listBranches: (cwd: string) => invoke("beacon:listBranches", cwd),
    checkout: (cwd: string, branch: string) => invoke("beacon:checkout", { cwd, branch }),
    deleteBranch: (cwd: string, branch: string, force?: boolean) => invoke("beacon:deleteBranch", { cwd, branch, force }),
    dropStash: (cwd: string, index?: number) => invoke("beacon:dropStash", { cwd, index }),
    branchLog: (cwd: string) => invoke("beacon:branchLog", cwd),
    fetchRemote: (cwd: string) => invoke("beacon:fetchRemote", cwd),
    pull: (cwd: string) => invoke("beacon:pull", cwd),
    remoteState: (cwd: string, fetch?: boolean) => invoke("beacon:remoteState", { cwd, fetch }),
    listPRs: (cwd: string, account?: string) => invoke("beacon:listPRs", { cwd, account }),
    prDetail: (cwd: string, number: number, account?: string) => invoke("beacon:prDetail", { cwd, number, account }),
  };
}

// What the renderer sees as window.beacon.
export type BeaconApi = ReturnType<typeof createApi>;
