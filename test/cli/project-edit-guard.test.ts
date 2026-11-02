import { describe, it, expect } from "vitest";
import { guardProjectSourceEdits } from "../../cli/src/projectEditGuard.ts";

const a = "a".repeat(64), b = "b".repeat(64);
describe("supplied source inventory guard", () => {
  it("does not claim a pass without a baseline", () => {
    expect(guardProjectSourceEdits(undefined, {})).toEqual({ status: "boundary-not-verified", changed: [], forbidden: [] });
  });
  it("detects additions, changes and deletions outside the extension boundary", () => {
    const result = guardProjectSourceEdits({ "workflows/a.ts": a, "scripts/serve-local.ts": a, "node_modules/pkg/index.js": a },
      { "workflows/a.ts": b, "scripts/serve-local.ts": b, "core/new.ts": b });
    expect(result.status).toBe("failed");
    expect(result.forbidden).toEqual(["core/new.ts", "node_modules/pkg/index.js", "scripts/serve-local.ts"]);
  });
  it("allows workflow and registry edits", () => {
    expect(guardProjectSourceEdits({}, { "workflows/a.ts": a, "src/arkimux.workflows.ts": a }).status).toBe("passed");
  });
  it("requires explicit approval and paired dependency changes", () => {
    const after = { "package.json": b, "package-lock.json": b };
    expect(guardProjectSourceEdits({}, after).status).toBe("failed");
    expect(guardProjectSourceEdits({}, after, { allowDependencyChanges: true }).status).toBe("passed");
    expect(guardProjectSourceEdits({}, { "package.json": b }, { allowDependencyChanges: true }).status).toBe("failed");
  });
  it("rejects traversal paths and values instead of hashes", () => {
    expect(() => guardProjectSourceEdits({}, { "workflows/../core/x.ts": a })).toThrow();
    expect(() => guardProjectSourceEdits({}, { "workflows/x.ts": "not-a-hash" })).toThrow();
  });
});
