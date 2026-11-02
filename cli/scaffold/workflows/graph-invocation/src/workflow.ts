import { z } from "zod";
import {
  defineGraph, defineGraphValue, defineStep, defineWorkflow, graphChoice, graphLoop, graphMap, graphReduce,
  graphRef, graphStep, graphValue, type GraphBindingV1, type JsonValue,
} from "@com-pyvue/agent-execution-core";
import {
  branchOutputSchema, GRAPH_RESULT_KIND, graphInputSchema, graphResultSchema,
  step1OutputSchema, step2InputSchema, step2OutputSchema,
  type BranchOutput, type GraphInput, type GraphResult, type Step2Output,
} from "./contract.js";

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, JsonValue>;
const value = <T extends JsonValue>(schema: z.ZodType<T>) => defineGraphValue({ version: "1", schema: jsonSchema(schema), validator: schema });
const numberSchema = z.number().int().meta({ title: "Calculated value", description: "A whole-number result produced by this graph.", examples: [23] });
const numberValue = value(numberSchema);

const step1 = defineStep({ schemaVersion: 1, id: "step1", definitionVersion: "1", input: graphInputSchema, output: step1OutputSchema,
  async execute(_context, input) { return { original: input.value, incremented: input.value + 1 }; } });
const step2 = defineStep({ schemaVersion: 1, id: "step2", definitionVersion: "1", input: step2InputSchema, output: step2OutputSchema,
  async execute(_context, input) { return step2OutputSchema.parse({ input1: input.input1, output1: input.output1, base: input.output1.incremented, mode: input.input1.mode }); } });

function branchBody(id: "double" | "triple", multiplier: number) {
  const branch = defineStep({ schemaVersion: 1, id: `${id}-value`, definitionVersion: "1", input: step2OutputSchema, output: branchOutputSchema,
    async execute(_context, input) { return { selected: id, value: input.base * multiplier }; } });
  const node = graphStep({ id: `${id}-value`, step: branch, input: graphRef.workflowInput<Step2Output>(),
    inputSchema: jsonSchema(step2OutputSchema), outputSchema: jsonSchema(branchOutputSchema) });
  return defineGraph({ id: `${id}-branch`, definitionVersion: "1", input: value(step2OutputSchema), nodes: [node], entry: node, result: node });
}

const mapBodyInputSchema = z.object({
  item: z.number().int().describe("Value at the selected position in the map input."),
  index: z.number().int().nonnegative().describe("Zero-based position of this value. Map item 2 uses index 1."),
  context: z.object({ offset: z.number().int().describe("Branch result added to every mapped value.") }).strict()
    .describe("Shared values supplied to every map item."),
}).strict().meta({ title: "Map item input", description: "The item, position, and shared context for the selected map execution.",
  examples: [{ item: 2, index: 1, context: { offset: 22 } }] });
const mapStep = defineStep({ schemaVersion: 1, id: "map-item", definitionVersion: "1", input: mapBodyInputSchema, output: numberSchema,
  async execute(_context, input) { return input.item + input.context.offset + input.index; } });
const mapBodyNode = graphStep({ id: "map-item", step: mapStep, input: graphRef.workflowInput<z.infer<typeof mapBodyInputSchema>>(),
  inputSchema: jsonSchema(mapBodyInputSchema), outputSchema: jsonSchema(numberSchema) });
const mapBody = defineGraph({ id: "map-body", definitionVersion: "1", input: value(mapBodyInputSchema), nodes: [mapBodyNode], entry: mapBodyNode, result: mapBodyNode });

const reduceBodyInputSchema = z.object({ item: numberSchema, index: z.number().int().nonnegative(), accumulator: numberSchema, context: z.null() }).strict();
const reduceStep = defineStep({ schemaVersion: 1, id: "reduce-item", definitionVersion: "1", input: reduceBodyInputSchema, output: numberSchema,
  async execute(_context, input) { return input.accumulator + input.item; } });
const reduceBodyNode = graphStep({ id: "reduce-item", step: reduceStep, input: graphRef.workflowInput<z.infer<typeof reduceBodyInputSchema>>(),
  inputSchema: jsonSchema(reduceBodyInputSchema), outputSchema: jsonSchema(numberSchema) });
const reduceBody = defineGraph({ id: "reduce-body", definitionVersion: "1", input: value(reduceBodyInputSchema), nodes: [reduceBodyNode], entry: reduceBodyNode, result: reduceBodyNode });

const loopContextSchema = z.object({ until: numberSchema }).strict();
const loopBodyInputSchema = z.object({ state: numberSchema, iteration: z.number().int().nonnegative(), context: loopContextSchema }).strict();
const loopStep = defineStep({ schemaVersion: 1, id: "loop-item", definitionVersion: "1", input: loopBodyInputSchema, output: numberSchema,
  async execute(_context, input) { return input.state + 1; } });
const loopBodyNode = graphStep({ id: "loop-item", step: loopStep, input: graphRef.workflowInput<z.infer<typeof loopBodyInputSchema>>(),
  inputSchema: jsonSchema(loopBodyInputSchema), outputSchema: jsonSchema(numberSchema) });
const loopBody = defineGraph({ id: "loop-body", definitionVersion: "1", input: value(loopBodyInputSchema), nodes: [loopBodyNode], entry: loopBodyNode, result: loopBodyNode });

const finalInputSchema = graphResultSchema.omit({ schemaVersion: true });
const finalStep = defineStep({ schemaVersion: 1, id: "join-result", definitionVersion: "1", input: finalInputSchema, output: graphResultSchema,
  async execute(_context, input) { return graphResultSchema.parse({ schemaVersion: 1, ...input }); } });

export function defineGraphInvocationWorkflow() {
  const first = graphStep({ id: "step1", step: step1, input: graphRef.workflowInput<GraphInput>(),
    inputSchema: jsonSchema(graphInputSchema), outputSchema: jsonSchema(step1OutputSchema) });
  const secondInput = graphValue.object({ input1: graphRef.input(first), output1: graphRef.output(first) });
  const second = graphStep({ id: "step2", step: step2, input: secondInput, inputSchema: jsonSchema(step2InputSchema), outputSchema: jsonSchema(step2OutputSchema) });
  const branch = graphChoice({ id: "branch", input: graphRef.output(second), inputContract: value(step2OutputSchema), outputContract: value(branchOutputSchema),
    selectionVersion: "1", select: (input) => input.mode, cases: { double: branchBody("double", 2), triple: branchBody("triple", 3) } });
  const step2Input = graphRef.input(second);
  const input1 = graphValue.field(step2Input, "input1");
  const mapInputSchema = z.object({
    items: z.array(z.number().int()).describe("Complete ordered collection being mapped."),
    context: z.object({ offset: z.number().int().describe("Branch result added to every mapped value.") }).strict()
      .describe("Shared values supplied to every map item."),
  }).strict().meta({ title: "Map input", description: "The complete collection and shared context for this map execution.",
    examples: [{ items: [1, 2, 3], context: { offset: 22 } }] });
  const mapped = graphMap({ id: "map", input: graphValue.object({
    items: graphValue.field(input1, "values"),
    context: graphValue.object({ offset: graphValue.field(graphRef.output(branch), "value") }),
  }), inputContract: value(mapInputSchema), outputContract: value(z.array(numberSchema)), body: mapBody });
  const reduceInputSchema = z.object({ items: z.array(numberSchema), initial: numberSchema, context: z.null() }).strict();
  const reduced = graphReduce({ id: "reduce", input: graphValue.object({ items: graphRef.output(mapped), initial: graphValue.literal(0), context: graphValue.literal(null) }),
    inputContract: value(reduceInputSchema), outputContract: numberValue, body: reduceBody });
  const loopInputSchema = z.object({ state: numberSchema, context: loopContextSchema }).strict();
  const looped = graphLoop({ id: "loop", input: graphValue.object({ state: graphRef.output(reduced), context: graphValue.object({ until: graphValue.field(input1, "loopUntil") }) }),
    inputContract: value(loopInputSchema), outputContract: numberValue, body: loopBody, conditionVersion: "1",
    while: (input) => input.state < input.context.until });
  const joined = graphStep({ id: "join-result", step: finalStep, input: graphValue.object({
    input1, output1: graphValue.field(step2Input, "output1"), output2: graphRef.output(second), branch: graphRef.output(branch),
    mapped: graphRef.output(mapped), reduced: graphRef.output(reduced), looped: graphRef.output(looped),
  }) as GraphBindingV1<z.infer<typeof finalInputSchema>>, inputSchema: jsonSchema(finalInputSchema), outputSchema: jsonSchema(graphResultSchema) });
  return defineWorkflow({ workflow: { kind: "graph-invocation", version: 1 }, workflowContractVersion: "1", resultKind: GRAPH_RESULT_KIND,
    input: value(graphInputSchema), nodes: [joined, looped, reduced, mapped, branch, second, first], entry: first, result: joined,
    invocationEntries: [
      { id: "step1", label: "Step 1", entry: { kind: "default" } },
      { id: "step2", label: "Step 2", entry: { kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: "step2" }] } } },
      { id: "map-item-1", label: "Map item 2", entry: { kind: "selected", address: { schemaVersion: 1, path: [
        { nodeId: "map", occurrence: { kind: "map", index: 1 } }, { nodeId: "map-item" },
      ] } } },
    ] });
}

export function constructGraphInvocationWorkflow() {
  return { graph: defineGraphInvocationWorkflow(), agentPrompts: {} };
}

export type { GraphResult, BranchOutput };
