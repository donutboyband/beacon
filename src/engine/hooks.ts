// The local Claude Code PreToolUse guard (alert-and-flag, never block), and
// cleanup of the pre-Beacon hook it replaces.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.ts";
import { absoluteGitDir, beaconDir, repoRoot } from "./repo.ts";

// The built guard sits beside the built engine (out/guard.mjs next to
// out/engine.mjs); `start` copies it into each repo it guards.
const GUARD_SOURCE = fileURLToPath(new URL("./guard.mjs", import.meta.url));

// Make sure a repo-local git exclude covers a path (kept out of commits without
// touching the repo's committed .gitignore).
function ensureExcluded(cwd: string | undefined, pattern: string): void {
  const gitDir = absoluteGitDir(cwd);
  if (!gitDir) return;
  const info = join(gitDir, "info");
  mkdirSync(info, { recursive: true });
  const path = join(info, "exclude");
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.split("\n").includes(pattern)) return;
  writeFileSync(path, `${cur.replace(/\n*$/, "\n")}${pattern}\n`);
}

// Remove the pre-Beacon (Devsigner-era) commit-blocking pre-commit guard, if
// this repo still has one. Beacon flags — it never blocks — so the old hook
// would fight the new model. Restores any backed-up original hook.
export function removeLegacyGuard(cwd?: string): { removed: boolean } {
  const r = run("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd });
  if (r.code !== 0 || !r.stdout) return { removed: false };
  const dir = r.stdout;
  const pre = join(dir, "pre-commit");
  if (!existsSync(pre) || !readFileSync(pre, "utf8").includes("devsigner-editable-zone-guard")) return { removed: false };
  const backup = join(dir, "pre-commit.pre-graft");
  if (existsSync(backup)) {
    writeFileSync(pre, readFileSync(backup, "utf8"));
    rmSync(backup, { force: true });
  } else {
    rmSync(pre, { force: true });
  }
  rmSync(join(dir, "devsigner-zone-check.mjs"), { force: true });
  return { removed: true };
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: unknown }[];
}

// Install the PreToolUse guard (idempotent):
//   <git-dir>/beacon/guard.mjs        the checker (flags.jsonl lands beside it)
//   .claude/settings.local.json      registers the hook for Claude Code
// The settings file is added to .git/info/exclude so it never rides along in a
// commit. Returns installed:false (with a reason) rather than throwing, so a
// hook problem never stops a branch from being created.
export function installGuard(cwd?: string): { installed: boolean; guardPath?: string; reason?: string } {
  const root = repoRoot(cwd);
  const dir = beaconDir(cwd);
  mkdirSync(dir, { recursive: true });
  const guardPath = join(dir, "guard.mjs");
  writeFileSync(guardPath, readFileSync(GUARD_SOURCE, "utf8"));

  // $CLAUDE_PROJECT_DIR keeps the registration portable while the git dir sits
  // at <root>/.git; a linked worktree gets the absolute path instead.
  const command = dir === join(root, ".git", "beacon")
    ? `node "$CLAUDE_PROJECT_DIR/.git/beacon/guard.mjs"`
    : `node "${guardPath}"`;

  const settingsPath = join(root, ".claude", "settings.local.json");
  let settings: { hooks?: { PreToolUse?: HookEntry[] } } & Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch { return { installed: false, reason: ".claude/settings.local.json is not valid JSON — fix it and re-run start" }; }
  }
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  const present = settings.hooks.PreToolUse.some((entry) =>
    (entry.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("beacon/guard.mjs")));
  if (!present) {
    settings.hooks.PreToolUse.push({
      matcher: "Write|Edit|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command }],
    });
  }
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  ensureExcluded(cwd, ".claude/settings.local.json");
  return { installed: true, guardPath };
}
