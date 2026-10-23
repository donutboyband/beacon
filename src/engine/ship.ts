// ship: stage, commit, push, and open an annotated PR — through gh when it's
// signed in, else the GitHub REST API with a token.

import { plan } from "./describe.ts";
import { createPrViaGh, ghReady, type PrRequest } from "./gh.ts";
import { gitFor, gitMust, tempFile } from "./process.ts";
import { currentBranch, defaultBranch, ownerRepo, requireRepo } from "./repo.ts";

async function createPrViaRest({ cwd, title, body, base, head, token }: PrRequest): Promise<string> {
  if (!token) throw new Error("no gh auth and no GitHub token — cannot open a PR");
  const or = await ownerRepo(cwd);
  if (!or) throw new Error("could not parse owner/repo from origin remote");
  const res = await fetch(`https://api.github.com/repos/${or}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "beacon-app",
    },
    body: JSON.stringify({ title, body, base, head }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`GitHub API PR create failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  return data.html_url;
}

export interface ShipOptions {
  cwd?: string;
  dryRun?: boolean;
  title?: string;
  anthropicKey?: string;
  model?: string;
  githubToken?: string;
  allowFlagged?: boolean;
}

// dryRun: returns {branch, defaultBranch, files, annotation} with zero side effects.
// real:   stages, commits, pushes, opens PR. githubToken scopes the gh/REST call.
export async function ship({ cwd, dryRun = false, title, anthropicKey, model, githubToken, allowFlagged = false }: ShipOptions = {}) {
  await requireRepo(cwd);
  const branch = await currentBranch(cwd);
  const def = await defaultBranch(cwd);
  if (!branch) throw new Error("detached HEAD — checkout a branch first");
  if (branch === def) throw new Error(`on ${def} — run start first; Beacon won't ship to the default branch`);

  const p = await plan({ cwd, anthropicKey, model });
  if (!p.files.length) throw new Error("no changes to ship on this branch");
  const finalTitle = title || p.annotation.title;
  const flagged = p.files.filter((f) => f.outOfScope).map((f) => f.file);

  if (dryRun) {
    // Preview never mutates; surface flagged files as a warning, don't throw.
    return { dryRun: true, branch, defaultBranch: def, files: p.files, flagged, annotation: { ...p.annotation, title: finalTitle } };
  }

  // The pre-PR gate: flagged changes must be looked at (and reverted or
  // explicitly accepted) before the PR opens. allowFlagged is the "create the
  // PR anyway" override — the files are still called out in the PR body.
  if (flagged.length && !allowFlagged) {
    throw new Error(
      `blocked: ${flagged.length} file(s) are outside this branch's declared scope. Review them (beacon review) or ship with them flagged:\n${flagged.map((f) => `  ${f}`).join("\n")}`
    );
  }

  // Stage + commit.
  await gitMust(cwd, "add", "-A");
  let committed = false;
  if ((await gitFor(cwd)("diff", "--cached", "--quiet")).code !== 0) {
    const msg = [finalTitle, "", ...p.files.map((f) => `- ${f.status}: ${f.file}`)].join("\n");
    await gitMust(cwd, "commit", "-F", await tempFile("msg.txt", msg));
    committed = true;
  }

  // Push.
  await gitMust(cwd, "push", "-u", "origin", branch);

  // Open PR (gh scoped to token, else REST).
  const useGh = await ghReady(githubToken);
  const pr = { cwd, title: finalTitle, body: p.annotation.body, base: def, head: branch, token: githubToken };
  const prUrl = useGh ? await createPrViaGh(pr) : await createPrViaRest(pr);

  return { dryRun: false, branch, defaultBranch: def, committed, pushed: true, prUrl, annotation: { ...p.annotation, title: finalTitle }, via: useGh ? "gh" : "rest" };
}
