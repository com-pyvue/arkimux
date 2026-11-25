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
    expect(reference).toMatch(/Match\s+responses by `id`, not by line position\./u);
    expect(reference).toContain("Always send `session.close`");

    const examples = [...reference.matchAll(/^```json\n([\s\S]*?)\n```$/gmu)];
    const [create, inspect] = examples.slice(0, 2).map(([, line]) => {
      expect(line).not.toContain("\n"); // Each example is one complete stdio request.
      return parseHeadlessRequest(JSON.parse(line));
    });
    expect(create).toMatchObject({
      schemaVersion: 2, method: "session.create", params: { authorization: {
        executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true, allowSimulatedEvaluation: true,
      } },
    });
    expect(inspect).toMatchObject({ schemaVersion: 2, method: "session.inspect", params: {} });
    expect(inspect.id).not.toBe(create.id);
  });
});
