// The `beacon` CLI: exact terminal output (colours included) and exit codes.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "./support/subject.js";
import { cleanupRepos, makeRepo, normalize, sh } from "./support/repo.js";
import { flaggedBranch } from "./support/scenario.js";

let ghLog;
beforeEach(() => { ghLog = join(tmpdir(), `beacon-cli-gh-${process.pid}-${Math.random().toString(36).slice(2)}.log`); });
afterEach(() => { if (existsSync(ghLog)) rmSync(ghLog); });
afterAll(cleanupRepos);

function cli(cwd, args = [], repo) {
  const r = sh(cwd, CLI[0], [...CLI.slice(1), ...args], { env: { FAKE_GH_LOG: ghLog, TZ: "UTC", LC_ALL: "en_US.UTF-8" } });
  // Flag times print in the local format; the rest is exact.
  const clean = (s) => normalize(s, repo).replace(/flagged \d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}\s?[AP]M/g, "flagged <when>");
  return { code: r.code, stdout: clean(r.stdout), stderr: clean(r.stderr) };
}

describe("cli", () => {
  test.each([[[]], [["help"]], [["--help"]], [["-h"]]])("usage %p", async (args) => {
    const repo = makeRepo();
    expect(cli(repo.cwd, args)).toMatchSnapshot();
  });

  test("usage works outside a repo; commands don't", async () => {
    const repo = makeRepo();
    expect(cli(repo.tmp).code).toBe(0);
    expect(cli(repo.tmp, ["status"], repo)).toMatchSnapshot();
  });

  test("unknown command", async () => {
    const repo = makeRepo();
    expect(cli(repo.cwd, ["frobnicate"])).toMatchSnapshot();
  });

  test("start", async () => {
    const repo = makeRepo();
    expect(cli(repo.cwd, ["start"])).toMatchSnapshot("no name");
    expect(cli(repo.cwd, ["start", "polish", "the", "nav"], repo)).toMatchSnapshot("ok");
    expect(repo.git("branch", "--show-current")).toBe("polish-the-nav");
    repo.git("switch", "-q", "main");
    expect(cli(repo.cwd, ["start", "polish the nav"], repo)).toMatchSnapshot("exists");
  });

  test("start: guard not installed, legacy hook removed", async () => {
    const repo = makeRepo();
    repo.write(".git/hooks/pre-commit", "#!/bin/sh\n# devsigner-editable-zone-guard\nexit 1\n");
    repo.write(".git/info/exclude", ".claude/settings.local.json\n");
    repo.write(".claude/settings.local.json", "{ nope");
    expect(cli(repo.cwd, ["start", "x"], repo)).toMatchSnapshot();
  });

  test("status", async () => {
    const repo = await flaggedBranch();
    expect(cli(repo.cwd, ["status"], repo)).toMatchSnapshot("flagged branch");
    const clean = makeRepo();
    clean.git("switch", "-q", "-c", "empty");
    expect(cli(clean.cwd, ["status"], clean)).toMatchSnapshot("no changes");
  });

  test("review: list, hint, revert one, revert all, all clear", async () => {
    const repo = await flaggedBranch();
    expect(cli(repo.cwd, ["review", "--list"], repo)).toMatchSnapshot("list");
    expect(cli(repo.cwd, ["review"], repo)).toMatchSnapshot("non-tty hint");
    expect(cli(repo.cwd, ["review", "--revert", "src/components/Price.tsx"], repo)).toMatchSnapshot("revert unflagged");
    expect(cli(repo.cwd, ["review", "--revert", "src/api/prices.ts"], repo)).toMatchSnapshot("revert one");
    expect(cli(repo.cwd, ["review", "--revert-all"], repo)).toMatchSnapshot("revert all");
    expect(cli(repo.cwd, ["review"], repo)).toMatchSnapshot("all clear");
  });

  test("review on a branch with only one change", async () => {
    const repo = makeRepo();
    repo.git("switch", "-q", "-c", "one");
    repo.write("src/api/x.ts");
    expect(cli(repo.cwd, ["review", "--list"], repo)).toMatchSnapshot();
  });

  test("ship: dry run, blocked, allowed with a title", async () => {
    const repo = await flaggedBranch();
    expect(cli(repo.cwd, ["ship", "--dry-run"], repo)).toMatchSnapshot("dry run");
    expect(cli(repo.cwd, ["ship"], repo)).toMatchSnapshot("blocked");
    expect(cli(repo.cwd, ["ship", "--allow-flagged", "--title", "Pricing polish"], repo)).toMatchSnapshot("shipped");
    expect(readFileSync(ghLog, "utf8")).toContain("gh pr create --title Pricing polish");
  });
});
