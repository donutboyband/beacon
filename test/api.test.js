// The engine's public surface — what the app and CLI import. A rewrite must
// export the same names with the same kinds.
import { expect, test } from "bun:test";
import { engine } from "./support/subject.js";

test("public exports", () => {
  const surface = Object.fromEntries(Object.keys(engine).sort().map((k) => [k, typeof engine[k]]));
  expect(surface).toMatchSnapshot();
});

test("exported constants", () => {
  expect(engine.SCOPE_FILE).toBe(".beacon/scope.json");
  expect(engine.PROTO_NOTES).toBe(".beacon/prototype/README.md");
  expect(engine.DEFAULT_PROTOTYPE).toEqual([".beacon/prototype/**"]);
  expect({ allow: engine.DEFAULT_ALLOW, deny: engine.DEFAULT_DENY }).toMatchSnapshot();
});
