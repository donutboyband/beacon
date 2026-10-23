// The IPC contract between the main process and the renderer: every channel,
// what it takes, and what it resolves to. Main (handlers), preload (the
// window.beacon bridge), and renderer all type against this one table, and
// the result types come straight from the engine's own signatures — so a
// mismatch anywhere is a compile error, not an `undefined` at runtime.

import type * as engine from "../engine/index.ts";

type Resolved<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

// Every handler's reply. The renderer unwraps it (and toasts the error).
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface Channels {
  // OS and app-level
  "beacon:pickFolder": { arg: void; data: string | null };
  "beacon:watch": { arg: string; data: { watching: boolean } };
  "beacon:openExternal": { arg: string; data: true };
  "beacon:detectAgents": { arg: void; data: { cursor: boolean; claude: boolean } };
  "beacon:openIn": { arg: { app: string; cwd: string }; data: { launched: string } };

  // GitHub identity
  "beacon:ghStatus": { arg: void; data: Resolved<typeof engine.ghStatus> };
  "beacon:ghAuthLogin": { arg: void; data: { launched: true } };
  "beacon:ghAuthSwitch": { arg: void; data: { launched: true } };
  "beacon:resolveAccount": { arg: string; data: { token: string | undefined; identity: string | null } };

  // Repo and branch work (the engine)
  "beacon:context": { arg: string; data: Resolved<typeof engine.getContext> };
  "beacon:start": { arg: { cwd: string; name: string }; data: Resolved<typeof engine.start> };
  "beacon:status": { arg: string; data: Resolved<typeof engine.status> };
  "beacon:review": { arg: string; data: Resolved<typeof engine.review> };
  "beacon:plan": { arg: { cwd: string }; data: Resolved<typeof engine.plan> };
  "beacon:ship": {
    arg: { cwd: string; dryRun?: boolean; title?: string; account?: string; allowFlagged?: boolean };
    data: Resolved<typeof engine.ship>;
  };
  "beacon:commit": { arg: { cwd: string; message?: string; allowFlagged?: boolean; files?: string[] }; data: Resolved<typeof engine.commit> };
  "beacon:stash": { arg: { cwd: string; message?: string }; data: Resolved<typeof engine.stash> };
  "beacon:stashList": { arg: string; data: Resolved<typeof engine.stashList> };
  "beacon:stashPop": { arg: string; data: Resolved<typeof engine.stashPop> };
  "beacon:stashDetail": { arg: { cwd: string; index?: number }; data: Resolved<typeof engine.stashDetail> };
  "beacon:stashRename": { arg: { cwd: string; index?: number; message?: string }; data: Resolved<typeof engine.stashRename> };
  "beacon:dropStash": { arg: { cwd: string; index?: number }; data: Resolved<typeof engine.dropStash> };
  "beacon:workingChanges": { arg: string; data: Resolved<typeof engine.workingChanges> };
  "beacon:discard": { arg: string; data: Resolved<typeof engine.discard> };
  "beacon:revertOutOfScope": { arg: { cwd: string; files?: string[] }; data: Resolved<typeof engine.revertOutOfScope> };
  "beacon:listBranches": { arg: string; data: Resolved<typeof engine.listBranches> };
  "beacon:checkout": { arg: { cwd: string; branch: string }; data: Resolved<typeof engine.checkout> };
  "beacon:deleteBranch": { arg: { cwd: string; branch: string; force?: boolean }; data: Resolved<typeof engine.deleteBranch> };
  "beacon:branchLog": { arg: string; data: Resolved<typeof engine.branchLog> };
  "beacon:fetchRemote": { arg: string; data: Resolved<typeof engine.fetchRemote> };
  "beacon:pull": { arg: string; data: Resolved<typeof engine.pull> };
  "beacon:remoteState": { arg: { cwd: string; fetch?: boolean }; data: Resolved<typeof engine.remoteState> };
  "beacon:listPRs": { arg: { cwd: string; account?: string }; data: Resolved<typeof engine.listPullRequests> };
  "beacon:prDetail": { arg: { cwd: string; number: number; account?: string }; data: Resolved<typeof engine.pullRequestDetail> };
}

export type Channel = keyof Channels;
export type ArgOf<C extends Channel> = Channels[C]["arg"];
export type DataOf<C extends Channel> = Channels[C]["data"];

// Pushed main → renderer (no reply): the open repo changed on disk.
export const CHANGED = "beacon:changed";
