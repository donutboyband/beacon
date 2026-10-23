// The code under test. Every test reaches Beacon through this file only, so
// the same suite can be pointed at a rewritten engine, guard, or CLI by
// changing what's exported here — the tests themselves stay untouched.
import { join } from "node:path";

export * as engine from "../../src/engine/beacon-core.mjs";

const ROOT = join(import.meta.dir, "..", "..");

// How to invoke the CLI: argv prefix, run with the repo as cwd.
export const CLI = ["node", join(ROOT, "bin", "beacon.mjs")];
