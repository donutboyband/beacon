// Diff analysis: what changed on the branch vs its base, and what the added
// lines reuse (components, design tokens) or assume (TODOs, placeholders).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitFor } from "./process.ts";
import { repoRoot } from "./repo.ts";
import { SCOPE_FILE, fileZone } from "./scope.ts";
import type { ChangedFile, ScopeConfig, Signal } from "./types.ts";

const STATUS_WORDS: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed" };

// A --name-status letter as a word ("changed" for anything unrecognised).
export const statusWord = (code: string | undefined) => (code && STATUS_WORDS[code]) || "changed";

// Where the branch left the default branch (or origin/<default> if unrelated).
export async function baseRef(cwd: string | undefined, def: string): Promise<string> {
  const r = await gitFor(cwd)("merge-base", "HEAD", `origin/${def}`);
  return r.code === 0 ? r.stdout : `origin/${def}`;
}

export async function untrackedFiles(cwd?: string): Promise<string[]> {
  const r = await gitFor(cwd)("ls-files", "--others", "--exclude-standard");
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

// Untracked text files rendered as added-line diff hunks (first 500 lines).
async function untrackedAsDiff(cwd?: string): Promise<string> {
  const root = await repoRoot(cwd);
  let out = "";
  for (const f of await untrackedFiles(cwd)) {
    if (f === "CLAUDE.md" || f === SCOPE_FILE) continue;
    try {
      const content = await readFile(join(root, f), "utf8");
      if (content.includes("\0")) continue;
      const lines = content.split("\n").slice(0, 500);
      out += `\n+++ b/${f}\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

// Every file that differs from base — committed, staged, unstaged, untracked —
// each once, with its zone. The first source to mention a file sets its status.
export async function changedFiles(cwd: string | undefined, base: string, cfg: ScopeConfig): Promise<ChangedFile[]> {
  const git = gitFor(cwd);
  const merged = new Map<string, string | undefined>();
  const ingest = (text: string) => {
    for (const line of text.split("\n").filter(Boolean)) {
      const parts = line.split(/\t/);
      const code = parts[0]?.[0];
      const file = parts[parts.length - 1]!;
      if (!merged.has(file)) merged.set(file, code);
    }
  };
  ingest((await git("diff", "--name-status", `${base}...HEAD`)).stdout || "");
  ingest((await git("diff", "--name-status", "--cached")).stdout || "");
  ingest((await git("diff", "--name-status", "HEAD")).stdout || "");
  for (const f of await untrackedFiles(cwd)) if (!merged.has(f)) merged.set(f, "A");

  return [...merged.entries()].map(([file, code]) => {
    const zone = fileZone(file, cfg);
    return {
      file,
      status: statusWord(code),
      outOfScope: zone === "out",
      prototype: zone === "prototype",
    };
  });
}

// Beacon's declaration files are excluded — their glob patterns would pollute
// the reused-token/component signal on every branch. Prototype code stays in:
// it's real UI work and its reuse signal matters.
export async function fullDiff(cwd: string | undefined, base: string): Promise<string> {
  const git = gitFor(cwd);
  const excl = ["--", ".", `:(exclude)${SCOPE_FILE}`, ":(exclude)CLAUDE.md"];
  const committed = (await git("diff", `${base}...HEAD`, ...excl)).stdout || "";
  const uncommitted = (await git("diff", "HEAD", ...excl)).stdout || "";
  return [committed, uncommitted, await untrackedAsDiff(cwd)].filter(Boolean).join("\n");
}

export function analyzeAddedLines(diff: string): Signal {
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  const tokens = new Set<string>();
  const components = new Set<string>();
  const assumptions: string[] = [];
  for (const line of added) {
    if (/design-tokens|["']@[\w-]+\/tokens/.test(line)) {
      const m = line.match(/from\s+["']([^"']*(?:design-tokens|tokens)[^"']*)["']/);
      if (m?.[1]) tokens.add(m[1]);
    }
    for (const v of line.matchAll(/var\(\s*(--[\w-]+)/g)) tokens.add(v[1]!);
    for (const t of line.matchAll(/\btokens\.([\w.]+)/g)) tokens.add(`tokens.${t[1]}`);
    for (const c of line.matchAll(/<([A-Z][A-Za-z0-9]+)[\s/>]/g)) components.add(c[1]!);
    const imp = line.match(/import\s+\{?\s*([A-Z][A-Za-z0-9]+)[\s,}].*from\s+["'][^"']*components?[^"']*["']/);
    if (imp?.[1]) components.add(imp[1]);
    if (/\b(TODO|FIXME|HACK|XXX)\b/i.test(line) || /\b(assume|assumption|placeholder|hard-?cod|for now)\b/i.test(line)) {
      assumptions.push(line.trim().slice(0, 120));
    }
  }
  return {
    tokens: [...tokens].slice(0, 20),
    components: [...components].slice(0, 20),
    assumptions: assumptions.slice(0, 8),
  };
}
