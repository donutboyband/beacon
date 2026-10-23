#!/usr/bin/env node
// Beacon PreToolUse guard — installed by `beacon start` into <git-dir>/beacon/
// and registered in .claude/settings.local.json. Claude Code pipes every
// Write/Edit/MultiEdit/NotebookEdit call through here before it runs.
//
// Behaviour: ALERT-AND-FLAG, NEVER BLOCK. In-scope writes pass silently.
// Out-of-scope writes are still allowed, but the file is logged to
// flags.jsonl (next to this script) and a warning is surfaced so the change
// can be reviewed — and reverted — before a PR goes out (`beacon review`).
//
// Bundled to a single dependency-free file (out/guard.mjs): it runs via
// `node` in whatever repo it guards. Scope matching is the engine's own.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FLAG_LOG, flagLine } from "./flags.ts";
import { DEFAULT_PROTOTYPE, SCOPE_FILE, matchZone, scopeFrom, scopeReason } from "./scope.ts";

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

function main(): void {
  let call: any;
  try { call = JSON.parse(readFileSync(0, "utf8")); } catch { return; }

  const toolInput = call.tool_input || {};
  const target: string | undefined = toolInput.file_path || toolInput.notebook_path;
  if (!target) return;

  const cwd: string = call.cwd || process.cwd();
  const rootRes = git(cwd, "rev-parse", "--show-toplevel");
  if (rootRes.status !== 0) return;
  const root = rootRes.stdout.trim();

  // No scope declaration → not a Beacon-scoped branch; stay out of the way.
  const scopePath = join(root, SCOPE_FILE);
  if (!existsSync(scopePath)) return;
  let scope: any;
  try { scope = JSON.parse(readFileSync(scopePath, "utf8")); } catch { return; }
  if (scope === null) return;
  // Missing lists mean nothing is allowed or denied — unlike the engine, which
  // falls back to the default lists.
  const cfg = scopeFrom(scope, { allow: [], deny: [], prototype: DEFAULT_PROTOTYPE });

  // The scope is per-branch. After a merge, scope.json can linger on main —
  // if the declared branch isn't the one checked out, the rule doesn't apply.
  const branch = (git(root, "branch", "--show-current").stdout || "").trim();
  if (scope.branch && branch && scope.branch !== branch) return;

  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const file = relative(root, abs).split("\\").join("/");
  if (file.startsWith("..")) return;                              // outside this repo
  if (file === "CLAUDE.md" || file.startsWith(".beacon/")) return; // Beacon's own files

  // The mock zone is expected work; in-scope writes pass silently.
  if (matchZone(file, cfg) !== "out") return;

  const reason = scopeReason(file, cfg);

  // Where the agent should have gone instead: the first prototype glob, as a dir.
  const protoDir = (cfg.prototype[0] || ".beacon/prototype/**").replace(/\/?\*+$/, "/");

  try {
    appendFileSync(join(dirname(fileURLToPath(import.meta.url)), FLAG_LOG),
      flagLine({ ts: new Date().toISOString(), branch, file, tool: call.tool_name || "", reason }));
  } catch { /* logging must never break the write */ }

  // No permissionDecision: the normal permission flow continues untouched.
  // systemMessage surfaces the flag to the HUMAN; additionalContext steers the
  // AGENT toward the prototype zone (ignored gracefully by older Claude Code).
  process.stdout.write(JSON.stringify({
    systemMessage: `⚠ Beacon: ${file} is outside this branch's front-end scope (${reason}). ` +
      `The write went through but was flagged — review it with \`beacon review\` (or the Beacon app) before opening a PR.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `Beacon: ${file} is outside this branch's front-end scope (${reason}). ` +
        `Do not build backend/auth/routing/schema changes on this branch. If the UI needs backend behaviour, ` +
        `prototype in front of it instead: mock the data/service layer under ${protoDir} (same interface the real ` +
        `backend would expose), build the UI from the repo's real components and tokens, render it via a sandbox ` +
        `entry inside ${protoDir}, and document the needed backend work in ${protoDir}README.md.`,
    },
  }));
}

try { main(); } catch { /* a guard failure must never block the agent */ }
process.exit(0);
