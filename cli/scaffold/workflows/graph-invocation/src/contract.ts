import { z } from "zod";

export const graphInputSchema = z.object({
  schemaVersion: z.literal(1).describe("Version of this example input format."),
  value: z.number().int().min(-1000).max(1000).describe("Number Step 1 increments."),
  values: z.array(z.number().int().min(-1000).max(1000)).min(1).max(8).describe("Numbers processed by the map and reduce nodes."),
  mode: z.enum(["double", "triple"]).describe("Branch used to calculate the map offset."),
  loopUntil: z.number().int().min(-1000).max(10000).describe("Minimum value the loop must reach before it stops."),
}).strict().meta({
  title: "Workflow input",
  description: "The complete starting input for Step 1 and the remaining graph.",
  examples: [{ schemaVersion: 1, value: 10, values: [1, 2, 3], mode: "double", loopUntil: 80 }],
});
export const step1OutputSchema = z.object({
  original: z.number().int().describe("Original value received by Step 1."),
  incremented: z.number().int().describe("Original value plus one."),
}).strict().meta({ title: "Step 1 output", description: "The saved output previously produced by Step 1.",
  examples: [{ original: 10, incremented: 11 }] });
export const step2InputSchema = z.object({
  input1: graphInputSchema.describe("Original workflow input that Step 2 needs."),
  output1: step1OutputSchema.describe("Saved Step 1 output that Step 2 needs."),
}).strict().meta({ title: "Step 2 input", description: "All values required to start directly at Step 2.", examples: [{
  input1: { schemaVersion: 1, value: 10, values: [1, 2, 3], mode: "double", loopUntil: 80 },
  output1: { original: 10, incremented: 11 },
}] });
export const step2OutputSchema = z.object({
  input1: graphInputSchema.describe("Original workflow input preserved by Step 2."),
  output1: step1OutputSchema.describe("Step 1 output preserved by Step 2."),
  base: z.number().int().describe("Incremented value used by the selected branch."),
  mode: z.enum(["double", "triple"]).describe("Branch selected for the remaining graph."),
}).strict().meta({ title: "Step 2 output", description: "The saved output previously produced by Step 2.", examples: [{
  input1: { schemaVersion: 1, value: 10, values: [1, 2, 3], mode: "double", loopUntil: 80 },
  output1: { original: 10, incremented: 11 }, base: 11, mode: "double",
}] });
export const branchOutputSchema = z.object({
  selected: z.enum(["double", "triple"]).describe("Branch that produced this value."),
  value: z.number().int().describe("Offset calculated by the selected branch."),
}).strict().meta({ title: "Branch output", description: "The saved branch result needed by the map node.",
  examples: [{ selected: "double", value: 22 }] });
export const graphResultSchema = z.object({
  schemaVersion: z.literal(1),
  input1: graphInputSchema,
  output1: step1OutputSchema,
  output2: step2OutputSchema,
  branch: branchOutputSchema,
  mapped: z.array(z.number().int()),
  reduced: z.number().int(),
  looped: z.number().int(),
}).strict();

export const GRAPH_RESULT_KIND = "graph-invocation.result";
export type GraphInput = z.infer<typeof graphInputSchema>;
export type Step1Output = z.infer<typeof step1OutputSchema>;
export type Step2Input = z.infer<typeof step2InputSchema>;
export type Step2Output = z.infer<typeof step2OutputSchema>;
export type BranchOutput = z.infer<typeof branchOutputSchema>;
export type GraphResult = z.infer<typeof graphResultSchema>;
