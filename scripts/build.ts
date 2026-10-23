// Bundle the TypeScript engine and guard into plain ESM for Node, in out/.
// The Electron main process and the CLI import out/engine.mjs; `start` copies
// out/guard.mjs into each guarded repo, where it runs on `node` with no
// dependencies — so each is a single self-contained file.

const GUARD_BANNER = `// Beacon PreToolUse guard — installed by \`beacon start\` into <git-dir>/beacon/
// and registered in .claude/settings.local.json. Built from src/engine/guard.ts.`;

async function bundle(entry: string, name: string, banner?: string) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: "out",
    naming: name,
    target: "node",
    format: "esm",
    banner,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed: ${entry}`);
  }
}

const root = new URL("..", import.meta.url).pathname;
process.chdir(root);
await bundle("src/engine/index.ts", "engine.mjs");
await bundle("src/engine/guard.ts", "guard.mjs", GUARD_BANNER);
