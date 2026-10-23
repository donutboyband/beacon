// Beacon — Electron main process (built to out/main.mjs).
// Owns the engine and the OS-level capabilities (file dialog, shell). The
// renderer never touches Node directly; it calls these handlers over IPC,
// each typed by src/ipc/contract.ts.

import { app, BrowserWindow, ipcMain, dialog, shell, Menu, type IpcMainInvokeEvent, type WebContents } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import * as beacon from "../engine/index.ts";
import { run } from "../engine/process.ts";
import { CHANGED, type ArgOf, type Channel, type DataOf, type Result } from "../ipc/contract.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Name the app so the macOS menu bar reads "Beacon" (not "Electron") in dev too.
// Must run before app is ready / any menu is built.
app.setName("Beacon");

// A Finder-launched app inherits a minimal PATH (no Homebrew), so tools like
// `gh` (and a Homebrew `git`) wouldn't resolve. Add the usual install dirs so
// everything the engine shells out to is found whether launched from Finder or a shell.
{
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${process.env.HOME}/.local/bin`];
  const parts = (process.env.PATH || "").split(":").filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  process.env.PATH = parts.join(":");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1b1a18",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(join(ROOT, "src", "renderer", "index.html"));
  return win;
}

// Resolve the gh token for a named account (empty = active account). This is
// how the UI pins PRs to a specific GitHub identity (e.g. oneseventy170).
async function resolveAccount(account?: string) {
  let token: string | undefined;
  if (account && account.trim()) {
    const r = await run("gh", ["auth", "token", "--user", account.trim()]);
    if (r.code === 0) token = r.stdout;
  }
  const identity = await beacon.ghIdentity(token); // whichever login the token maps to
  return { token, identity };
}

const onPath = async (cmd: string) => (await run("which", [cmd])).code === 0;

// Which AI coding agents are installed, so the UI only offers real ones.
async function detectAgents() {
  return {
    cursor: existsSync("/Applications/Cursor.app") || (await onPath("cursor")),
    claude: await onPath("claude"),
  };
}

// Open the repo folder in an AI coding agent.
function openIn({ app: which, cwd }: ArgOf<"beacon:openIn">) {
  if (/["']/.test(cwd)) throw new Error("repo path contains quotes; open it manually");
  if (which === "cursor") {
    if (existsSync("/Applications/Cursor.app")) spawn("open", ["-a", "Cursor", cwd], { detached: true, stdio: "ignore" }).unref();
    else spawn("cursor", [cwd], { detached: true, stdio: "ignore" }).unref();
    return { launched: "cursor" };
  }
  if (which === "claude") {
    // Open Terminal in the repo and start Claude Code.
    const osa = `tell application "Terminal"\n  do script "cd '${cwd}' && claude"\n  activate\nend tell`;
    spawn("osascript", ["-e", osa], { detached: true, stdio: "ignore" }).unref();
    return { launched: "claude" };
  }
  throw new Error(`unknown agent: ${which}`);
}

// Open the user's Terminal running `gh auth login` (browser flow). The sign-in
// happens entirely in gh / the browser — Beacon never touches the credentials.
function ghTerminal(cmd: string) {
  const osa = `tell application "Terminal"\n  do script "${cmd}"\n  activate\nend tell`;
  spawn("osascript", ["-e", osa], { detached: true, stdio: "ignore" }).unref();
  return { launched: true as const };
}

// --- live repo watching -------------------------------------------------
// Watch the open repo so the UI updates AS the agent works — no commit, no
// manual refresh. Changes inside .git are ignored except the ones that mean
// something happened: a new guard flag, a commit, or a branch switch. Events
// are debounced into a single "beacon:changed" push to the renderer.
let repoWatcher: FSWatcher | null = null;
let watchTimer: ReturnType<typeof setTimeout> | undefined;
function stopWatching() {
  clearTimeout(watchTimer);
  watchTimer = undefined;
  try { repoWatcher && repoWatcher.close(); } catch { /* already closed */ }
  repoWatcher = null;
}
function startWatching(sender: WebContents, cwd: string) {
  stopWatching();
  if (!cwd) return { watching: false };
  repoWatcher = watch(cwd, { recursive: true }, (_event, filename) => {
    const f = String(filename || "").split("\\").join("/");
    if (!f || f.includes("node_modules/") || f.endsWith(".DS_Store")) return;
    if (f.startsWith(".git/")) {
      const meaningful = f.startsWith(".git/beacon/") || f === ".git/HEAD" || f.startsWith(".git/refs/");
      if (!meaningful) return;
    }
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      if (!sender.isDestroyed()) sender.send(CHANGED);
    }, 400);
  });
  return { watching: true };
}

// --- engine queue ---------------------------------------------------------
// Engine calls run one at a time, in arrival order — the ordering they had
// when every call blocked the main process — so two git commands never race
// for the index lock (the renderer fires several loads at once). The
// difference: the main process stays responsive while they run.
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = tail.then(fn);
  tail = result.catch(() => {});
  return result;
}

type Handler<C extends Channel> = (arg: ArgOf<C>, event: IpcMainInvokeEvent) => DataOf<C> | Promise<DataOf<C>>;

// Engine-backed handlers go through the queue; OS/UI ones answer directly.
const queued = <C extends Channel>(fn: Handler<C>): Handler<C> => (arg, event) => serial(() => fn(arg, event));

// Every channel in the contract must have a handler — a missing one is a
// type error here.
const handlers: { [C in Channel]: Handler<C> } = {
  "beacon:pickFolder": async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  "beacon:watch": (cwd, e) => startWatching(e.sender, cwd),
  "beacon:openExternal": (url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return true;
  },
  "beacon:detectAgents": () => detectAgents(),
  "beacon:openIn": (arg) => openIn(arg),

  "beacon:ghStatus": () => beacon.ghStatus(),
  "beacon:ghAuthLogin": () => ghTerminal("gh auth login --web --git-protocol https --hostname github.com"),
  "beacon:ghAuthSwitch": () => ghTerminal("gh auth switch"),
  "beacon:resolveAccount": (account) => resolveAccount(account),

  "beacon:context": queued((cwd) => beacon.getContext(cwd)),
  "beacon:start": queued(({ cwd, name }) => beacon.start({ cwd, name })),
  "beacon:status": queued((cwd) => beacon.status({ cwd })),
  "beacon:review": queued((cwd) => beacon.review({ cwd })),
  "beacon:plan": queued(({ cwd }) =>
    beacon.plan({ cwd, anthropicKey: process.env.ANTHROPIC_API_KEY, model: process.env.BEACON_MODEL })),
  "beacon:ship": queued(async ({ cwd, dryRun, title, account, allowFlagged }) => {
    const { token } = await resolveAccount(account);
    return beacon.ship({
      cwd,
      dryRun,
      title,
      allowFlagged,
      githubToken: token,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.BEACON_MODEL,
    });
  }),
  "beacon:commit": queued(({ cwd, message, allowFlagged, files }) => beacon.commit({ cwd, message, allowFlagged, files })),
  "beacon:stash": queued(({ cwd, message }) => beacon.stash({ cwd, message })),
  "beacon:stashList": queued((cwd) => beacon.stashList({ cwd })),
  "beacon:stashPop": queued((cwd) => beacon.stashPop({ cwd })),
  "beacon:stashDetail": queued(({ cwd, index }) => beacon.stashDetail({ cwd, index })),
  "beacon:stashRename": queued(({ cwd, index, message }) => beacon.stashRename({ cwd, index, message })),
  "beacon:dropStash": queued(({ cwd, index }) => beacon.dropStash({ cwd, index })),
  "beacon:workingChanges": queued((cwd) => beacon.workingChanges({ cwd })),
  "beacon:discard": queued((cwd) => beacon.discard({ cwd })),
  "beacon:revertOutOfScope": queued(({ cwd, files }) => beacon.revertOutOfScope({ cwd, files })),
  "beacon:listBranches": queued((cwd) => beacon.listBranches({ cwd })),
  "beacon:checkout": queued(({ cwd, branch }) => beacon.checkout({ cwd, branch })),
  "beacon:deleteBranch": queued(({ cwd, branch, force }) => beacon.deleteBranch({ cwd, branch, force })),
  "beacon:branchLog": queued((cwd) => beacon.branchLog({ cwd })),
  "beacon:fetchRemote": queued((cwd) => beacon.fetchRemote({ cwd })),
  "beacon:pull": queued((cwd) => beacon.pull({ cwd })),
  "beacon:remoteState": queued(({ cwd, fetch }) => beacon.remoteState({ cwd, fetch })),
  "beacon:listPRs": queued(async ({ cwd, account }) => {
    const { token } = await resolveAccount(account);
    return beacon.listPullRequests({ cwd, token });
  }),
  "beacon:prDetail": queued(async ({ cwd, number, account }) => {
    const { token } = await resolveAccount(account);
    return beacon.pullRequestDetail({ cwd, number, token });
  }),
};

// Register a handler so the renderer always gets {ok, data|error}.
function register<C extends Channel>(channel: C, fn: Handler<C>) {
  ipcMain.handle(channel, async (event, arg: ArgOf<C>): Promise<Result<DataOf<C>>> => {
    try {
      return { ok: true, data: await fn(arg, event) };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });
}

app.whenReady().then(() => {
  // Dev dock icon (packaged builds use the bundle icon from build config).
  if (process.platform === "darwin" && app.dock) {
    try { app.dock.setIcon(join(ROOT, "icons", "lighthouse-glass-512.png")); } catch { /* not present in packaged app */ }
  }

  for (const channel of Object.keys(handlers) as Channel[]) register(channel, handlers[channel] as Handler<typeof channel>);

  // Standard macOS menu; the app menu (bold first item) uses app.name → "Beacon".
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
  }

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
