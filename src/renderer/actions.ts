// Everything the UI does, as plain async functions over the store — the same
// flows, in the same order, as the pre-React renderer. Components call these;
// they talk to the engine only through window.beacon.

import type { Result } from "../ipc/contract.ts";
import { prettyBranch } from "./format.ts";
import { isDirty, set, state, type MenuItem, type Pane, type PrDetail, type PrSummary, type Selected } from "./store.ts";

// --- basics -------------------------------------------------------------------

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string) {
  set({ toast: { text, visible: true } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: { text: state.toast.text, visible: false } }), 5000);
}

// Unwrap a bridge reply; failures toast and throw.
export async function call<T>(reply: Promise<Result<T>>): Promise<T> {
  const res = await reply;
  if (!res.ok) { toast(res.error); throw new Error(res.error); }
  return res.data;
}

const api = () => window.beacon;

// --- panes ----------------------------------------------------------------------

function showPane(pane: Pane) {
  set({ pane, paneKey: state.paneKey + 1 });
}

// The default right pane, which doubles as the first-run funnel (see EmptyPane).
export function showEmpty() { showPane({ kind: "empty" }); }

// Immediate feedback while a repo loads (context + branches + PRs + fetch can take a moment).
function showLoading(msg: string) {
  set({ listLoading: msg });
  showPane({ kind: "loading", msg });
}

export function goHome() { set({ selected: null }); showEmpty(); }

// --- loaders ----------------------------------------------------------------------

async function loadPRs() {
  const r = await call(api().listPRs(state.cwd!, ""));
  set({ prsAvailable: r.available, prs: (r.prs || []) as PrSummary[] });
}
async function loadStashes() {
  const list = await call(api().stashList(state.cwd!));
  set({ stashes: list.map((l) => { const m = l.match(/^stash@\{(\d+)\}:\s*(.*)$/); return { index: m ? Number(m[1]) : 0, label: m ? m[2]! : l }; }) });
}
async function loadWorking() { const w = await call(api().workingChanges(state.cwd!)); set({ working: w.files || [] }); }
async function loadBranches() { const r = await call(api().listBranches(state.cwd!)); set({ branches: r.branches || [] }); }
async function loadSync(fetch = false) {
  try { set({ sync: await call(api().remoteState(state.cwd!, fetch)) }); }
  catch { set({ sync: { behind: 0, ahead: 0, upstream: null } }); }
}
export async function loadGh() { try { set({ gh: await call(api().ghStatus()) }); } catch {} }

// Reload everything derived from the repo (after any tree-changing action).
// Recomputes ahead/behind from existing refs (no network fetch).
export async function reloadRepoState() {
  set({ ctx: await call(api().context(state.cwd!)) });
  await Promise.all([loadWorking().catch(() => {}), loadStashes().catch(() => {}), loadPRs().catch(() => {}), loadBranches().catch(() => {}), loadSync(false).catch(() => {})]);
}

export async function loadContext(cwd: string) {
  set({ cwd, selected: null, skipSync: false });
  showLoading(`Opening ${cwd.split("/").pop()}…`);
  set({ ctx: await call(api().context(cwd)) });
  // On open, fetch once so the "pull first" gate reflects the real remote.
  await Promise.all([loadPRs().catch(() => {}), loadStashes().catch(() => {}), loadWorking().catch(() => {}), loadBranches().catch(() => {}), loadGh().catch(() => {}), loadSync(true).catch(() => {})]);
  set({ listLoading: null, ghShown: true });
  showEmpty();
  // Watch the repo so the UI tracks the agent's writes as they happen.
  api().watch(cwd).catch(() => {});
}

// The repo button opens the OS folder picker directly.
export async function openRepo() { const dir = await call(api().pickFolder()); if (dir) await loadContext(dir); }

// --- selection --------------------------------------------------------------------

// The branch activity view — the main working surface.
export async function selectBranch(name: string, sel?: Selected) {
  const token = sel || { type: "branch" as const, branch: name };
  set({ selected: token });
  showPane({ kind: "branch-loading" });
  let log: Extract<Pane, { kind: "branch" }>["log"] = { commits: [] };
  let rv: Extract<Pane, { kind: "branch" }>["rv"] = null;
  await loadWorking().catch(() => {});
  try { log = await call(api().branchLog(state.cwd!)); } catch {}
  try { rv = await call(api().review(state.cwd!)); } catch {}
  if (state.selected !== token) return; // user navigated away while loading
  showPane({ kind: "branch", name, log, rv });
}

// The Working tree row → the current branch's activity view, with the Working
// tree row kept highlighted.
export function selectWorking() { if (state.ctx && state.ctx.isRepo) selectBranch(state.ctx.branch!, { type: "working" }); }

// Switch to a branch and land in the right place: the default branch is the
// "working tree" (home / empty state); a feature branch opens its activity view.
// Guarded against a dirty tree by the engine.
export async function switchBranch(name: string) {
  if (!name) return;
  const land = () => (name === state.ctx!.defaultBranch ? goHome() : selectBranch(name));
  if (state.ctx && state.ctx.branch === name) { land(); return; }
  try {
    await call(api().checkout(state.cwd!, name));
    toast(`Switched to ${name}`);
    await reloadRepoState();
    land();
  } catch {}
}

export async function selectPR(number: number) {
  set({ selected: { type: "pr", number } });
  showPane({ kind: "pr-loading", number });
  try {
    const dd = (await call(api().prDetail(state.cwd!, number, ""))) as PrDetail;
    showPane({ kind: "pr", dd });
  } catch {}
}

export async function selectStash(index: number) {
  set({ selected: { type: "stash", index } });
  try {
    const dd = await call(api().stashDetail(state.cwd!, index));
    showPane({ kind: "stash", index, dd, stash: state.stashes.find((x) => x.index === index) });
  } catch {}
}

// "New branch" → clear the selection and surface the creation form.
export function startNewChange() { if (state.ctx && state.ctx.isRepo) goHome(); }

// Create the branch from the inline form, then open its activity view.
export async function startBranch(name: string) {
  if (!name || !name.trim()) return;
  if (!(state.ctx && state.ctx.isRepo)) return;
  if (isDirty()) { toast("Save or set aside your current changes first"); selectWorking(); return; }
  try {
    const r = await call(api().start(state.cwd!, name.trim()));
    toast(`Started ${r.branch} · front-end scope declared${r.committed ? " (first commit)" : ""}`);
    await reloadRepoState();
    selectBranch(r.branch);
  } catch {}
}

// Reload repo state and re-open the current branch view (if one is showing).
export async function refreshView() {
  await reloadRepoState();
  const s = state.selected;
  if (s && s.type === "branch") selectBranch(s.branch);
}

// --- dialogs ----------------------------------------------------------------------

function openModal(kind: "prompt" | "confirm", title: string, ok: string, initial = ""): Promise<any> {
  return new Promise((resolve) => {
    set({ modal: { open: true, seq: state.modal.seq + 1, kind, title, ok, initial, resolve } });
  });
}
export function closeModal(value: unknown) {
  const { resolve } = state.modal;
  set({ modal: { ...state.modal, open: false, resolve: null } });
  resolve?.(value);
}

// Inline name/rename dialog (Electron blocks window.prompt). Resolves to the
// trimmed value, or null if cancelled.
export const promptName = ({ title, initial = "", ok = "Save" }: { title: string; initial?: string; ok?: string }): Promise<string | null> =>
  openModal("prompt", title, ok, initial);

// A yes/no confirmation, reusing the same dialog with its text input hidden.
export const confirmDialog = ({ title, ok = "Delete" }: { title: string; ok?: string }): Promise<boolean> =>
  openModal("confirm", title, ok);

// Stash with a required name. Returns true if it happened.
export async function doStash() {
  const name = await promptName({ title: "Name this stash", ok: "Stash", initial: "" });
  if (name == null) return false;
  await call(api().stash(state.cwd!, name));
  toast(`Stashed: ${name}`);
  return true;
}

export async function confirmDeleteBranch(name: string) {
  const pretty = prettyBranch(name);
  if (!(await confirmDialog({ title: `Delete branch “${pretty}”?` }))) return;
  // Safe delete first; if git reports unmerged commits, confirm again to force.
  let res = await api().deleteBranch(state.cwd!, name, false);
  if (!res.ok && /unmerged/i.test(res.error || "")) {
    if (!(await confirmDialog({ title: `“${pretty}” has commits not merged anywhere. Delete anyway?`, ok: "Delete anyway" }))) return;
    res = await api().deleteBranch(state.cwd!, name, true);
  }
  if (!res.ok) { toast(res.error); return; }
  toast(`Deleted “${pretty}”`);
  await reloadRepoState(); goHome();
}

export async function confirmDropStash(index: number) {
  if (!(await confirmDialog({ title: "Delete this stash? This can’t be undone." }))) return;
  try { await call(api().dropStash(state.cwd!, index)); toast("Stash deleted"); await reloadRepoState(); goHome(); } catch {}
}

export function openShip() {
  const title = state.ctx && state.ctx.branch ? `Create pull request · ${state.ctx.branch}` : "Create pull request";
  set({ ship: { seq: state.ship.seq + 1, open: true, title } });
}
export function closeShip() { set({ ship: { ...state.ship, open: false } }); }

// --- menus ------------------------------------------------------------------------

export function closeMenu() { if (state.menu) set({ menu: null }); }

export function openMenu(anchorId: string, items: MenuItem[]) {
  const m = state.menu;
  if (m && m.kind === "anchored" && m.anchorId === anchorId) { closeMenu(); return; } // toggle off
  set({ menu: { kind: "anchored", anchorId, items } });
}

export function openMenuAt(x: number, y: number, items: MenuItem[]) {
  set({ menu: { kind: "at", x, y, items } });
}

export function branchMenu() {
  if (!(state.ctx && state.ctx.isRepo)) return;
  const cur = state.ctx.branch;
  const items: MenuItem[] = state.branches.map((b) => ({
    icon: "branch",
    label: b.isDefault ? `Working tree (${b.name})` : b.name,
    checked: b.name === cur,
    onClick: () => switchBranch(b.name),
  }));
  items.push({ separator: true });
  items.push({ icon: "plus", label: "New branch…", onClick: startNewChange });
  openMenu("branch-btn", items);
}

// Right-click a branch or stash row → delete it (with confirmation).
export function rowContextMenu(e: { target: EventTarget | null; clientX: number; clientY: number; preventDefault(): void }) {
  const li = (e.target as Element | null)?.closest?.(".row-item") as HTMLElement | null;
  if (!li) return;
  const { type, id } = li.dataset;
  let items: MenuItem[] | null = null;
  if (type === "branch") {
    const b = state.branches.find((x) => x.name === id);
    if (!b || b.current || b.isDefault) return; // never the current or default branch
    items = [{ label: "Delete branch", icon: "trash", danger: true, onClick: () => confirmDeleteBranch(id!) }];
  } else if (type === "stash") {
    items = [{ label: "Delete stash", icon: "trash", danger: true, onClick: () => confirmDropStash(Number(id)) }];
  }
  if (!items) return;
  e.preventDefault();
  openMenuAt(e.clientX, e.clientY, items);
}

// --- GitHub connection (onboarding) -----------------------------------------------

let ghPoll: ReturnType<typeof setInterval> | null = null;

function ghChipTitle() {
  const g = state.gh;
  if (!g.installed) return "Install the GitHub CLI (gh) to open pull requests";
  if (!g.authed) return "Sign in to GitHub to open pull requests";
  return `Connected to GitHub${g.login ? " as @" + g.login : ""}`;
}

// Account menu on the connected chip — switch, add, or re-check.
export function ghMenu() {
  const g = state.gh;
  openMenu("gh-status", [
    { header: true, label: g.login ? `Connected as @${g.login}` : "Connected to GitHub" },
    { icon: "caret-up-down", label: "Switch account", onClick: switchGhAccount },
    { icon: "pull-request", label: "Add another account", onClick: connectGh },
    { separator: true },
    { icon: "refresh", label: "Re-check", onClick: recheckGh },
  ]);
}

// Wait for the Terminal flow: show a pending chip and poll until `done`.
function pollGh(label: string, done: () => boolean) {
  set({ ghPending: { label, title: ghChipTitle() } });
  if (ghPoll) clearInterval(ghPoll);
  let tries = 0;
  ghPoll = setInterval(async () => {
    tries++;
    await loadGh();
    if (done()) { clearInterval(ghPoll!); ghPoll = null; onGhConnected(); }
    else if (tries >= 40) { clearInterval(ghPoll!); ghPoll = null; set({ ghPending: null }); } // give up after ~2 min
  }, 3000);
}

// `gh auth switch` in Terminal, then poll until the active login changes.
export async function switchGhAccount() {
  const prev = state.gh && state.gh.login;
  try { await call(api().ghAuthSwitch()); } catch { return; }
  toast("Pick an account in the Terminal window — it'll update here.");
  pollGh("Switching…", () => !!state.gh.login && state.gh.login !== prev);
}

// Launch `gh auth login` in Terminal, then poll until the user finishes.
export async function connectGh() {
  if (state.gh && !state.gh.installed) { api().openExternal("https://cli.github.com"); return; }
  try { await call(api().ghAuthLogin()); } catch { return; }
  toast("Complete GitHub sign-in in the Terminal window that opened.");
  pollGh("Waiting for sign-in…", () => state.gh.authed);
}

export async function recheckGh() {
  if (ghPoll) clearInterval(ghPoll);
  ghPoll = null;
  await loadGh();
  if (state.gh.authed) onGhConnected(); else set({ ghPending: null });
}

async function onGhConnected() {
  set({ ghPending: null });
  toast(`Connected to GitHub${state.gh.login ? ` as @${state.gh.login}` : ""}`);
  if (state.cwd) { await loadPRs().catch(() => {}); }
  // Advance the onboarding funnel (Connect GitHub → Select repository) if we're
  // sitting on the default pane.
  if (state.selected === null) showEmpty();
}

// --- list ---------------------------------------------------------------------------

export function toggleGroup(key: string) {
  if (state.collapsed.has(key)) state.collapsed.delete(key); else state.collapsed.add(key);
  set();
}

export function setTab(tab: "branches" | "prs") {
  if (state.tab === tab) return;
  set({ tab });
}

// --- live updates -------------------------------------------------------------------
// The main process watches the open repo and pings here whenever files (or
// guard flags, commits, branch switches) change. Refresh whatever is showing —
// no save, no commit, no manual refresh needed. The save-message input is
// preserved so a live update never eats what the user is typing.

let liveTimer: ReturnType<typeof setTimeout> | undefined;
function onRepoChanged() {
  if (!state.cwd) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    const msgEl = document.getElementById("ab-msg") as HTMLInputElement | null;
    const keep = msgEl ? { value: msgEl.value, focused: document.activeElement === msgEl } : null;
    try {
      await reloadRepoState();
      const s = state.selected;
      if (s && (s.type === "branch" || s.type === "working")) {
        await selectBranch(s.type === "branch" ? s.branch : state.ctx!.branch!, s);
        const el = document.getElementById("ab-msg") as HTMLInputElement | null;
        if (el && keep && keep.value && !el.value) el.value = keep.value;
        if (el && keep && keep.focused) el.focus();
      } else if (s === null) {
        showEmpty();
      }
    } catch { /* transient git state (mid-operation) — the next ping catches up */ }
  }, 250);
}

// --- init ---------------------------------------------------------------------------

export async function init() {
  api().onChanged(onRepoChanged);
  try { set({ agents: await call(api().detectAgents()) }); } catch {}
  await loadGh().catch(() => {});
  set({ ghShown: true });
  showEmpty();
}
