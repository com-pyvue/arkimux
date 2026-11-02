/** Declaration fixture, not a runnable host registration until LJ2-055. */
import { z } from "zod";
import {
  defineStep, defineGraphValue, defineWorkflow, graphStep, graphRef, graphValue,
} from "../../../core/src/index.ts";

const input1 = z.object({ value: z.number().describe("Number Step 1 processes.") })
  .meta({ title: "Step 1 input", description: "Starting value for the workflow.", examples: [{ value: 10 }] });
const output1 = z.object({ result: z.number().describe("Step 1 result.") })
  .meta({ title: "Step 1 output", description: "Saved output produced by Step 1.", examples: [{ result: 11 }] });
const input2 = z.object({ input1, output1 })
  .meta({ title: "Step 2 input", description: "Original input and saved Step 1 output.",
    examples: [{ input1: { value: 10 }, output1: { result: 11 } }] });
const output2 = z.object({ original: z.number(), doubled: z.number() });

const step1 = defineStep({
  schemaVersion: 1, id: "add-one", definitionVersion: "1", input: input1, output: output1,
  async execute(_context, input) { return { result: input.value + 1 }; },
});
const step2 = defineStep({
  schemaVersion: 1, id: "double", definitionVersion: "1", input: input2, output: output2,
  async execute(_context, input) {
    return { original: input.input1.value, doubled: input.output1.result * 2 };
  },
});

const first = graphStep({
  id: "first", step: step1, inputSchema: z.toJSONSchema(input1), outputSchema: z.toJSONSchema(output1),
  input: graphRef.workflowInput<z.infer<typeof input1>>(),
});
const second = graphStep({
  id: "second", step: step2, inputSchema: z.toJSONSchema(input2), outputSchema: z.toJSONSchema(output2),
  input: graphValue.object({ input1: graphRef.input(first), output1: graphRef.output(first) }),
});

export const exampleGraph = defineWorkflow({
  workflow: { kind: "example", version: 1 }, workflowContractVersion: "1", resultKind: "example.result",
  input: defineGraphValue({ version: "1", schema: z.toJSONSchema(input1), validator: input1 }),
  nodes: [first, second], entry: first, result: second,
  invocationEntries: [
    { id: "first", label: "Step 1", entry: { kind: "default" } },
    { id: "second", label: "Step 2", entry: { kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: "second" }] } } },
  ],
});
