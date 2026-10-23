// `start`: branch creation, the scope declaration commit, CLAUDE.md, and the
// guard install — plus every way it refuses.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GUARD_SOURCE, engine } from "./support/subject.js";
import { cleanupRepos, makeRepo, normalize } from "./support/repo.js";
import { guardCommand } from "./support/guard.js";

afterAll(cleanupRepos);

describe("start", () => {
  test("creates the branch, commits the declaration first, installs the guard", async () => {
    const repo = makeRepo();
    const r = await engine.start({ cwd: repo.cwd, name: "  Update the Pricing Page!  " });
    expect(r).toMatchSnapshot();

    expect(repo.git("branch", "--show-current")).toBe("update-the-pricing-page");
    expect(repo.git("log", "--format=%s", "origin/main..HEAD")).toBe("Beacon: declare front-end scope for update-the-pricing-page");
    expect(repo.git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([".beacon/scope.json", "CLAUDE.md"]);
    expect(repo.tryGit("rev-parse", "--abbrev-ref", "@{upstream}").code).not.toBe(0); // --no-track

    expect(normalize(repo.read(".beacon/scope.json"), repo)).toMatchSnapshot("scope.json");
    expect(repo.read("CLAUDE.md")).toMatchSnapshot("CLAUDE.md (created)");
    expect(repo.read(".claude/settings.local.json")).toMatchSnapshot("settings.local.json");
    expect(repo.read(".git/info/exclude").split("\n")).toContain(".claude/settings.local.json");
    expect(repo.read(".git/beacon/guard.mjs")).toBe(require("node:fs").readFileSync(GUARD_SOURCE, "utf8"));
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  test("appends to an existing CLAUDE.md, and refreshes rather than stacks", async () => {
    const repo = makeRepo({ "CLAUDE.md": "# House rules\n\nBe nice.\n\n\n" });
    await engine.start({ cwd: repo.cwd, name: "first" });
    expect(repo.read("CLAUDE.md")).toMatchSnapshot("CLAUDE.md (appended)");

    // A merged branch leaves its section on main; the next start replaces it in place.
    repo.git("switch", "-q", "main");
    repo.commit("land first", { "CLAUDE.md": repo.git("show", "first:CLAUDE.md") + "\n\nTrailing notes.\n" });
    repo.push();
    const r = await engine.start({ cwd: repo.cwd, name: "second" });
    expect(r.claudeMdCreated).toBe(false);
    const md = repo.read("CLAUDE.md");
    expect(md.split("<!-- beacon:scope -->").length).toBe(2);
    expect(md).toContain("`second`");
    expect(md).not.toContain("`first`");
    expect(md).toMatchSnapshot("CLAUDE.md (refreshed)");
  });

  test("keeps existing hooks in settings.local.json and doesn't register twice", async () => {
    const repo = makeRepo();
    repo.write(".git/info/exclude", ".claude/settings.local.json\n"); // as Claude Code leaves it
    repo.write(".claude/settings.local.json", JSON.stringify({
      permissions: { allow: ["Bash(ls)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    }));
    await engine.start({ cwd: repo.cwd, name: "one" });
    expect((await engine.installGuard(repo.cwd)).installed).toBe(true);
    expect(repo.read(".claude/settings.local.json")).toMatchSnapshot();
    expect(repo.read(".git/info/exclude").split("\n").filter((l) => l === ".claude/settings.local.json").length).toBe(1);
  });

  test("reports, not throws, when settings.local.json is invalid", async () => {
    const repo = makeRepo();
    repo.write(".claude/settings.local.json", "{ nope");
    repo.git("add", "-A"); repo.git("commit", "-q", "-m", "broken settings"); repo.push();
    const r = await engine.start({ cwd: repo.cwd, name: "x" });
    expect(r.guardInstalled).toBe(false);
    expect(r.guardNote).toBe(".claude/settings.local.json is not valid JSON — fix it and re-run start");
    expect(r.committed).toBe(true);
  });

  test("a linked worktree registers the guard by absolute path", async () => {
    const repo = makeRepo();
    const wt = join(repo.tmp, "wt");
    repo.git("worktree", "add", "-q", "--detach", wt);
    await engine.start({ cwd: wt, name: "in worktree" });
    const cmd = guardCommand({ read: (f) => require("node:fs").readFileSync(join(wt, f), "utf8") });
    expect(normalize(cmd, repo)).toBe('node "<TMP>/work/.git/worktrees/wt/beacon/guard.mjs"');
  });

  test("removes the legacy commit-blocking hook, restoring a backed-up original", async () => {
    const repo = makeRepo();
    const hooks = join(repo.gitDir(), "hooks");
    repo.write(".git/hooks/pre-commit", "#!/bin/sh\n# devsigner-editable-zone-guard\nexit 1\n");
    repo.write(".git/hooks/pre-commit.pre-graft", "#!/bin/sh\necho original\n");
    repo.write(".git/hooks/devsigner-zone-check.mjs", "");
    require("node:fs").chmodSync(join(hooks, "pre-commit"), 0o755);
    const r = await engine.start({ cwd: repo.cwd, name: "legacy" });
    expect(r.legacyGuardRemoved).toBe(true);
    expect(r.committed).toBe(true);
    expect(repo.read(".git/hooks/pre-commit")).toBe("#!/bin/sh\necho original\n");
    expect(repo.exists(".git/hooks/pre-commit.pre-graft")).toBe(false);
    expect(repo.exists(".git/hooks/devsigner-zone-check.mjs")).toBe(false);
  });

  test("branches off the latest origin default, not local main", async () => {
    const repo = makeRepo();
    repo.other().commit("upstream work", { "src/new.ts": "x\n" }).push();
    await engine.start({ cwd: repo.cwd, name: "fresh" });
    expect(repo.exists("src/new.ts")).toBe(true);
  });

  test("falls back to master when origin/HEAD is unset", async () => {
    const repo = makeRepo();
    repo.git("push", "-q", "origin", "main:master");
    repo.git("remote", "set-head", "origin", "--delete");
    repo.git("update-ref", "-d", "refs/remotes/origin/main");
    expect(await engine.defaultBranch(repo.cwd)).toBe("master");
    expect((await engine.start({ cwd: repo.cwd, name: "on master" })).base).toBe("origin/master");
  });

  test.each([
    ["dirty tree", (r) => r.write("src/index.ts", "changed\n"), "x", "working tree has uncommitted changes — commit or stash first"],
    ["existing branch", (r) => r.git("branch", "taken"), "Taken", 'branch "taken" already exists'],
    ["empty slug", () => {}, "!!!", 'could not derive a branch name from "!!!"'],
  ])("refuses: %s", async (_label, setup, name, message) => {
    const repo = makeRepo();
    setup(repo);
    await expect(engine.start({ cwd: repo.cwd, name })).rejects.toThrow(message);
  });

  test("refuses outside a repo", async () => {
    const repo = makeRepo();
    await expect(engine.start({ cwd: repo.tmp, name: "x" })).rejects.toThrow("not a git repository");
  });
});

test("slugify", async () => {
  expect(engine.slugify("  Hello, World!  ")).toBe("hello-world");
  expect(engine.slugify("feat/Pricing_Page v2")).toBe("feat-pricing-page-v2");
  expect(engine.slugify("x".repeat(80))).toBe("x".repeat(60));
  expect(engine.slugify("—")).toBe("");
});
