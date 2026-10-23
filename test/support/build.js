// Test preload (bunfig.toml): rebuild out/ so tests never run a stale bundle.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const r = spawnSync("bun", [join(import.meta.dir, "..", "..", "scripts", "build.ts")], { stdio: "inherit" });
if (r.status !== 0) throw new Error("build failed — see output above");
