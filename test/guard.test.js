// The PreToolUse guard, invoked the way Claude Code invokes it: flag-only,
// always exit 0, silent unless a write leaves the declared scope.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { engine } from "./support/subject.js";
import { cleanupRepos, makeRepo, normalize } from "./support/repo.js";
import { readFlagLog, runGuard } from "./support/guard.js";

afterAll(cleanupRepos);

function guarded(name = "guarded") {
  const repo = makeRepo();
  engine.start({ cwd: repo.cwd, name });
  return repo;
}
const write = (repo, file, extra = {}) => runGuard(repo, { tool_input: { file_path: join(repo.cwd, file) }, ...extra });

describe("guard", () => {
  test("in-scope writes pass silently", () => {
    const repo = guarded();
    expect(write(repo, "src/components/A.tsx")).toEqual({ code: 0, stdout: null, stderr: "" });
    expect(readFlagLog(repo)).toEqual([]);
  });

  test("out-of-scope writes are flagged, logged, and still allowed", () => {
    const repo = guarded();
    const r = write(repo, "src/auth/login.ts", { tool_name: "MultiEdit" });
    expect(r.code).toBe(0);
    expect(r.stdout.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(r.stdout).toMatchSnapshot("denied pattern");
    expect(normalize(readFlagLog(repo), repo)).toEqual([{
      ts: "<date>", branch: "guarded", file: "src/auth/login.ts", tool: "MultiEdit",
      reason: 'it matches the denied pattern "**/auth/**" — backend, auth, routing, DB, and infra are off-limits on this branch',
    }]);
    expect(write(repo, "src/utils/x.ts").stdout).toMatchSnapshot("no allowed pattern");
    expect(readFlagLog(repo).length).toBe(2);
  });

  test("relative paths resolve against the payload cwd; notebooks use notebook_path", () => {
    const repo = guarded();
    expect(runGuard(repo, { cwd: join(repo.cwd, "src"), tool_input: { file_path: "api/x.ts" } }).stdout).not.toBeNull();
    expect(readFlagLog(repo)[0].file).toBe("src/api/x.ts");
    expect(runGuard(repo, { tool_name: "NotebookEdit", tool_input: { notebook_path: join(repo.cwd, "db/nb.ipynb") } }).stdout).not.toBeNull();
    expect(readFlagLog(repo)[1]).toMatchObject({ file: "db/nb.ipynb", tool: "NotebookEdit" });
  });

  test("a custom prototype zone steers the agent there", () => {
    const repo = guarded();
    const scope = JSON.parse(repo.read(".beacon/scope.json"));
    repo.write(".beacon/scope.json", JSON.stringify({ ...scope, prototype: ["mocks/**"] }));
    expect(write(repo, "mocks/api.ts").stdout).toBeNull();
    expect(write(repo, "src/api/x.ts").stdout.hookSpecificOutput.additionalContext).toContain("under mocks/ (same interface");
  });

  test.each([
    ["Beacon's own files", (r) => write(r, ".beacon/scope.json")],
    ["CLAUDE.md", (r) => write(r, "CLAUDE.md")],
    ["the prototype zone", (r) => write(r, ".beacon/prototype/api.ts")],
    ["paths outside the repo", (r) => runGuard(r, { tool_input: { file_path: join(r.tmp, "elsewhere", "api", "x.ts") } })],
    ["a payload with no file", (r) => runGuard(r, { tool_input: { command: "ls" } })],
    ["unparseable stdin", (r) => runGuard(r, {}, { raw: "not json" })],
    ["a cwd outside any repo", (r) => runGuard(r, { cwd: r.tmp, tool_input: { file_path: join(r.tmp, "api", "x.ts") } })],
    ["a scope declared for another branch", (r) => { r.git("switch", "-q", "-c", "elsewhere"); return write(r, "src/api/x.ts"); }],
    ["a malformed scope.json", (r) => { r.write(".beacon/scope.json", "{ nope"); return write(r, "src/api/x.ts"); }],
    ["no scope.json", (r) => { r.rm(".beacon/scope.json"); return write(r, "src/api/x.ts"); }],
  ])("stays silent for %s", (_l, act) => {
    const repo = guarded();
    expect(act(repo)).toEqual({ code: 0, stdout: null, stderr: "" });
    expect(readFlagLog(repo)).toEqual([]);
  });

  test("a scope.json with no branch applies on any branch", () => {
    const repo = guarded();
    const { branch, ...scope } = JSON.parse(repo.read(".beacon/scope.json"));
    repo.write(".beacon/scope.json", JSON.stringify(scope));
    repo.git("switch", "-q", "-c", "elsewhere");
    expect(write(repo, "src/api/x.ts").stdout).not.toBeNull();
  });

  test("a scope.json without allow treats everything as out of scope", () => {
    const repo = guarded();
    repo.write(".beacon/scope.json", JSON.stringify({ branch: "guarded" }));
    expect(write(repo, "src/components/A.tsx").stdout).not.toBeNull();
  });

  test("a failing flag log never breaks the write", () => {
    const repo = guarded();
    mkdirSync(join(repo.gitDir(), "beacon", "flags.jsonl"));
    const r = write(repo, "src/api/x.ts");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toBeNull();
  });
});
