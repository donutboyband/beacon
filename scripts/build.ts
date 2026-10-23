// Bundle the TypeScript sources into out/, all for Node (Electron's main
// process, the CLI, and `node` running the guard are all Node, not Bun):
//   engine.mjs   the engine, imported by the CLI
//   guard.mjs    the PreToolUse hook `start` copies into each guarded repo —
//                a single dependency-free file
//   main.mjs     the Electron main process (engine bundled in)
//   preload.cjs  the sandboxed preload; sandboxed preloads can't load other
//                files, so it must be one CommonJS file

const GUARD_BANNER = `// Beacon PreToolUse guard — installed by \`beacon start\` into <git-dir>/beacon/
// and registered in .claude/settings.local.json. Built from src/engine/guard.ts.`;

async function bundle(entry: string, name: string, { banner, format = "esm" }: { banner?: string; format?: "esm" | "cjs" } = {}) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: "out",
    naming: name,
    target: "node",
    format,
    banner,
    external: ["electron"],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed: ${entry}`);
  }
}

const root = new URL("..", import.meta.url).pathname;
process.chdir(root);
await bundle("src/engine/index.ts", "engine.mjs");
await bundle("src/engine/guard.ts", "guard.mjs", { banner: GUARD_BANNER });
await bundle("src/main/main.ts", "main.mjs");
await bundle("src/main/preload.ts", "preload.cjs", { format: "cjs" });
