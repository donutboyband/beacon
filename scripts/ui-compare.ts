// Walk the real app through every screen the way a person would (clicks,
// typing, right-clicks — never renderer internals, so it works on any
// renderer) and record each screen as a canonical DOM, the toasts it showed,
// and a screenshot. Record once, then compare another renderer against it.
//
//   bun run build && bun scripts/ui-compare.ts record
//   bun run build && bun scripts/ui-compare.ts compare
//
// DOM + toasts → test/ui-baseline/<screen>.json (committed). Screenshots →
// out/ui-baseline/<screen>.png. Compare writes DOM diffs and image diffs to
// out/ui-compare/.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { click, launchApp, moveMouse, press, typeText, waitFor, type App, type Cdp } from "./lib/app.ts";
// @ts-ignore — plain-JS test helpers: hermetic git env, fake gh on PATH, fixtures
import { cleanupRepos, makeRepo } from "../test/support/repo.js";
// @ts-ignore
import { flaggedBranch } from "../test/support/scenario.js";

const ROOT = join(import.meta.dir, "..");
const BASE_JSON = join(ROOT, "test", "ui-baseline");
const BASE_PNG = join(ROOT, "out", "ui-baseline");
const OUT = join(ROOT, "out", "ui-compare");
const mode = process.argv[2];
if (mode !== "record" && mode !== "compare") {
  console.error("usage: bun scripts/ui-compare.ts record|compare [screen-filter]");
  process.exit(2);
}
const only = process.argv[3];

// --- canonical DOM -------------------------------------------------------------
// Attribute order, class-token order and spacing, inline-style formatting, and
// how text is split into nodes don't matter; everything else does. Whitespace
// between elements counts only where it renders (between inline siblings
// outside flex/grid). Subtrees with display:none keep their element but drop
// their contents. Shas are masked (the scope commit embeds a timestamp).
const SERIALIZE = `(() => {
  const mask = (s) => s.replace(/\\b[0-9a-f]{40}\\b/g, "<sha>").replace(/\\b[0-9a-f]{7}\\b/g, "<sha7>");
  const isInline = (n) => n && n.nodeType === 1 && getComputedStyle(n).display.startsWith("inline");
  const out = [];
  const walk = (el, depth) => {
    const pad = "  ".repeat(depth);
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || el.id === "__cap") return;
    const attrs = [...el.attributes].map((a) => {
      let v = a.value;
      if (a.name === "class") v = [...new Set(v.split(/\\s+/).filter(Boolean))].sort().join(" ");
      else if (a.name === "style") v = el.style.cssText;
      else v = mask(v);
      return [a.name, v];
    }).filter(([n, v]) => !(n === "class" && !v)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, v]) => n + "=" + JSON.stringify(v));
    if (tag === "input") attrs.push(".value=" + JSON.stringify(el.value));
    if (document.activeElement === el && el !== document.body) attrs.push(".focused");
    const cs = getComputedStyle(el);
    const hidden = cs.display === "none";
    if (hidden) attrs.push(".display-none");
    out.push(pad + "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">");
    if (hidden) return;
    const flexy = /flex|grid/.test(cs.display);
    let text = "";
    const flush = (prev, next) => {
      if (!text) return;
      let t = text.replace(/\\s+/g, " ");
      if (!t.trim() && (flexy || !isInline(prev) || !isInline(next))) t = "";
      if (t) out.push(pad + "  " + JSON.stringify(mask(t)));
      text = "";
    };
    let prevEl = null;
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { text += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      flush(prevEl, c);
      walk(c, depth + 1);
      prevEl = c;
    }
    flush(prevEl, null);
  };
  walk(document.body, 0);
  return out.join("\\n");
})()`;

// Every toast the app shows, in order (they vanish after 5s, so screenshots
// can't be trusted to catch them).
const WATCH_TOASTS = `(() => {
  if (window.__toasts) return;
  window.__toasts = [];
  let shown = null; // the toast currently on screen, logged once per showing
  new MutationObserver(() => {
    const t = document.getElementById("toast");
    const s = t && !t.classList.contains("hidden") ? t.textContent : null;
    if (s !== null && s !== shown) window.__toasts.push(s);
    shown = s;
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
})()`;

// For the screenshot only: stop animations and the caret, hide the toast
// (timing-dependent), and mask shas so the pixels are reproducible.
const FREEZE = `(() => {
  const s = document.createElement("style");
  s.id = "__cap";
  s.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } #toast { visibility: hidden !important; }";
  document.head.appendChild(s);
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) if (/\\b[0-9a-f]{7}\\b/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/\\b[0-9a-f]{7}\\b/g, "0000000");
})()`;

// Settled = no spinner showing and the DOM unchanged for a second (the repo
// watcher can trigger a refresh a beat after any action).
async function settle(page: Cdp) {
  let last = "";
  let since = Date.now();
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const dom: string = await page.evaluate(SERIALIZE);
    const spinning = /class="[^"]*\bspinner\b/.test(dom);
    if (dom !== last) { last = dom; since = Date.now(); }
    else if (!spinning && Date.now() - since > 1000) return;
    await Bun.sleep(100);
  }
  throw new Error("UI never settled");
}

// Every interaction waits for the UI to settle first, so a live refresh can't
// swap the target out from under the click.
const tap = async (page: Cdp, selector: string, opts?: { button?: "left" | "right" }) => { await settle(page); await click(page, selector, opts); };
const key = async (page: Cdp, k: "Escape" | "Enter") => { await settle(page); await press(page, k); };
const type = async (page: Cdp, text: string) => { await settle(page); await typeText(page, text); };

interface Shot { name: string; dom: string; toasts: string[]; png: Buffer }
const shots: Shot[] = [];

async function capture(app: App, name: string) {
  const { page } = app;
  await moveMouse(page, 600, 3);
  await settle(page);
  const dom: string = await page.evaluate(SERIALIZE);
  const toasts: string[] = await page.evaluate("window.__toasts.splice(0)");
  await page.evaluate(FREEZE);
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await page.evaluate(`document.getElementById("__cap").remove()`);
  shots.push({ name, dom, toasts, png: Buffer.from(data, "base64") });
  console.log(`  · ${name}`);
}

async function session(env: NodeJS.ProcessEnv, run: (app: App) => Promise<void>) {
  const app = await launchApp(env);
  try {
    await app.page.evaluate(WATCH_TOASTS);
    await run(app);
  } finally {
    app.close();
  }
}

// --- fixtures ------------------------------------------------------------------

function ghFixtures(dir: string) {
  const list = join(dir, "prs.json");
  const view = join(dir, "pr.json");
  writeFileSync(list, JSON.stringify([
    { number: 12, title: "Refresh the nav", state: "OPEN", headRefName: "feat/new-nav", author: { login: "ann" }, updatedAt: "2025-11-02T10:00:00Z", url: "https://github.com/test/repo/pull/12", isDraft: false },
    { number: 11, title: "Try a darker footer", state: "OPEN", headRefName: "try/dark-footer", author: { login: "bo" }, updatedAt: "2025-10-20T10:00:00Z", url: "https://github.com/test/repo/pull/11", isDraft: true },
    { number: 9, title: "Pricing page polish", state: "MERGED", headRefName: "pricing-v1", author: { login: "ann" }, updatedAt: "2025-09-01T10:00:00Z", url: "https://github.com/test/repo/pull/9", isDraft: false },
    { number: 7, title: "Old hero experiment", state: "CLOSED", headRefName: "hero-exp", author: { login: "cy" }, updatedAt: "2025-08-01T10:00:00Z", url: "https://github.com/test/repo/pull/7", isDraft: false },
  ]));
  writeFileSync(view, JSON.stringify({
    number: 12, title: "Refresh the nav", state: "OPEN", headRefName: "feat/new-nav", url: "https://github.com/test/repo/pull/12",
    author: { login: "ann" }, createdAt: "2025-11-01T10:00:00Z", mergedAt: null,
    body: "## What changed\n\n- **Nav**: new `NavBar` layout\n  - nested _detail_ item\n- uses `--space-4` & <b>tokens</b>\n\n---\n_Generated by Beacon._",
    commits: [
      { oid: "abcdef1234567", messageHeadline: "Lay out the nav", authors: [{ name: "Ann" }], committedDate: "2025-11-01T10:00:00Z" },
      { oid: "1234567abcdef", messageHeadline: "Polish spacing", authors: [{ login: "ann" }], committedDate: "2025-11-02T10:00:00Z" },
    ],
    files: [{ path: "src/components/NavBar.tsx", additions: 40, deletions: 3 }, { path: "src/styles/nav.css", additions: 12, deletions: 0 }],
  }));
  return { FAKE_GH_PR_LIST: list, FAKE_GH_PR_VIEW: view };
}

// --- screens ---------------------------------------------------------------------

async function busyBranch() {
  const repo = await flaggedBranch();
  repo.write("src/components/Hero.tsx", "export const Hero = () => <h1>Hi</h1>;\n");
  repo.git("stash", "push", "-u", "-m", "hero tweaks", "--", "src/components/Hero.tsx");
  repo.git("branch", "old-idea", "origin/main");
  const env = { ...process.env, ...ghFixtures(repo.tmp) };

  await session(env, async (app) => {
    const { page } = app;
    await capture(app, "01-select-repo");

    await app.pickFolder(repo.cwd);
    await tap(page, "#repo-btn");
    await waitFor(page, `document.querySelector(".row-item")`, "repo rows");
    await capture(app, "02-home-dirty");

    await tap(page, `.row-item[data-type="branch"][data-id="polish-pricing"]`);
    await waitFor(page, `document.querySelector(".action-bar")`, "branch view");
    await capture(app, "03-branch-view");

    await tap(page, `.row-item[data-type="working"]`);
    await capture(app, "04-working-view");

    await tap(page, "#ab-createpr");
    await waitFor(page, `document.querySelector(".preview-body")`, "PR preview");
    await capture(app, "05-ship-preview");
    await tap(page, "#ship-cancel");

    await tap(page, "#branch-btn");
    await capture(app, "06-branch-menu");
    await key(page, "Escape");

    await tap(page, "#gh-status");
    await capture(app, "07-gh-menu");
    await key(page, "Escape");

    await tap(page, `.group-head[data-group="stashes"]`);
    await capture(app, "08-stashes-open");

    await tap(page, `.row-item[data-type="stash"]`);
    await waitFor(page, `document.querySelector("#stash-rename")`, "stash detail");
    await capture(app, "09-stash-detail");

    await tap(page, "#stash-rename");
    await capture(app, "10-rename-prompt");
    await key(page, "Escape");

    await tap(page, `.row-item[data-type="branch"][data-id="old-idea"]`, { button: "right" });
    await capture(app, "11-branch-context-menu");
    await tap(page, ".menu .menu-item");
    await capture(app, "12-confirm-delete");
    await tap(page, "#modal-cancel");

    await tap(page, `.list-tab[data-tab="prs"]`);
    await capture(app, "13-prs-tab");
    await tap(page, `.group-head[data-group="deleted"]`);
    await capture(app, "14-prs-deleted-open");

    await tap(page, `.row-item[data-type="pr"][data-id="12"]`);
    await waitFor(page, `document.querySelector("[data-ext]")`, "PR detail");
    await capture(app, "15-pr-detail");

    await tap(page, `.list-tab[data-tab="branches"]`);
    await tap(page, "#list-search-btn");
    await type(page, "pol");
    await capture(app, "16-search");
    await key(page, "Escape");

    await tap(page, `.row-item[data-type="branch"][data-id="polish-pricing"]`);
    await waitFor(page, `document.querySelector("[data-revert-file]")`, "flagged list");
    await tap(page, `[data-revert-file="src/api/prices.ts"]`);
    await waitFor(page, `window.__toasts.some((t) => t.startsWith("Reverted"))`, "revert to land");
    await capture(app, "17-after-revert-one");

    await tap(page, "#ab-msg");
    await type(page, "Price card styles");
    await tap(page, "#ab-save");
    await waitFor(page, `window.__toasts.some((t) => t.startsWith("Saved"))`, "save to land");
    await capture(app, "18-after-save");

    // Revert from inside the Create PR preview, then open the PR for real.
    await tap(page, "#ab-createpr");
    await waitFor(page, `document.querySelector(".preview-body")`, "PR preview");
    await tap(page, `#ship-preview [data-revert-file="src/auth/session.ts"]`);
    await waitFor(page, `window.__toasts.includes("Reverted src/auth/session.ts") && document.querySelector(".preview-body")`, "preview revert");
    await capture(app, "23-ship-after-revert");
    await tap(page, "#ship-confirm");
    await waitFor(page, `window.__toasts.some((t) => t.startsWith("Pull request created"))`, "PR to open");
    await capture(app, "24-pr-created");

    // A live refresh while the save message is half-typed keeps it (and focus).
    await tap(page, `.row-item[data-type="branch"][data-id="polish-pricing"]`);
    repo.write("src/components/Price.tsx", "export const Price = () => null;\n");
    await waitFor(page, `document.querySelector("#ab-msg") && !document.querySelector("#ab-msg").disabled`, "live refresh");
    await tap(page, "#ab-msg");
    await type(page, "half-typed");
    repo.write("src/styles/price.css", ".price { color: red; }\n");
    await waitFor(page, `document.querySelectorAll("[data-save-file]").length === 2`, "second live refresh");
    await capture(app, "25-live-refresh-keeps-typing");

    // Stash via the action bar, naming it with Enter; then restore it.
    await tap(page, "#ab-stash");
    await type(page, "wip");
    await key(page, "Enter");
    await waitFor(page, `window.__toasts.includes("Stashed: wip")`, "stash");
    await capture(app, "26-stashed");
    await tap(page, `.row-item[data-type="stash"][data-id="0"]`);
    await waitFor(page, `document.querySelector("#stash-restore")`, "stash detail");
    await tap(page, "#stash-restore");
    await waitFor(page, `window.__toasts.includes("Stash restored")`, "restore");
    await capture(app, "27-stash-restored");

    // Delete a branch through the right-click menu and confirmation.
    await tap(page, `.row-item[data-type="branch"][data-id="old-idea"]`, { button: "right" });
    await tap(page, ".menu .menu-item");
    await tap(page, "#modal-ok");
    await waitFor(page, `window.__toasts.some((t) => t.startsWith("Deleted"))`, "delete");
    await capture(app, "28-branch-deleted");

    await tap(page, `.group-head[data-group="inprogress"]`);
    await capture(app, "29-group-collapsed");

    await tap(page, "#fetch-btn");
    await waitFor(page, `window.__toasts.length > 0`, "fetch");
    await capture(app, "30-fetched");
    await tap(page, "#pull-btn");
    await waitFor(page, `window.__toasts.length > 0`, "pull");
    await capture(app, "31-pulled");
  });
}

async function behindRepo() {
  const repo = makeRepo();
  repo.other().commit("upstream work", { "src/upstream.ts": "x\n" }).push();
  await session(process.env, async (app) => {
    const { page } = app;
    await app.pickFolder(repo.cwd);
    await tap(page, "#repo-btn");
    await waitFor(page, `document.querySelector("#ob-pull")`, "update step");
    await capture(app, "19-update-step");

    await tap(page, "#ob-skip");
    await capture(app, "20-create-step");

    await type(page, "fix the footer");
    await tap(page, "#create-start");
    await waitFor(page, `document.querySelector(".action-bar")`, "new branch view");
    await capture(app, "21-new-branch-view");
  });
}

async function signedOut() {
  await session({ ...process.env, FAKE_GH_MODE: "unauthed" }, async (app) => {
    await capture(app, "22-connect-github");
  });
}

// --- run -------------------------------------------------------------------------

try {
  console.log("busy branch");
  await busyBranch();
  console.log("behind repo");
  await behindRepo();
  console.log("signed out");
  await signedOut();
} finally {
  cleanupRepos();
}

const selected = shots.filter((s) => !only || s.name.includes(only));

if (mode === "record") {
  mkdirSync(BASE_JSON, { recursive: true });
  mkdirSync(BASE_PNG, { recursive: true });
  for (const s of selected) {
    writeFileSync(join(BASE_JSON, `${s.name}.json`), JSON.stringify({ toasts: s.toasts, dom: s.dom.split("\n") }, null, 1) + "\n");
    writeFileSync(join(BASE_PNG, `${s.name}.png`), s.png);
  }
  console.log(`recorded ${selected.length} screens`);
} else {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  let failures = 0;
  for (const s of selected) {
    const problems: string[] = [];
    const base = JSON.parse(readFileSync(join(BASE_JSON, `${s.name}.json`), "utf8"));
    const baseDom = base.dom.join("\n");
    if (s.dom !== baseDom) {
      writeFileSync(join(OUT, `${s.name}.base.dom`), baseDom + "\n");
      writeFileSync(join(OUT, `${s.name}.new.dom`), s.dom + "\n");
      const d = spawnSync("diff", ["-u", join(OUT, `${s.name}.base.dom`), join(OUT, `${s.name}.new.dom`)], { encoding: "utf8" }).stdout;
      writeFileSync(join(OUT, `${s.name}.dom.diff`), d);
      problems.push(`DOM differs (${d.split("\n").filter((l) => /^[-+][^-+]/.test(l)).length} lines)`);
    }
    if (JSON.stringify(s.toasts) !== JSON.stringify(base.toasts)) problems.push(`toasts ${JSON.stringify(s.toasts)} vs ${JSON.stringify(base.toasts)}`);

    const basePng = join(BASE_PNG, `${s.name}.png`);
    if (existsSync(basePng)) {
      const a = PNG.sync.read(readFileSync(basePng));
      const b = PNG.sync.read(s.png);
      if (a.width !== b.width || a.height !== b.height) problems.push(`size ${b.width}x${b.height} vs ${a.width}x${a.height}`);
      else {
        const diff = new PNG({ width: a.width, height: a.height });
        const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
        if (n > 0) {
          writeFileSync(join(OUT, `${s.name}.diff.png`), PNG.sync.write(diff));
          writeFileSync(join(OUT, `${s.name}.new.png`), s.png);
          problems.push(`${n} pixels differ`);
        }
      }
    } else problems.push("no baseline screenshot");

    if (problems.length) failures++;
    console.log(`${problems.length ? "✗" : "✓"} ${s.name}${problems.length ? "  — " + problems.join("; ") : ""}`);
  }
  console.log(failures ? `${failures} of ${selected.length} screens differ (details in out/ui-compare/)` : `all ${selected.length} screens identical`);
  process.exit(failures ? 1 : 0);
}
