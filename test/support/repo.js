// Throwaway git fixtures for the behaviour tests. Each repo is a working clone
// of a local bare "origin" whose path ends in github.com/test/repo.git, so
// Beacon's owner/repo parsing sees "test/repo" without any network.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Hermetic git: no user/system config (signing, hooks, aliases) or global
// ignore file, fixed identity and dates. The fake gh comes first on PATH so
// the real one is never reached. Set on process.env because the engine reads
// it directly.
const FAKE_BIN = join(import.meta.dir, "bin");
const DATE = "2026-01-01T00:00:00Z";
const EMPTY_XDG = join(tmpdir(), "beacon-test-xdg");
mkdirSync(EMPTY_XDG, { recursive: true });
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: EMPTY_XDG,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_AUTHOR_DATE: DATE,
  GIT_COMMITTER_DATE: DATE,
  PATH: `${FAKE_BIN}:${process.env.PATH}`,
});
for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "BEACON_MODEL", "FAKE_GH_MODE", "CLAUDE_PROJECT_DIR"]) {
  delete process.env[k];
}

const tmpRoots = [];

export function sh(cwd, cmd, args, { env, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", input, env: env ? { ...process.env, ...env } : process.env });
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function gitIn(cwd, ...args) {
  const r = sh(cwd, "git", args);
  if (r.code !== 0) throw new Error(`fixture: git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function clone(tmp, origin, name) {
  const dir = join(tmp, name);
  gitIn(tmp, "clone", "-q", origin, dir);
  return repoHandle(tmp, origin, dir);
}

function repoHandle(tmp, origin, cwd) {
  const h = {
    tmp,
    origin,
    cwd,
    git: (...args) => gitIn(cwd, ...args),
    tryGit: (...args) => sh(cwd, "git", args),
    write(file, content = `${file}\n`) {
      const p = join(cwd, file);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return h;
    },
    read: (file) => readFileSync(join(cwd, file), "utf8"),
    exists: (file) => existsSync(join(cwd, file)),
    rm(file) { rmSync(join(cwd, file), { force: true }); return h; },
    commit(message, files = {}) {
      for (const [f, c] of Object.entries(files)) h.write(f, c);
      gitIn(cwd, "add", "-A");
      gitIn(cwd, "commit", "-q", "-m", message);
      return h;
    },
    push: (branch = "main") => gitIn(cwd, "push", "-q", "-u", "origin", branch),
    gitDir: () => gitIn(cwd, "rev-parse", "--absolute-git-dir"),
    // A second clone of the same origin — "someone else" pushing.
    other: (name = "other") => clone(tmp, origin, name),
  };
  return h;
}

// A repo whose origin/main holds `files` as its first commit.
export function makeRepo(files = { "README.md": "# fixture\n", "src/index.ts": "export {};\n" }) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "beacon-test-")));
  tmpRoots.push(tmp);
  const origin = join(tmp, "github.com", "test", "repo.git");
  mkdirSync(origin, { recursive: true });
  gitIn(origin, "init", "-q", "--bare", "-b", "main");
  const seed = clone(tmp, origin, "work");
  seed.commit("initial", files);
  seed.push("main");
  seed.git("remote", "set-head", "origin", "main");
  return seed;
}

export function cleanupRepos() {
  while (tmpRoots.length) rmSync(tmpRoots.pop(), { recursive: true, force: true });
}

// Replace values that differ between runs (paths, shas, clocks) with stable
// placeholders so results can be compared exactly.
export function normalize(value, repo) {
  let s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (repo) s = s.split(repo.tmp).join("<TMP>");
  // macOS: /var/folders/… and its realpath /private/var/folders/… both appear.
  s = s.split(realpathSync(tmpdir())).join("<OSTMP>").split(tmpdir()).join("<OSTMP>");
  s = s.replace(/<OSTMP>\/beacon-[A-Za-z0-9]+/g, "<OSTMP>/beacon-XXXX");
  s = s.replace(/\b[0-9a-f]{40}\b/g, "<sha>").replace(/\b[0-9a-f]{7}\b/g, "<short-sha>");
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, "<date>");
  return typeof value === "string" ? s : JSON.parse(s);
}
