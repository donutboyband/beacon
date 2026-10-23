// plan / ship: the PR description (deterministic and LLM), the flagged-file
// gate, and opening the PR through gh or the REST fallback. Network is mocked.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engine } from "./support/subject.js";
import { cleanupRepos, makeRepo, normalize } from "./support/repo.js";
import { flaggedBranch } from "./support/scenario.js";

const realFetch = globalThis.fetch;
let ghLog;

beforeEach(() => {
  ghLog = join(require("node:os").tmpdir(), `beacon-gh-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  process.env.FAKE_GH_LOG = ghLog;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.FAKE_GH_MODE;
  if (existsSync(ghLog)) require("node:fs").rmSync(ghLog);
});
afterAll(cleanupRepos);

const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "");

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = mock(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
    return handler(String(url), init);
  });
  return calls;
}
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("ship --dry-run", () => {
  test("builds the deterministic description with zero side effects", async () => {
    const repo = flaggedBranch();
    const head = repo.git("rev-parse", "HEAD");
    const tree = repo.git("status", "--porcelain");
    const r = await engine.ship({ cwd: repo.cwd, dryRun: true });
    expect(normalize(r, repo)).toMatchSnapshot();
    expect(r.annotation.body).toMatchSnapshot("body");
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("status", "--porcelain")).toBe(tree);
    expect(ghCalls()).toBe("");
  });

  test("title override; clean branch with no risks", async () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "feat/tidy-buttons" });
    repo.commit("tidy", { "src/components/Button.tsx": "export const Button = () => <button />;\n" });
    const r = await engine.ship({ cwd: repo.cwd, dryRun: true, title: "Tidy the buttons" });
    expect(r.annotation.title).toBe("Tidy the buttons");
    expect(r.flagged).toEqual([]);
    expect(r.annotation.body).toMatchSnapshot();
  });

  test("prototype without notes asks the author", async () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "proto" });
    repo.write(".beacon/prototype/Mock.tsx");
    const r = await engine.ship({ cwd: repo.cwd, dryRun: true });
    expect(r.annotation.body).toContain("_(no `.beacon/prototype/README.md` found — ask the author what the mocks stand in for.)_");
  });

  test("titles strip a conventional prefix", async () => {
    const repo = makeRepo();
    repo.git("switch", "-q", "-c", "fix/broken_nav-bar");
    repo.write("src/components/Nav.tsx");
    expect((await engine.ship({ cwd: repo.cwd, dryRun: true })).annotation.title).toBe("Broken Nav Bar");
  });
});

describe("ship", () => {
  test("refuses with flagged files unless allowed, touching nothing", async () => {
    const repo = flaggedBranch();
    const head = repo.git("rev-parse", "HEAD");
    await expect(engine.ship({ cwd: repo.cwd })).rejects.toThrow(
      "blocked: 4 file(s) are outside this branch's declared scope. Review them (beacon review) or ship with them flagged:\n  src/api/prices.ts\n  src/auth/session.ts\n  src/utils/fmt.ts\n  src/server/cache.ts",
    );
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
  });

  test("commits everything, pushes, and opens the PR through gh", async () => {
    const repo = flaggedBranch();
    const r = await engine.ship({ cwd: repo.cwd, allowFlagged: true });
    expect(normalize(r, repo)).toMatchSnapshot();
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(repo.git("log", "-1", "--format=%B")).toMatchSnapshot("commit message");
    expect(repo.git("rev-parse", "HEAD")).toBe(repo.git("rev-parse", "origin/polish-pricing"));
    expect(repo.git("rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/polish-pricing");
    expect(normalize(ghCalls(), repo)).toMatchSnapshot("gh calls");
  });

  test("an already-committed branch pushes without a new commit; token scopes gh", async () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "done" });
    repo.commit("work", { "src/components/A.tsx": "a\n" });
    const r = await engine.ship({ cwd: repo.cwd, githubToken: "tok123", title: "Done" });
    expect(r.committed).toBe(false);
    expect(r.via).toBe("gh");
    expect(ghCalls()).toContain("[GH_TOKEN=tok123]");
  });

  test("falls back to the REST API when gh isn't signed in", async () => {
    const repo = flaggedBranch();
    process.env.FAKE_GH_MODE = "unauthed";
    const calls = mockFetch(() => json(201, { html_url: "https://github.com/test/repo/pull/7" }));
    const r = await engine.ship({ cwd: repo.cwd, allowFlagged: true, githubToken: "tok" });
    expect(r.prUrl).toBe("https://github.com/test/repo/pull/7");
    expect(r.via).toBe("rest");
    expect(calls.length).toBe(1);
    expect(normalize({ ...calls[0], body: { ...calls[0].body, body: "<body>" } }, repo)).toMatchSnapshot();
    expect(calls[0].body.body).toBe(r.annotation.body);
  });

  test("REST errors surface with status and message", async () => {
    const repo = flaggedBranch();
    process.env.FAKE_GH_MODE = "missing";
    mockFetch(() => json(422, { message: "Validation Failed" }));
    await expect(engine.ship({ cwd: repo.cwd, allowFlagged: true, githubToken: "tok" }))
      .rejects.toThrow("GitHub API PR create failed (422): Validation Failed");
  });

  test("no gh and no token", async () => {
    const repo = flaggedBranch();
    process.env.FAKE_GH_MODE = "missing";
    await expect(engine.ship({ cwd: repo.cwd, allowFlagged: true })).rejects.toThrow("no gh auth and no GitHub token — cannot open a PR");
  });

  test("gh pr create failure", async () => {
    const repo = flaggedBranch();
    process.env.FAKE_GH_MODE = "pr-fail";
    await expect(engine.ship({ cwd: repo.cwd, allowFlagged: true })).rejects.toThrow("gh pr create failed: pull request create failed");
  });

  test.each([
    ["on the default branch", (r) => r.cwd, "on main — run start first; Beacon won't ship to the default branch"],
    ["with no changes", (r) => { r.git("switch", "-q", "-c", "empty"); return r.cwd; }, "no changes to ship on this branch"],
    ["detached", (r) => { r.git("switch", "-q", "--detach"); return r.cwd; }, "detached HEAD — checkout a branch first"],
    ["outside a repo", (r) => r.tmp, "not a git repository"],
  ])("refuses %s", async (_l, setup, msg) => {
    const repo = makeRepo();
    await expect(engine.ship({ cwd: setup(repo) })).rejects.toThrow(msg);
  });
});

describe("LLM description", () => {
  const llmReply = (text) => json(200, { content: [{ type: "text", text }] });

  test("uses Claude's title and body when the key is set", async () => {
    const repo = flaggedBranch();
    const calls = mockFetch(() => llmReply('```json\n{"title":"Polish pricing","body":"## What changed\\n\\nStuff."}\n```'));
    const p = await engine.plan({ cwd: repo.cwd, anthropicKey: "sk-test" });
    expect(p.annotation).toEqual({
      title: "Polish pricing",
      body: "## What changed\n\nStuff.\n\n---\n_Generated by Beacon (Claude claude-sonnet-5)._",
      source: "claude:claude-sonnet-5",
    });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers).toEqual({ "content-type": "application/json", "x-api-key": "sk-test", "anthropic-version": "2023-06-01" });
    expect(calls[0].body.model).toBe("claude-sonnet-5");
    expect(calls[0].body.max_tokens).toBe(1500);
    expect(normalize(calls[0].body.messages[0].content, repo)).toMatchSnapshot("prompt");
  });

  test("model override", async () => {
    const repo = flaggedBranch();
    const calls = mockFetch(() => llmReply('{"title":"T","body":"B"}'));
    const p = await engine.plan({ cwd: repo.cwd, anthropicKey: "k", model: "claude-opus-5-5" });
    expect(calls[0].body.model).toBe("claude-opus-5-5");
    expect(p.annotation.source).toBe("claude:claude-opus-5-5");
  });

  test.each([
    ["an HTTP error", () => json(500, {})],
    ["non-JSON text", () => llmReply("Sure! Here's a PR description.")],
    ["missing fields", () => llmReply('{"title":"only"}')],
    ["a network failure", () => { throw new Error("offline"); }],
  ])("falls back to deterministic on %s", async (_l, handler) => {
    const repo = flaggedBranch();
    mockFetch(handler);
    expect((await engine.plan({ cwd: repo.cwd, anthropicKey: "k" })).annotation.source).toBe("deterministic");
  });

  test("no key, no request", async () => {
    const repo = flaggedBranch();
    const calls = mockFetch(() => json(200, {}));
    expect((await engine.plan({ cwd: repo.cwd })).annotation.source).toBe("deterministic");
    expect(calls.length).toBe(0);
  });
});
