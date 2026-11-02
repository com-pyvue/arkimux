import { z } from "zod";
import { admitGraphInvocationV1, defineStep, graphStep, graphRef, graphValue, defineGraphValue, defineWorkflow, graphMap, type GraphBindingV1, type GraphInvocationRequestV1 } from "../../core/src/index.ts";

const add = defineStep({ schemaVersion: 1, id: "add", definitionVersion: "1", input: z.number(), output: z.number(),
  async execute(_context, input) { return input + 1; } });
const first = graphStep({ id: "one", step: add, input: graphRef.workflowInput<number>(), inputSchema: { type: "number" }, outputSchema: { type: "number" } });
const second = graphStep({ id: "two", step: add, input: graphRef.output(first), inputSchema: { type: "number" }, outputSchema: { type: "number" } });
const number = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });
const options = { workflow: { kind: "example", version: 1 }, workflowContractVersion: "1", resultKind: "example.result",
  input: number, nodes: [second, first], entry: first, result: second };
const workflow = defineWorkflow(options);
const result: number = workflow.output.validator.parse(3);
const reference: GraphBindingV1<number> = graphRef.output(second);
void result; void reference;
const request: GraphInvocationRequestV1 = { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "1d" } };
const admission = admitGraphInvocationV1(workflow, request);
void admission.plan.requirements[0]?.schema;
defineWorkflow({ ...options, invocationEntries: [
  { id: "one", label: "Step 1", entry: { kind: "default" } },
  { id: "two", label: "Step 2", entry: { kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: "two" }] } } },
] });

// @ts-expect-error Step's input validator fixes the binding type; inference cannot widen it.
graphStep({ id: "bad", step: add, input: graphValue.literal("wrong"), inputSchema: { type: "number" }, outputSchema: { type: "number" } });
// @ts-expect-error Source output types propagate to references.
const wrongReference: GraphBindingV1<string> = graphRef.output(first);
// @ts-expect-error Field selection is restricted to the source's keys.
graphValue.field(graphValue.literal({ value: 1 }), "missing");
// @ts-expect-error Fallback must match the selected field.
graphValue.field(graphValue.literal({ value: 1 }), "value", { fallback: "wrong" });
// @ts-expect-error V2 has no silently ignored parallel policy.
defineWorkflow({ ...options, scheduling: "parallel" });
// @ts-expect-error Graph declarations cannot be executed by the legacy executor.
workflow.execute;
// @ts-expect-error Deferred admission has no input values.
const invalidDeferred: GraphInvocationRequestV1 = { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "1d" }, values: { entry: 1 } };
void invalidDeferred;
// @ts-expect-error A map body must accept item/index/context, not a number.
graphMap({ id: "map", input: graphValue.literal({ items: [1], context: null }), inputContract: number, outputContract: number, body: workflow });
