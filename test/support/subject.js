// The code under test. Every test reaches Beacon through this file only, so
// the same suite can be pointed at a rewritten engine, guard, or CLI by
// changing what's exported here — the tests themselves stay untouched.
//
// Tests run against the built bundles in out/ (rebuilt by test/support/build.js
// before every run), i.e. exactly what the app and CLI load.
import { join } from "node:path";

export * as engine from "../../out/engine.mjs";

const ROOT = join(import.meta.dir, "..", "..");

// What `start` copies into a guarded repo.
export const GUARD_SOURCE = join(ROOT, "out", "guard.mjs");

// How to invoke the CLI: argv prefix, run with the repo as cwd.
export const CLI = ["node", join(ROOT, "bin", "beacon.mjs")];
