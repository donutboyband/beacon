// GitHub via the gh CLI — scoped to a token when given. Beacon never handles
// credentials itself; gh and the browser do the sign-in.

import { isRepo, ownerRepo } from "./repo.ts";
import { run, tempFile, type Env } from "./process.ts";

const ghEnv = (token?: string): Env | undefined => (token ? { GH_TOKEN: token } : undefined);

// gh CLI present + authenticated (optionally scoped to a token).
export function ghReady(token?: string): boolean {
  const env = ghEnv(token);
  if (run("gh", ["--version"], { env }).code !== 0) return false;
  return run("gh", ["auth", "status"], { env }).code === 0;
}

// Whichever GitHub identity a given token maps to (for the UI to display).
export function ghIdentity(token?: string): string | null {
  const r = run("gh", ["api", "user", "--jq", ".login"], { env: ghEnv(token) });
  return r.code === 0 ? r.stdout : null;
}

// gh install + auth status, plus the signed-in login — drives the onboarding UI.
export function ghStatus() {
  const installed = run("gh", ["--version"]).code === 0;
  if (!installed) return { installed: false, authed: false, login: null };
  const authed = run("gh", ["auth", "status"]).code === 0;
  let login: string | null = null;
  if (authed) {
    const r = run("gh", ["api", "user", "--jq", ".login"]);
    if (r.code === 0) login = r.stdout;
  }
  return { installed, authed, login };
}

export interface PrRequest {
  cwd?: string;
  title: string;
  body: string;
  base: string;
  head: string;
  token?: string;
}

export function createPrViaGh({ cwd, title, body, base, head, token }: PrRequest): string {
  const bodyFile = tempFile("body.md", body);
  const r = run("gh", ["pr", "create", "--title", title, "--body-file", bodyFile, "--base", base, "--head", head], { cwd, env: ghEnv(token) });
  if (r.code !== 0) throw new Error(`gh pr create failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ---------------------------------------------------------------------------
// PR history
// ---------------------------------------------------------------------------

export function listPullRequests({ cwd, token }: { cwd?: string; token?: string } = {}) {
  if (!isRepo(cwd) || !ownerRepo(cwd)) return { available: false, prs: [] };
  const r = run("gh", ["pr", "list", "--state", "all", "--limit", "30",
    "--json", "number,title,state,headRefName,author,updatedAt,url,isDraft"], { cwd, env: ghEnv(token) });
  if (r.code !== 0) return { available: false, error: r.stderr || r.stdout, prs: [] };
  try { return { available: true, prs: JSON.parse(r.stdout) }; }
  catch { return { available: true, prs: [] }; }
}

interface GhCommit {
  oid?: string;
  messageHeadline?: string;
  messageBody?: string;
  authors?: { name?: string; login?: string }[];
  committedDate?: string;
  authoredDate?: string;
}

interface GhFile {
  path: string;
  additions: number;
  deletions: number;
}

export function pullRequestDetail({ cwd, number, token }: { cwd?: string; number?: number | string; token?: string } = {}) {
  const r = run("gh", ["pr", "view", String(number),
    "--json", "number,title,state,headRefName,body,url,author,commits,files,createdAt,mergedAt"], { cwd, env: ghEnv(token) });
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  const d = JSON.parse(r.stdout);
  // Normalize commits to a light-graph-friendly shape (oldest → newest as gh returns).
  d.commits = ((d.commits || []) as GhCommit[]).map((c) => ({
    oid: (c.oid || "").slice(0, 7),
    message: c.messageHeadline || (c.messageBody || "").split("\n")[0] || "(no message)",
    author: (c.authors && c.authors[0] && (c.authors[0].name || c.authors[0].login)) || "",
    date: c.committedDate || c.authoredDate || null,
  }));
  d.files = ((d.files || []) as GhFile[]).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
  return d;
}
