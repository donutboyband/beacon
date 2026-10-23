// Smoke-test the real app: launch Electron on a throwaway fixture repo, drive
// window.beacon from inside the renderer over the Chrome DevTools Protocol —
// through the actual preload, contextBridge, IPC handlers, and engine queue —
// then open the repo in the UI and save a screenshot. A window appears briefly.
//
//   bun run build && bun scripts/smoke-app.ts [screenshot.png]

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { click, launchApp, waitFor } from "./lib/app.ts";
// @ts-ignore — plain-JS test helpers: hermetic git env, fake gh on PATH, fixtures
import { cleanupRepos } from "../test/support/repo.js";
// @ts-ignore
import { flaggedBranch } from "../test/support/scenario.js";

const ROOT = join(import.meta.dir, "..");
const shot = process.argv[2] || join(ROOT, "out", "smoke.png");

const repo = await flaggedBranch();
const app = await launchApp();
const ws = app.page;
const evaluate = (_ws: unknown, expression: string) => ws.evaluate(expression);
const cdp = (_ws: unknown, method: string, params: object = {}) => ws.send(method, params);

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => checks.push([name, ok, detail]);

try {
  const cwd = JSON.stringify(repo.cwd);

  // 1. Each bridge method answers through the real IPC path.
  const r = await evaluate(ws, `(async () => {
    const b = window.beacon, cwd = ${cwd};
    return {
      api: Object.keys(b).sort(),
      context: await b.context(cwd),
      review: await b.review(cwd),
      working: await b.workingChanges(cwd),
      branches: await b.listBranches(cwd),
      stashes: await b.stashList(cwd),
      sync: await b.remoteState(cwd, false),
      log: await b.branchLog(cwd),
      gh: await b.ghStatus(),
      dry: await b.ship({ cwd, dryRun: true }),
      notRepo: await b.status("/"),
      leaked: typeof window.require + "/" + typeof window.process,
    };
  })()`);
  check("bridge exposes the 35 methods", r.api.length === 35, String(r.api.length));
  check("context", r.context.ok && r.context.data.isRepo && r.context.data.branch === "polish-pricing");
  check("review finds the 4 flagged files", r.review.ok && r.review.data.flagged.length === 4);
  check("working changes", r.working.ok && r.working.data.files.length === 5, String(r.working.data?.files?.length));
  check("branches", r.branches.ok && r.branches.data.current === "polish-pricing");
  check("stash list", r.stashes.ok && Array.isArray(r.stashes.data));
  check("remote state", r.sync.ok && "ahead" in r.sync.data);
  check("branch log", r.log.ok && r.log.data.count === 3, String(r.log.data?.count));
  check("gh status (fake gh)", r.gh.ok && r.gh.data.login === "test-user");
  check("ship dry run", r.dry.ok && r.dry.data.annotation.source === "deterministic" && r.dry.data.flagged.length === 4);
  check("errors come back as {ok:false}", r.notRepo.ok === false && r.notRepo.error === "not a git repository", JSON.stringify(r.notRepo));
  check("no Node in the page", r.leaked === "undefined/undefined", r.leaked);

  // 2. A burst of concurrent calls plus a save, as the renderer fires them —
  // the queue must keep git from racing for the index lock.
  const burst = await evaluate(ws, `(async () => {
    const b = window.beacon, cwd = ${cwd};
    const loads = () => [b.context(cwd), b.workingChanges(cwd), b.stashList(cwd), b.listBranches(cwd), b.remoteState(cwd, false), b.review(cwd)];
    const all = await Promise.all([...loads(), b.commit(cwd, "smoke save", true), ...loads(), b.stash(cwd, "smoke"), ...loads()]);
    return all.map((x) => x.ok ? "ok" : x.error);
  })()`);
  const failures = burst.filter((x: string) => x !== "ok");
  check("20 concurrent calls incl. commit + stash", failures.length === 0, failures.join(" | "));

  // 3. While a slow engine call is queued, the main process still answers
  // directly-handled channels.
  const timing = await evaluate(ws, `(async () => {
    const b = window.beacon, cwd = ${cwd};
    const t0 = performance.now();
    const slow = Promise.all(Array.from({ length: 8 }, () => b.review(cwd)));
    const fast = await b.detectAgents();
    const tFast = performance.now() - t0;
    await slow;
    return { tFast, tSlow: performance.now() - t0, ok: fast.ok };
  })()`);
  check("main stays responsive during queued work", timing.ok && timing.tFast < timing.tSlow / 2,
    `detectAgents ${timing.tFast.toFixed(0)}ms vs 8 reviews ${timing.tSlow.toFixed(0)}ms`);

  // 4. Open the repo in the UI, as a user would, and capture it.
  await app.pickFolder(repo.cwd);
  await click(ws, "#repo-btn");
  // (the burst above saved and stashed everything, so open the branch itself)
  await waitFor(ws, `document.querySelector('.row-item[data-id="polish-pricing"]')`, "repo to open");
  await click(ws, `.row-item[data-id="polish-pricing"]`);
  await waitFor(ws, `document.querySelector(".action-bar")`, "branch view");
  await Bun.sleep(1200);
  const { data } = await cdp(ws, "Page.captureScreenshot", { format: "png" });
  writeFileSync(shot, Buffer.from(data, "base64"));
  const text = await evaluate(ws, `document.body.innerText`);
  check("UI renders the repo", String(text).includes("polish") || String(text).includes("Polish"));
} finally {
  app.close();
  cleanupRepos();
}

for (const [name, ok, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
console.log(`screenshot: ${shot}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
