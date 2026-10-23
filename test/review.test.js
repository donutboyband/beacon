// status → review → revert on a branch with every kind of change.
import { afterAll, describe, expect, test } from "bun:test";
import { engine } from "./support/subject.js";
import { cleanupRepos, makeRepo, normalize } from "./support/repo.js";
import { runGuard } from "./support/guard.js";
import { BASE_FILES, flaggedBranch } from "./support/scenario.js";

afterAll(cleanupRepos);

describe("status", () => {
  test("lists every change vs base with zones, reuse signal, and stat", () => {
    const repo = flaggedBranch();
    expect(normalize(engine.status({ cwd: repo.cwd }), repo)).toMatchSnapshot();
  });

  test("a fresh branch only differs by Beacon's own files", () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "fresh" });
    expect(normalize(engine.status({ cwd: repo.cwd }), repo)).toMatchSnapshot();
  });

  test("new commits on the origin default never count as branch changes", () => {
    const repo = flaggedBranch();
    repo.other().commit("upstream", { "src/upstream.ts": "x\n" }).push();
    expect(engine.status({ cwd: repo.cwd, fetch: false }).files.some((f) => f.file === "src/upstream.ts")).toBe(false);
    expect(engine.status({ cwd: repo.cwd }).files.some((f) => f.file === "src/upstream.ts")).toBe(false);
  });

  test("a scope.json without allow/deny falls back to the defaults", () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "partial" });
    repo.write(".beacon/scope.json", JSON.stringify({ branch: "partial", deny: ["**/*.css"] }));
    repo.write("src/a.css").write("src/components/B.tsx");
    const zones = Object.fromEntries(engine.workingChanges({ cwd: repo.cwd }).files.map((f) => [f.file, f.outOfScope]));
    expect(zones).toEqual({ ".beacon/scope.json": false, "src/a.css": true, "src/components/B.tsx": false });
  });

  test("a malformed scope.json falls back to the defaults", () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "broken" });
    repo.write(".beacon/scope.json", "{ nope").write("src/auth/x.ts");
    expect(engine.workingChanges({ cwd: repo.cwd }).files.find((f) => f.file === "src/auth/x.ts").outOfScope).toBe(true);
  });

  test.each([
    ["outside a repo", (r) => r.tmp, "not a git repository"],
    ["detached HEAD", (r) => { r.git("switch", "-q", "--detach"); return r.cwd; }, "detached HEAD — checkout a branch first"],
  ])("refuses %s", (_l, setup, msg) => {
    const repo = makeRepo();
    expect(() => engine.status({ cwd: setup(repo) })).toThrow(msg);
  });
});

describe("review", () => {
  test("flags out-of-scope files with the guard's record and reason", () => {
    const repo = flaggedBranch();
    expect(normalize(engine.review({ cwd: repo.cwd }), repo)).toMatchSnapshot();
  });

  test("ignores flags from other branches and malformed log lines", () => {
    const repo = flaggedBranch();
    const log = `${repo.gitDir()}/beacon/flags.jsonl`;
    require("node:fs").appendFileSync(log, "not json\n" + JSON.stringify({ branch: "other", file: "src/server/cache.ts", reason: "x" }) + "\n");
    const r = engine.review({ cwd: repo.cwd });
    expect(r.flagged.find((f) => f.file === "src/server/cache.ts").flag).toBeNull();
    expect(r.events.length).toBe(3);
  });

  test("only the newest 20 events, newest first", () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "busy" });
    for (let i = 0; i < 25; i++) runGuard(repo, { tool_input: { file_path: `${repo.cwd}/src/api/f${i}.ts` } });
    const { events } = engine.review({ cwd: repo.cwd });
    expect(events.length).toBe(20);
    expect(events[0].file).toBe("src/api/f24.ts");
    expect(events.every((e) => e.resolved)).toBe(true);
  });
});

describe("revertOutOfScope", () => {
  test("one committed file: restores base with a new commit, leaves the rest", () => {
    const repo = flaggedBranch();
    const r = engine.revertOutOfScope({ cwd: repo.cwd, files: ["src/api/prices.ts"] });
    expect(r).toEqual({ reverted: 1, committed: true, files: ["src/api/prices.ts"] });
    expect(repo.read("src/api/prices.ts")).toBe(BASE_FILES["src/api/prices.ts"]);
    expect(repo.git("log", "-1", "--format=%s")).toBe("Beacon: revert out-of-scope change to src/api/prices.ts");
    expect(repo.read("src/utils/fmt.ts")).not.toBe(BASE_FILES["src/utils/fmt.ts"]);

    const review = engine.review({ cwd: repo.cwd });
    expect(review.flagged.map((f) => f.file).sort()).toEqual(["src/auth/session.ts", "src/server/cache.ts", "src/utils/fmt.ts"]);
    expect(review.events.find((e) => e.file === "src/api/prices.ts").resolved).toBe(true);
  });

  test("everything: committed adds, untracked files, and unstaged edits", () => {
    const repo = flaggedBranch();
    const r = engine.revertOutOfScope({ cwd: repo.cwd });
    expect({ ...r, files: [...r.files].sort() }).toEqual({
      reverted: 4,
      committed: true,
      files: ["src/api/prices.ts", "src/auth/session.ts", "src/server/cache.ts", "src/utils/fmt.ts"],
    });
    expect(repo.git("log", "-1", "--format=%s")).toBe("Beacon: revert out-of-scope changes");
    expect(repo.exists("src/auth/session.ts")).toBe(false);
    expect(repo.exists("src/server/cache.ts")).toBe(false);
    expect(repo.read("src/utils/fmt.ts")).toBe(BASE_FILES["src/utils/fmt.ts"]);
    expect(repo.exists("src/components/Price.tsx")).toBe(true);
    expect(repo.exists("src/styles/price.css")).toBe(true);
    expect(engine.review({ cwd: repo.cwd }).flagged).toEqual([]);
    expect(repo.git("status", "--porcelain")).toMatchSnapshot();
  });

  test("only untracked: removes it without committing", () => {
    const repo = makeRepo();
    engine.start({ cwd: repo.cwd, name: "u" });
    repo.write("src/server/new.ts");
    expect(engine.revertOutOfScope({ cwd: repo.cwd })).toEqual({ reverted: 1, committed: false, files: ["src/server/new.ts"] });
    expect(repo.exists("src/server/new.ts")).toBe(false);
  });

  test("nothing to revert, or a file that isn't flagged", () => {
    const repo = flaggedBranch();
    expect(engine.revertOutOfScope({ cwd: repo.cwd, files: ["src/components/Price.tsx"] })).toEqual({ reverted: 0, committed: false, files: [] });
  });
});
