import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { headlessV2MethodParamsSchemas, parseHeadlessRequest } from "../../local/src/headlessDebuggerContracts.ts";

const scaffold = path.resolve("cli/scaffold");
const skillRoot = path.join(scaffold, ".agents/skills/arkimux-workflow-debugger");

describe("generated ArkiMux workflow debugger skill", () => {
  it("is discoverable from project instructions and preserves the mock-debug boundary", async () => {
    const [agents, skill] = await Promise.all([
      readFile(path.join(scaffold, "AGENTS.md"), "utf8"),
      readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
    ]);

    expect(agents).toContain(".agents/skills/arkimux-workflow-debugger/SKILL.md");
    expect(skill).toMatch(/^---\nname: arkimux-workflow-debugger\ndescription: .+\n---\n/u);
    expect(skill).toContain("./node_modules/.bin/arkimux debug stdio --project \"$PWD\"");
    expect(skill).toContain("Do not invent either one");
    expect(skill).toContain("Never fall back to executing workflow code on the host");
    expect(skill).toContain("A mutation changes simulated state; it is not a code fix");
    expect(agents).toMatch(/The\s+developer decides whether the supplied expectations describe the correct\s+business outcome\./u);
  });

  it("keeps the checked-in method reference aligned with the canonical V2 schemas", async () => {
    const reference = await readFile(path.join(skillRoot, "references/protocol-v2.md"), "utf8");
    const documented = [...reference.matchAll(/^### `([^`]+)`$/gmu)].map((match) => match[1]).sort();
    const canonical = Object.keys(headlessV2MethodParamsSchemas).sort();

    expect(documented).toEqual(canonical);
    expect(reference).toContain('"executeProjectCode": true');
    expect(reference).toContain('"allowSimulatedEvaluation": true');
    expect(reference).toMatch(/Match\s+responses by `id`, not by line position\./u);
    expect(reference).toContain("Always send `session.close`");

    const createExample = reference.match(/`session\.create` must be the first request\.[\s\S]*?```json\n([\s\S]*?)\n```/u)?.[1];
    expect(createExample).toBeDefined();
    expect(() => parseHeadlessRequest({
      schemaVersion: 2,
      id: "documented-create",
      method: "session.create",
      params: JSON.parse(createExample!),
    })).not.toThrow();
  });
});
