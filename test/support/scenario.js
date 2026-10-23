// A realistic Beacon branch: in-scope UI work, committed and uncommitted
// out-of-scope drift, a deletion, a prototype, and guard flags on record.
import { engine } from "./subject.js";
import { makeRepo } from "./repo.js";
import { runGuard } from "./guard.js";

export const BASE_FILES = {
  "README.md": "# fixture\n",
  "src/index.ts": "export {};\n",
  "src/api/prices.ts": "export const prices = [];\n",
  "src/utils/fmt.ts": "export const fmt = (n) => String(n);\n",
  "docs/old.md": "old docs\n",
};

const PRICE_TSX = `import { Card } from "../components/Card";
import { Badge, Stack } from "@acme/ui/components";
import tokens from "@acme/tokens";
import { space } from "../design-tokens/space";

export const Price = () => (
  <Card style={{ color: "var(--brand-primary)", padding: "var( --space-4)" }}>
    <Stack gap={space.md}>
      <Badge tone="info">{tokens.color.primary}</Badge>
    </Stack>
  </Card>
);
// TODO: assume monthly billing for now
// hardcoded currency symbol
`;

export async function flaggedBranch() {
  const repo = makeRepo(BASE_FILES);
  await engine.start({ cwd: repo.cwd, name: "polish pricing" });

  repo.commit("price card", { "src/components/Price.tsx": PRICE_TSX });
  repo.rm("docs/old.md");
  repo.commit("drift", {
    "src/api/prices.ts": "export const prices = [9, 19];\n",
    "src/auth/session.ts": "export const session = null;\n",
  });
  repo.write(".beacon/prototype/README.md", "# Prototype\n\n\n- Needs `GET /api/prices` returning `{ id, amount }[]`\n- FIXME: currency comes from account settings\n");
  repo.write(".beacon/prototype/fixtures.json", "[{\"id\":1,\"amount\":9}]\n");
  repo.write("src/styles/price.css", ".price { color: var(--brand-primary); }\n");
  repo.write("src/server/cache.ts", "export const cache = new Map();\n");
  repo.write("src/utils/fmt.ts", "export const fmt = (n) => `$${n}`;\n");

  for (const file of ["src/api/prices.ts", "src/auth/session.ts", "src/utils/fmt.ts"]) {
    runGuard(repo, { tool_name: "Edit", tool_input: { file_path: `${repo.cwd}/${file}` } });
  }
  return repo;
}
