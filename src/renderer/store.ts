// App state: one mutable object, as before the React port, plus a change
// signal. set() re-renders synchronously (flushSync), so the DOM is current as
// soon as it returns — the same moment the old render*() calls updated it.

import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { DataOf } from "../ipc/contract.ts";

export type Ctx = DataOf<"beacon:context">;
export type Review = DataOf<"beacon:review">;
export type BranchLog = DataOf<"beacon:branchLog">;
export type WorkingFile = DataOf<"beacon:workingChanges">["files"][number];
export type Branch = DataOf<"beacon:listBranches">["branches"][number];
export type GhStatus = DataOf<"beacon:ghStatus">;
export type Sync = DataOf<"beacon:remoteState">;

export interface PrSummary {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  updatedAt?: string;
  isDraft?: boolean;
}

export interface PrDetail {
  number: number;
  title: string;
  headRefName: string;
  body?: string;
  url: string;
  mergedAt?: string | null;
  author?: { login?: string; name?: string };
  commits?: { oid: string; message: string; author: string; date: string | null }[];
  files?: { path: string; additions: number; deletions: number }[];
}

export interface Stash { index: number; label: string }

// What's selected on the left: null = nothing (the empty/home pane).
export type Selected =
  | { type: "branch"; branch: string }
  | { type: "working" }
  | { type: "pr"; number: number }
  | { type: "stash"; index: number };

// The right pane. "none" is before the app has initialised (both hidden).
export type Pane =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "loading"; msg: string }
  | { kind: "branch-loading" }
  | { kind: "branch"; name: string; log: BranchLog | { commits: [] }; rv: Review | null }
  | { kind: "pr-loading"; number: number }
  | { kind: "pr"; dd: PrDetail }
  | { kind: "stash"; index: number; dd: DataOf<"beacon:stashDetail">; stash: Stash | undefined };

export interface MenuItem {
  label?: string;
  icon?: string;
  checked?: boolean;
  danger?: boolean;
  header?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

// Anchored to a button (toggles), or at the cursor (right-click).
export type Menu =
  | { kind: "anchored"; anchorId: string; items: MenuItem[] }
  | { kind: "at"; x: number; y: number; items: MenuItem[] };

// The shared name/confirm dialog.
export interface Modal {
  open: boolean;
  seq: number;
  kind: "prompt" | "confirm";
  title: string;
  ok: string;
  initial: string;
  resolve: ((v: any) => void) | null;
}

export interface State {
  cwd: string | null;
  ctx: Ctx | null;
  agents: { cursor: boolean; claude: boolean };
  selected: Selected | null;
  prs: PrSummary[];
  prsAvailable: boolean;
  stashes: Stash[];
  working: WorkingFile[];
  branches: Branch[];
  gh: GhStatus;
  ghShown: boolean; // the chip stays empty (and hidden) until first rendered
  ghPending: { label: string; title: string } | null; // waiting on Terminal sign-in/switch
  sync: Sync;
  skipSync: boolean; // set when the user dismisses the "pull first" onboarding step
  query: string;
  searchOpen: boolean;
  tab: "branches" | "prs";
  collapsed: Set<string>; // collapsed group keys (secondary groups start closed)
  listLoading: string | null; // "Opening …" in the list while a repo loads
  pane: Pane;
  paneKey: number; // bumped whenever the pane is re-shown — remounts it, like innerHTML did
  menu: Menu | null;
  modal: Modal;
  ship: { seq: number; open: boolean; title: string };
  toast: { text: string; visible: boolean };
}

export const state: State = {
  cwd: null, ctx: null, agents: { cursor: false, claude: false },
  selected: null,
  prs: [], prsAvailable: true, stashes: [], working: [], branches: [],
  gh: { installed: false, authed: false, login: null },
  ghShown: false,
  ghPending: null,
  sync: { behind: 0, ahead: 0, upstream: null },
  skipSync: false,
  query: "", searchOpen: false,
  tab: "branches",
  collapsed: new Set(["deleted", "stashes"]),
  listLoading: null,
  pane: { kind: "none" },
  paneKey: 0,
  menu: null,
  modal: { open: false, seq: 0, kind: "prompt", title: "Name this stash", ok: "Save", initial: "", resolve: null },
  ship: { seq: 0, open: false, title: "Create pull request" },
  toast: { text: "", visible: false },
};

const listeners = new Set<() => void>();
let version = 0;

export function set(patch: Partial<State> = {}): void {
  Object.assign(state, patch);
  version++;
  flushSync(() => { for (const l of listeners) l(); });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => version;

export function useStore(): State {
  useSyncExternalStore(subscribe, snapshot);
  return state;
}

export const isDirty = () => state.working.length > 0;
