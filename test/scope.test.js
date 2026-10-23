// Which zone each path lands in under the default scope — and that the live
// guard and the engine's diff scan agree, since they match globs separately.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { engine } from "./support/subject.js";
import { cleanupRepos, makeRepo } from "./support/repo.js";
import { runGuard } from "./support/guard.js";

// Ordinary cases plus the edges the glob rules produce (root-level files,
// substring matches like "*auth*" catching AuthorCard).
const PATHS = [
  "src/components/Button.tsx",
  "src/components/AuthorCard.tsx",
  "src/components/forms/input.ts",
  "src/styles/main.css",
  "src/pages/index.tsx",
  "src/pages/api/users.ts",
  "src/views/home.vue",
  "src/routes/home.tsx",
  "src/router.tsx",
  "src/auth/login.tsx",
  "src/lib/authorize.ts",
  "src/api/users.ts",
  "src/server/index.ts",
  "src/middleware.ts",
  "src/user.schema.ts",
  "src/utils/format.ts",
  "src/app.route.ts",
  "public/logo.svg",
  "assets/fonts/inter.woff2",
  "docs/guide.md",
  "index.html",
  "styles.css",
  "tailwind.config.js",
  "web/vite.config.ts",
  "tsconfig.json",
  "packages/ui/tsconfig.build.json",
  "package.json",
  "apps/web/package.json",
  "apps/web-server/components/x.tsx",
  "apps/web-client/src/state.ts",
  ".env.local",
  "config/prod.env.json",
  "prisma/schema.prisma",
  "db/migrations/001.sql",
  "supabase/functions/hello.ts",
  ".github/workflows/ci.yml",
  "pnpm-lock.yaml",
  "web/pnpm-lock.yaml",
  ".beacon/prototype/fixtures.json",
  ".beacon/prototype/README.md",
  ".beacon/notes.md",
];

let repo;
beforeAll(async () => {
  repo = makeRepo();
  await engine.start({ cwd: repo.cwd, name: "scope check" });
  for (const p of PATHS) repo.write(p);
});
afterAll(cleanupRepos);

function zoneOf(f) {
  return f.prototype ? "prototype" : f.outOfScope ? "out" : "in";
}

test("default scope classifies every path", async () => {
  const { files } = await engine.workingChanges({ cwd: repo.cwd });
  const zones = Object.fromEntries(files.map((f) => [f.file, zoneOf(f)]));
  expect(Object.keys(zones).sort()).toEqual([...PATHS].sort());
  expect(zones).toMatchSnapshot();
});

describe("guard agrees with the engine", () => {
  test.each(PATHS)("%s", async (file) => {
    const engineZone = zoneOf((await engine.workingChanges({ cwd: repo.cwd })).files.find((f) => f.file === file));
    const r = runGuard(repo, { tool_input: { file_path: `${repo.cwd}/${file}` } });
    expect(r.code).toBe(0);
    expect(r.stdout !== null).toBe(engineZone === "out");
  });
});
