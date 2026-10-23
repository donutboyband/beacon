// Run the installed guard exactly the way Claude Code does: the command
// registered in .claude/settings.local.json, with the hook payload on stdin.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "./repo.js";

export function guardCommand(repo) {
  const settings = JSON.parse(repo.read(".claude/settings.local.json"));
  const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes("beacon/guard")));
  return entry.hooks.find((h) => h.command.includes("beacon/guard")).command;
}

export function runGuard(repo, payload, { raw } = {}) {
  const input = raw ?? JSON.stringify({ cwd: repo.cwd, tool_name: "Write", ...payload });
  const r = sh(repo.cwd, "sh", ["-c", guardCommand(repo)], { input, env: { CLAUDE_PROJECT_DIR: repo.cwd } });
  return { code: r.code, stdout: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

export function readFlagLog(repo) {
  const p = join(repo.gitDir(), "beacon", "flags.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
