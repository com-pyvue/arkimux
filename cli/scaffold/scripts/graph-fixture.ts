import { readFile } from "node:fs/promises";
import type { GraphEntrySelectionV1, JsonValue } from "@com-pyvue/agent-execution-core";
import { graphInputSchema, step2InputSchema, step2OutputSchema } from "../workflows/graph-invocation/src/contract.js";

export type GraphFixtureEntry = "step1" | "step2" | "map-item-1";

export async function graphFixtureValues(entry: GraphFixtureEntry): Promise<Record<string, JsonValue>> {
  const input1 = graphInputSchema.parse(JSON.parse(await readFile("workflows/graph-invocation/fixtures/example-input.json", "utf8")));
  const step2 = step2InputSchema.parse(JSON.parse(await readFile("workflows/graph-invocation/fixtures/step2-input.json", "utf8")));
  if (entry === "step1") return { entry: input1 };
  if (entry === "step2") return { entry: step2 };
  const output2 = step2OutputSchema.parse({ ...step2, base: step2.output1.incremented, mode: step2.input1.mode });
  const offset = output2.base * (output2.mode === "double" ? 2 : 3);
  return {
    entry: { item: input1.values[1], index: 1, context: { offset } },
    "control/map@map=1/input": { items: input1.values, context: { offset } },
    "control/map@map=1/completed": [input1.values[0] + offset],
    "node/branch/output": { selected: output2.mode, value: offset },
    "node/step2/input": step2,
    "node/step2/output": output2,
  };
}

export function graphFixtureSelection(entry: GraphFixtureEntry): GraphEntrySelectionV1 {
  if (entry === "step1") return { kind: "default" as const };
  if (entry === "step2") return { kind: "selected" as const, address: { schemaVersion: 1 as const, path: [{ nodeId: "step2" }] } };
  return { kind: "selected" as const, address: { schemaVersion: 1 as const, path: [
    { nodeId: "map", occurrence: { kind: "map" as const, index: 1 } }, { nodeId: "map-item" },
  ] } };
}

export function graphFixtureEntryFromAddress(path: readonly {
  nodeId: string;
  occurrence?: { kind: string; index?: number };
}[]): GraphFixtureEntry {
  if (path.length === 1 && path[0]?.nodeId === "step1") return "step1";
  if (path.length === 1 && path[0]?.nodeId === "step2") return "step2";
  if (path.length === 2 && path[0]?.nodeId === "map" && path[0].occurrence?.kind === "map"
    && path[0].occurrence.index === 1 && path[1]?.nodeId === "map-item") return "map-item-1";
  throw new Error("This helper answers only the documented Step 1, Step 2, and map item 1 fixtures.");
}
