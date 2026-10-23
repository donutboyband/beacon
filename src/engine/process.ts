// Process helpers: every git and gh call goes through run(), cwd-aware and
// asynchronous — nothing here blocks the Electron main process.

import { spawn } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
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

// Never rejects: a command that can't start reports code 1 with the reason in
// stderr, so callers branch on `code` alone. stdin is closed, so nothing can
// sit waiting for input.
export function run(cmd: string, args: string[], { cwd, env, trim = true }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RunResult) => { if (!settled) { settled = true; resolve(r); } };
    const fail = (err: Error) => done({ code: 1, stdout: "", stderr: String(err.message) });
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      fail(err as Error);
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => errOut.push(b));
    child.on("error", fail);
    child.on("close", (code) => {
      const text = (chunks: Buffer[]) => {
        const s = Buffer.concat(chunks).toString("utf8");
        return trim ? s.trim() : s;
      };
      done({ code: code ?? 1, stdout: text(out), stderr: text(errOut) });
    });
  });
}

export type Git = (...args: string[]) => Promise<RunResult>;

// Bind a git runner to a working directory.
export function gitFor(cwd?: string): Git {
  return (...args) => run("git", args, { cwd });
}

export async function gitMust(cwd: string | undefined, ...args: string[]): Promise<string> {
  const r = await run("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// Write text to a fresh temp file — commit messages and PR bodies are handed
// to git/gh by path, so nothing needs shell quoting.
export async function tempFile(name: string, text: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "beacon-")), name);
  await writeFile(path, text, "utf8");
  return path;
}

export function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
