// The app's everyday git surface: context, branches, sync, saves, stashes,
// the working tree, and PR history via gh.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { engine } from "./support/subject.js";
import { cleanupRepos, makeRepo, normalize } from "./support/repo.js";

afterAll(cleanupRepos);
afterEach(() => { delete process.env.FAKE_GH_MODE; delete process.env.FAKE_GH_PR_LIST; delete process.env.FAKE_GH_PR_VIEW; });

describe("context", () => {
  test("getContext snapshot, in and out of a repo", () => {
    const repo = makeRepo();
    expect(normalize(engine.getContext(repo.cwd), repo)).toMatchSnapshot();
    expect(engine.getContext(repo.tmp)).toEqual({ cwd: repo.tmp, isRepo: false });
  });

  test("ownerRepo parses https and ssh remotes", () => {
    const repo = makeRepo();
    for (const [url, want] of [
      ["https://github.com/acme/web.git", "acme/web"],
      ["git@github.com:acme/web.git", "acme/web"],
      ["https://github.com/acme/web", "acme/web"],
      ["https://gitlab.com/acme/web.git", null],
    ]) {
      repo.git("remote", "set-url", "origin", url);
      expect(engine.ownerRepo(repo.cwd)).toBe(want);
    }
  });

  test.each([
    [undefined, { installed: true, authed: true, login: "test-user" }],
    ["unauthed", { installed: true, authed: false, login: null }],
    ["missing", { installed: false, authed: false, login: null }],
  ])("ghStatus (%s)", (mode, want) => {
    if (mode) process.env.FAKE_GH_MODE = mode;
    expect(engine.ghStatus()).toEqual(want);
    expect(engine.ghReady()).toBe(want.authed);
    expect(engine.ghIdentity()).toBe(want.login);
  });
});

describe("branches", () => {
  function withBranches() {
    const repo = makeRepo();
    for (const [name, date] of [["older", "2026-02-01T00:00:00Z"], ["newer", "2026-03-01T00:00:00Z"]]) {
      repo.git("switch", "-q", "-c", name, "main");
      repo.write(`src/${name}.ts`);
      repo.git("add", "-A");
      require("node:child_process").spawnSync("git", ["commit", "-q", "-m", name], {
        cwd: repo.cwd, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
      });
    }
    repo.git("push", "-q", "-u", "origin", "newer");
    repo.git("switch", "-q", "main");
    return repo;
  }

  test("listBranches: newest first, current/default flagged", () => {
    const repo = withBranches();
    expect(normalize(engine.listBranches({ cwd: repo.cwd }), repo)).toMatchSnapshot();
    expect(engine.listBranches({ cwd: repo.tmp })).toEqual({ current: "", defaultBranch: "main", branches: [] });
  });

  test("checkout", () => {
    const repo = withBranches();
    expect(engine.checkout({ cwd: repo.cwd, branch: "older" })).toEqual({ branch: "older" });
    expect(repo.git("branch", "--show-current")).toBe("older");
    repo.write("src/dirty.ts");
    expect(() => engine.checkout({ cwd: repo.cwd, branch: "main" })).toThrow("working tree has uncommitted changes — commit or stash first");
    expect(() => engine.checkout({ cwd: repo.cwd })).toThrow("no branch given");
    expect(() => engine.checkout({ cwd: repo.tmp, branch: "main" })).toThrow("not a git repository");
  });

  test("deleteBranch: guards, unmerged, force", () => {
    const repo = withBranches();
    expect(() => engine.deleteBranch({ cwd: repo.cwd, branch: "main" })).toThrow("can't delete the branch you're on — switch away first");
    repo.git("switch", "-q", "older");
    expect(() => engine.deleteBranch({ cwd: repo.cwd, branch: "main" })).toThrow("can't delete the default branch");
    repo.git("switch", "-q", "main");
    expect(() => engine.deleteBranch({ cwd: repo.cwd, branch: "older" })).toThrow(/^unmerged$/);
    expect(engine.deleteBranch({ cwd: repo.cwd, branch: "older", force: true })).toEqual({ deleted: "older", forced: true });
    // Pushed counts as merged for `git branch -d` (merged into its upstream);
    // the remote copy is left alone.
    expect(engine.deleteBranch({ cwd: repo.cwd, branch: "newer" })).toEqual({ deleted: "newer", forced: false });
    expect(repo.tryGit("ls-remote", "--exit-code", "origin", "newer").code).toBe(0);
    repo.git("branch", "merged", "main");
    expect(engine.deleteBranch({ cwd: repo.cwd, branch: "merged" })).toEqual({ deleted: "merged", forced: false });
    expect(() => engine.deleteBranch({ cwd: repo.cwd, branch: "nope" })).toThrow("error: branch 'nope' not found");
  });

  test("branchLog: this branch's commits with change counts", () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "log me" });
    repo.commit("add a", { "src/components/A.tsx": "1\n2\n3\n" });
    repo.commit("edit a, add bin", { "src/components/A.tsx": "1\n3\n", "public/x.png": Buffer.from([0, 1, 2]) });
    expect(normalize(engine.branchLog({ cwd: repo.cwd }), repo)).toMatchSnapshot();
  });
});

describe("sync", () => {
  test("remoteState, fetchRemote, pull", () => {
    const repo = makeRepo();
    expect(engine.remoteState({ cwd: repo.cwd })).toEqual({ ahead: 0, behind: 0, upstream: "origin/main" });
    repo.other().commit("theirs", { "src/theirs.ts": "t\n" }).push();
    repo.commit("mine", { "src/mine.ts": "m\n" });
    expect(engine.remoteState({ cwd: repo.cwd })).toEqual({ ahead: 1, behind: 0, upstream: "origin/main" });
    expect(engine.remoteState({ cwd: repo.cwd, fetch: true })).toEqual({ ahead: 1, behind: 1, upstream: "origin/main" });
    expect(() => engine.pull({ cwd: repo.cwd })).toThrow(); // diverged: ff-only refuses
    repo.git("reset", "-q", "--hard", "origin/main~1");
    expect(engine.fetchRemote({ cwd: repo.cwd })).toEqual({ fetched: true });
    expect(engine.pull({ cwd: repo.cwd }).pulled).toBe(true);
    expect(repo.exists("src/theirs.ts")).toBe(true);
    repo.write("src/dirty.ts");
    expect(() => engine.pull({ cwd: repo.cwd })).toThrow("you have uncommitted changes — save or set them aside first");
  });

  test("no upstream, detached, not a repo", () => {
    const repo = makeRepo();
    repo.git("switch", "-q", "-c", "local-only");
    expect(engine.remoteState({ cwd: repo.cwd })).toEqual({ behind: 0, ahead: 0, upstream: null });
    repo.git("switch", "-q", "--detach");
    expect(engine.remoteState({ cwd: repo.cwd })).toEqual({ behind: 0, ahead: 0, upstream: null });
    expect(() => engine.pull({ cwd: repo.cwd })).toThrow("detached HEAD — checkout a branch first");
    expect(engine.remoteState({ cwd: repo.tmp })).toEqual({ behind: 0, ahead: 0, upstream: null });
  });
});

describe("saving", () => {
  test("save with nothing unsaved", () => {
    const repo = makeRepo();
    expect(() => engine.commit({ cwd: repo.cwd })).toThrow("nothing to commit — no changes yet");
    // On a started branch the scope commit already differs from base, so the
    // guard above passes and git's own refusal comes through raw.
    engine.start({ cwd: repo.cwd, name: "saves" });
    expect(() => engine.commit({ cwd: repo.cwd })).toThrow(/^git commit -F .*\/msg\.txt failed: On branch saves\nnothing to commit, working tree clean$/);
  });

  test("commit: all, per-file, flagged, messages", () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "saves" });
    repo.write("src/components/A.tsx").write("src/api/b.ts").write("src/components/C.tsx");
    expect(() => engine.commit({ cwd: repo.cwd, message: "x" })).toThrow("can't commit — 1 file(s) outside this branch's scope:\n  src/api/b.ts");

    expect(engine.commit({ cwd: repo.cwd, files: ["src/components/A.tsx"] }))
      .toEqual({ committed: true, message: "Update A.tsx", files: 1, flagged: 0 });
    expect(repo.git("show", "--name-only", "--format=%s", "HEAD")).toBe("Update A.tsx\n\nsrc/components/A.tsx");

    expect(engine.commit({ cwd: repo.cwd, files: ["src/components/C.tsx", "src/api/b.ts"], allowFlagged: true }))
      .toEqual({ committed: true, message: "Update", files: 2, flagged: 1 });
    expect(() => engine.commit({ cwd: repo.cwd, files: ["src/components/A.tsx"] })).toThrow("no unsaved changes in the selected file(s)");

    // A whole-branch save checks every change vs base — including the flagged
    // file already committed above — not just what's unsaved.
    repo.write("src/components/D.tsx");
    expect(() => engine.commit({ cwd: repo.cwd, message: "Save all" })).toThrow("can't commit — 1 file(s) outside this branch's scope:\n  src/api/b.ts");
    const all = engine.commit({ cwd: repo.cwd, message: "  Save all  ", allowFlagged: true });
    expect(all.message).toBe("Save all");
    expect(all.files).toBeGreaterThan(1); // counts every change vs base, not just this save
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  test("per-file save leaves other staged work staged", () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "partial" });
    repo.write("src/components/A.tsx").write("src/components/B.tsx");
    repo.git("add", "src/components/B.tsx");
    engine.commit({ cwd: repo.cwd, files: ["src/components/A.tsx"] });
    expect(repo.git("diff", "--cached", "--name-only")).toBe("src/components/B.tsx");
  });

  test("workingChanges parses porcelain, including renames and deletions", () => {
    const repo = makeRepo({ "src/components/Old.tsx": "x\n", "src/a.css": "a\n", "src/gone.ts": "g\n", " lead.md": "space\n" });
    engine.start({ cwd: repo.cwd, name: "wc" });
    repo.git("mv", "src/components/Old.tsx", "src/components/New.tsx");
    repo.write("src/a.css", "b\n").rm("src/gone.ts").write("src/new dir/file.css").write(" lead.md", "changed\n");
    repo.git("add", "src/a.css");
    expect(engine.workingChanges({ cwd: repo.cwd })).toMatchSnapshot();
  });

  test("discard throws away tracked and untracked changes", () => {
    const repo = makeRepo();
    repo.write("src/index.ts", "changed\n").write("src/new/file.ts");
    expect(engine.discard({ cwd: repo.cwd })).toEqual({ discarded: true });
    expect(repo.git("status", "--porcelain")).toBe("");
  });
});

describe("stashes", () => {
  test("stash, list, detail, rename, pop, drop", () => {
    const repo = makeRepo();
    expect(engine.stash({ cwd: repo.cwd })).toEqual({ stashed: false, note: "No local changes to save" });
    repo.write("src/index.ts", "changed\n").write("src/new.ts");
    expect(engine.stash({ cwd: repo.cwd, message: "  wip one " }).stashed).toBe(true);
    repo.write("README.md", "two\n");
    engine.stash({ cwd: repo.cwd });
    expect(normalize(engine.stashList({ cwd: repo.cwd }), repo)).toMatchSnapshot("list");
    expect(engine.stashDetail({ cwd: repo.cwd, index: 1 })).toEqual({ index: 1, files: [{ status: "modified", file: "src/index.ts" }] });

    expect(engine.stashRename({ cwd: repo.cwd, index: 1, message: " renamed " })).toEqual({ renamed: true, message: "renamed" });
    expect(normalize(engine.stashList({ cwd: repo.cwd }), repo)).toMatchSnapshot("after rename");
    expect(() => engine.stashRename({ cwd: repo.cwd, index: 0, message: " " })).toThrow("a stash name is required");

    expect(engine.stashPop({ cwd: repo.cwd })).toEqual({ popped: true });
    expect(repo.exists("src/new.ts")).toBe(true);
    expect(engine.dropStash({ cwd: repo.cwd, index: 0 })).toEqual({ dropped: 0 });
    expect(engine.stashList({ cwd: repo.cwd })).toEqual([]);
    expect(() => engine.stashPop({ cwd: repo.cwd })).toThrow();
    expect(() => engine.dropStash({ cwd: repo.cwd, index: 3 })).toThrow();
  });
});

describe("pull requests", () => {
  test("list and detail via gh", () => {
    const repo = makeRepo();
    const list = join(repo.tmp, "list.json");
    const view = join(repo.tmp, "view.json");
    writeFileSync(list, JSON.stringify([{ number: 1, title: "A", state: "OPEN" }]));
    writeFileSync(view, JSON.stringify({
      number: 1, title: "A", body: "b",
      commits: [
        { oid: "abcdef1234567", messageHeadline: "first", authors: [{ name: "Ann", login: "ann" }], committedDate: "2026-01-02T00:00:00Z" },
        { oid: "1234567abcdef", messageHeadline: "", messageBody: "body line\nmore", authors: [{ login: "bob" }], authoredDate: "2026-01-03T00:00:00Z" },
        { oid: "", authors: [] },
      ],
      files: [{ path: "src/a.ts", additions: 1, deletions: 2, extra: true }],
    }));
    process.env.FAKE_GH_PR_LIST = list;
    process.env.FAKE_GH_PR_VIEW = view;
    expect(engine.listPullRequests({ cwd: repo.cwd })).toEqual({ available: true, prs: [{ number: 1, title: "A", state: "OPEN" }] });
    expect(engine.pullRequestDetail({ cwd: repo.cwd, number: 1 })).toMatchSnapshot();
  });

  test("unavailable without a GitHub remote or when gh fails", () => {
    const repo = makeRepo();
    process.env.FAKE_GH_MODE = "pr-fail";
    expect(engine.listPullRequests({ cwd: repo.cwd })).toEqual({ available: false, error: "no repo", prs: [] });
    expect(() => engine.pullRequestDetail({ cwd: repo.cwd, number: 9 })).toThrow("no pull request found");
    repo.git("remote", "set-url", "origin", "https://gitlab.com/x/y.git");
    expect(engine.listPullRequests({ cwd: repo.cwd })).toEqual({ available: false, prs: [] });
  });
});
