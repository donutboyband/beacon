// Process helpers: every git and gh call goes through run(), cwd-aware.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Env = Record<string, string | undefined>;

export interface RunOptions {
  cwd?: string;
  env?: Env;
  // Porcelain output can start with a meaningful space; pass false to keep it.
  trim?: boolean;
}

export function run(cmd: string, args: string[], { cwd, env, trim = true }: RunOptions = {}): RunResult {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (res.error) return { code: 1, stdout: "", stderr: String(res.error.message) };
  const out = (s: string | null) => (trim ? (s || "").trim() : s || "");
  return { code: res.status ?? 1, stdout: out(res.stdout), stderr: out(res.stderr) };
}

export type Git = (...args: string[]) => RunResult;

// Bind a git runner to a working directory.
export function gitFor(cwd?: string): Git {
  return (...args) => run("git", args, { cwd });
}

export function gitMust(cwd: string | undefined, ...args: string[]): string {
  const r = run("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// Write text to a fresh temp file — commit messages and PR bodies are handed
// to git/gh by path, so nothing needs shell quoting.
export function tempFile(name: string, text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "beacon-")), name);
  writeFileSync(path, text, "utf8");
  return path;
}
