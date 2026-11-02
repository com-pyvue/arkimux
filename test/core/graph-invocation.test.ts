import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  admitGraphInvocationV1, defineGraph, defineGraphValue, defineStep, describeGraphEntryV1,
  graphChoice, graphLoop, graphMap, graphReduce, graphRef, graphStep, graphSubgraph, graphValue,
  restoreGraphEntryPlanV1, validateGraphEntryBoundaryV1, type GraphEntryPlanV1, type GraphInstanceSegmentV1, type JsonValue,
} from "../../core/src/index.ts";

const schema = <T extends JsonValue>(validator: z.ZodType<T>) => defineGraphValue({
  version: "1", schema: z.toJSONSchema(validator), validator,
});
const number = schema(z.number());
const step = <I extends JsonValue, O extends JsonValue>(id: string, input: z.ZodType<I>, output: z.ZodType<O>) => defineStep({
  schemaVersion: 1, id, definitionVersion: "1", input, output,
  execute: vi.fn(async () => { throw new Error("Entry planning must not execute steps."); }),
});
const node = (id: string, input = graphRef.workflowInput<number>()) => graphStep({
  id, input, step: step(id, z.number(), z.number()), inputSchema: { type: "number" }, outputSchema: { type: "number" },
});
const address = (...path: GraphInstanceSegmentV1[]) => ({ schemaVersion: 1 as const, path });
const valuesFor = (plan: GraphEntryPlanV1, overrides: Record<string, JsonValue> = {}) => Object.fromEntries(
  plan.requirements.map((item) => [item.id, overrides[item.id] ?? defaultValue(item.role)]),
);
function defaultValue(role: string): JsonValue {
  if (role === "map-completed-outputs") return [];
  if (role === "loop-iteration") return 0;
  return 10;
}

describe("graph invocation admission", () => {
  it("uses the workflow input for default entry in supplied and deferred modes", () => {
    const first = node("first"), second = node("second", graphRef.output(first));
    const graph = defineGraph({ id: "chain", definitionVersion: "1", input: number, nodes: [second, first], entry: first, result: second });
    const deferred = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "1d" } });
    expect(deferred.acquisition).toBe("deferred");
    expect(deferred.plan.entry.path).toEqual([{ nodeId: "first" }]);
    expect(deferred.plan.requirements.map((item) => [item.id, item.role])).toEqual([["entry", "entry-input"]]);
    const supplied = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied", entry: { kind: "default" }, values: { entry: 3 } });
    expect(supplied.acquisition).toBe("supplied");
    expect(supplied.plan.planSha256).toBe(deferred.plan.planSha256);
    if (supplied.acquisition === "supplied") expect(supplied.boundary.values.entry).toBe(3);
  });

  it("validates selected input directly and does not request its skipped binding inputs", () => {
    const first = node("first"), second = node("second", graphRef.output(first));
    const graph = defineGraph({ id: "chain", definitionVersion: "1", input: number, nodes: [first, second], entry: first, result: second });
    const plan = describeGraphEntryV1(graph, { kind: "selected", address: address({ nodeId: "second" }) });
    expect(plan.requirements.map((item) => item.id)).toEqual(["entry"]);
    expect(plan.continuation).toEqual([{ scopePath: [], nodeIds: ["second"] }]);
    expect(() => validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256, values: { entry: "bad" } })).toThrow(/entry is invalid/);
    expect(validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256, values: { entry: 7 } }).values.entry).toBe(7);
  });

  it("requires skipped values needed after the selected node and records caller provenance", () => {
    const first = node("first");
    const selected = node("selected", graphRef.output(first));
    const resultInput = z.object({ chosen: z.number(), earlierInput: z.number(), earlierOutput: z.number(), root: z.number() });
    const result = graphStep({ id: "result", step: step("result", resultInput, z.number()),
      inputSchema: z.toJSONSchema(resultInput), outputSchema: { type: "number" }, input: graphValue.object({
        chosen: graphRef.output(selected), earlierInput: graphRef.input(first), earlierOutput: graphRef.output(first), root: graphRef.workflowInput<number>(),
      }) });
    const graph = defineGraph({ id: "join", definitionVersion: "1", input: number, nodes: [first, selected, result], entry: first, result });
    const plan = describeGraphEntryV1(graph, { kind: "selected", address: address({ nodeId: "selected" }) });
    expect(plan.requirements.map((item) => [item.id, item.role])).toEqual([
      ["entry", "entry-input"], ["node/first/input", "skipped-node-input"],
      ["node/first/output", "skipped-node-output"], ["scope/root", "root-scope-input"],
    ]);
    expect(plan.requirements.every((item) => item.provenance === "caller-supplied")).toBe(true);
    const accepted = validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256,
      values: valuesFor(plan, { entry: 2, "node/first/input": 1, "node/first/output": 2, "scope/root": 1 }) });
    expect(accepted.values["node/first/output"]).toBe(2);
    expect(() => validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256,
      values: { entry: 2, "node/first/input": 1, "scope/root": 1 } })).toThrow(/missing/);
  });

  it("rejects selected paths that would fabricate ordering success", () => {
    const first = node("first"), selected = node("selected", graphRef.output(first));
    const result = graphStep({ id: "result", step: step("result", z.number(), z.number()), inputSchema: { type: "number" },
      outputSchema: { type: "number" }, input: graphRef.output(selected), after: [first] });
    const graph = defineGraph({ id: "ordered", definitionVersion: "1", input: number, nodes: [first, selected, result], entry: first, result });
    expect(() => describeGraphEntryV1(graph, { kind: "selected", address: address({ nodeId: "selected" }) })).toThrow(/fabricate successful ordering/);
  });

  it("rejects a selected node that cannot reach the result", () => {
    const first = node("first"), side = node("side"), result = node("result", graphRef.output(first));
    const graph = defineGraph({ id: "required", definitionVersion: "1", input: number, nodes: [first, side, result], entry: first, result, required: [side] });
    expect(() => describeGraphEntryV1(graph, { kind: "selected", address: address({ nodeId: "side" }) })).toThrow(/cannot reach/);
  });

  it("pins the plan and rejects unknown fields or implicit mode changes", () => {
    const first = node("first"), graph = defineGraph({ id: "one", definitionVersion: "1", input: number, nodes: [first], entry: first, result: first });
    const plan = describeGraphEntryV1(graph, { kind: "default" });
    expect(() => validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: "wrong", values: { entry: 1 } })).toThrow(/does not match/);
    expect(() => admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied", entry: { kind: "default" } })).toThrow(/missing/);
    expect(() => admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "1d" }, values: { entry: 1 } })).toThrow(/unknown/);
    expect(() => admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "other", entry: { kind: "default" } })).toThrow(/supplied or deferred/);
    expect(() => admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" } })).toThrow(/missing/);
    expect(() => admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "367d" } })).toThrow(/366 days/);
    expect(() => admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied", entry: { kind: "default" },
      wait: { duration: "1d" }, values: { entry: 1 } })).toThrow(/unknown/);
    expect(() => describeGraphEntryV1(graph, { kind: "selected", address: address({ nodeId: "missing" }) })).toThrow(/outside/);
  });

  it("restores deferred validation from retained JSON and rejects a changed graph", () => {
    const first = node("first"), graph = defineGraph({ id: "one", definitionVersion: "1", input: number, nodes: [first], entry: first, result: first });
    const saved = structuredClone(describeGraphEntryV1(graph, { kind: "default" }));
    const restored = restoreGraphEntryPlanV1(graph, saved);
    expect(validateGraphEntryBoundaryV1(restored, { schemaVersion: 1, planSha256: restored.planSha256, values: { entry: 1 } }).values.entry).toBe(1);
    const changedNode = node("changed"), changed = defineGraph({ id: "one", definitionVersion: "2", input: number,
      nodes: [changedNode], entry: changedNode, result: changedNode });
    expect(() => restoreGraphEntryPlanV1(changed, saved)).toThrow(/does not match/);
    expect(() => restoreGraphEntryPlanV1(graph, { ...saved, unknown: true })).toThrow(/unknown/);
  });

  it("keeps default required roots and creates an order-independent plan", () => {
    const first = node("first"), side = node("side"), result = node("result", graphRef.output(first));
    const options = { id: "required", definitionVersion: "1", input: number, entry: first, result, required: [side] };
    const one = defineGraph({ ...options, nodes: [first, side, result] });
    const two = defineGraph({ ...options, nodes: [result, side, first] });
    const firstPlan = describeGraphEntryV1(one, { kind: "default" });
    const secondPlan = describeGraphEntryV1(two, { kind: "default" });
    expect(firstPlan.continuation[0].nodeIds).toEqual(["first", "result", "side"]);
    expect(firstPlan.planSha256).toBe(secondPlan.planSha256);
  });
});

describe("scoped selected entry", () => {
  const bodyGraph = <I extends JsonValue, O extends JsonValue>(id: string, input: z.ZodType<I>, output: z.ZodType<O>) => {
    const first = graphStep({ id: "body-first", step: step(`${id}-first`, input, output), inputSchema: z.toJSONSchema(input),
      outputSchema: z.toJSONSchema(output), input: graphRef.workflowInput<I>() });
    const later = graphStep({ id: "body-later", step: step(`${id}-later`, output, output), inputSchema: z.toJSONSchema(output),
      outputSchema: z.toJSONSchema(output), input: graphRef.output(first) });
    return defineGraph({ id, definitionVersion: "1", input: first.inputContract, nodes: [first, later], entry: first, result: later });
  };

  it("pins subgraph and choice scope without executing the choice selector", () => {
    const body = bodyGraph("nested-body", z.number(), z.number());
    const subgraph = graphSubgraph({ id: "subgraph", input: graphRef.workflowInput<number>(), body });
    const subgraphGraph = defineGraph({ id: "subgraph-root", definitionVersion: "1", input: number,
      nodes: [subgraph], entry: subgraph, result: subgraph });
    const subgraphPlan = describeGraphEntryV1(subgraphGraph, { kind: "selected", address: address(
      { nodeId: "subgraph", occurrence: { kind: "subgraph" } }, { nodeId: "body-later" }) });
    expect(subgraphPlan.requirements.map((item) => [item.id, item.role])).toEqual([
      ["control/subgraph@subgraph/input", "control-input"], ["entry", "entry-input"],
    ]);
    expect(validateGraphEntryBoundaryV1(subgraphPlan, { schemaVersion: 1, planSha256: subgraphPlan.planSha256,
      values: { "control/subgraph@subgraph/input": 3, entry: 4 } }).values.entry).toBe(4);

    const select = vi.fn(() => "chosen");
    const choice = graphChoice({ id: "choice", input: graphRef.workflowInput<number>(), inputContract: number,
      outputContract: number, selectionVersion: "1", select, cases: { chosen: body } });
    const choiceGraph = defineGraph({ id: "choice-root", definitionVersion: "1", input: number,
      nodes: [choice], entry: choice, result: choice });
    const choicePlan = describeGraphEntryV1(choiceGraph, { kind: "selected", address: address(
      { nodeId: "choice", occurrence: { kind: "choice", case: "chosen" } }, { nodeId: "body-later" }) });
    expect(choicePlan.requirements.map((item) => [item.id, item.role])).toEqual([
      ["control/choice@choice=chosen/input", "control-input"], ["entry", "entry-input"],
    ]);
    expect(validateGraphEntryBoundaryV1(choicePlan, { schemaVersion: 1, planSha256: choicePlan.planSha256,
      values: { "control/choice@choice=chosen/input": 3, entry: 4 } }).values.entry).toBe(4);
    expect(select).not.toHaveBeenCalled();
  });

  it("describes map progress, selected input, and parent continuation", () => {
    const bodyInput = z.object({ item: z.number(), index: z.number().int(), context: z.string() });
    const body = bodyGraph("map-body", bodyInput, z.number());
    const mapInput = z.object({ items: z.array(z.number()), context: z.string() });
    const map = graphMap({ id: "map", input: graphRef.workflowInput(), inputContract: schema(mapInput), outputContract: schema(z.array(z.number())), body });
    const result = graphStep({ id: "result", step: step("map-result", z.array(z.number()), z.array(z.number())),
      inputSchema: { type: "array" }, outputSchema: { type: "array" }, input: graphRef.output(map) });
    const graph = defineGraph({ id: "mapped", definitionVersion: "1", input: schema(mapInput), nodes: [map, result], entry: map, result });
    expect(() => describeGraphEntryV1(graph, { kind: "selected",
      address: address({ nodeId: "map", occurrence: { kind: "map", index: 1 } }) })).toThrow(/no target node/);
    const selected = address({ nodeId: "map", occurrence: { kind: "map", index: 1 } }, { nodeId: "body-later" });
    const plan = describeGraphEntryV1(graph, { kind: "selected", address: selected });
    expect(plan.requirements.map((item) => [item.id, item.role])).toEqual([
      ["control/map@map=1/completed", "map-completed-outputs"], ["control/map@map=1/input", "control-input"], ["entry", "entry-input"],
    ]);
    expect(plan.continuation).toEqual([
      { scopePath: selected.path.slice(0, 1), nodeIds: ["body-later"] }, { scopePath: [], nodeIds: ["map", "result"] },
    ]);
    const valid = { entry: 12, "control/map@map=1/input": { items: [10, 11, 12], context: "c" }, "control/map@map=1/completed": [10] };
    expect(validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256, values: valid }).values.entry).toBe(12);
    expect(() => validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256,
      values: { ...valid, "control/map@map=1/completed": [] } })).toThrow(/completed/);
    expect(() => validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256,
      values: { ...valid, "control/map@map=1/input": { items: [10], context: "c" } } })).toThrow(/outside/);
  });

  it("requires current reduce accumulator and loop iteration", () => {
    const reduceInput = z.object({ item: z.number(), index: z.number().int(), accumulator: z.number(), context: z.null() });
    const reduceBody = bodyGraph("reduce-body", reduceInput, z.number());
    const reduceContract = schema(z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() }));
    const reduce = graphReduce({ id: "reduce", input: graphRef.workflowInput(), inputContract: reduceContract, outputContract: number, body: reduceBody });
    const reduceGraph = defineGraph({ id: "reduce-graph", definitionVersion: "1", input: reduceContract, nodes: [reduce], entry: reduce, result: reduce });
    const reducePlan = describeGraphEntryV1(reduceGraph, { kind: "selected", address: address(
      { nodeId: "reduce", occurrence: { kind: "reduce", index: 2 } }, { nodeId: "body-later" }) });
    expect(reducePlan.requirements.map((item) => item.role)).toEqual(["reduce-accumulator", "control-input", "entry-input"]);
    expect(() => validateGraphEntryBoundaryV1(reducePlan, { schemaVersion: 1, planSha256: reducePlan.planSha256,
      values: valuesFor(reducePlan, { entry: 4, "control/reduce@reduce=2/input": { items: [1, 2], initial: 0, context: null },
        "control/reduce@reduce=2/accumulator": 3 }) })).toThrow(/outside/);

    const loopInput = z.object({ state: z.number(), iteration: z.number().int(), context: z.null() });
    const loopBody = bodyGraph("loop-body", loopInput, z.number());
    const controlInput = schema(z.object({ state: z.number(), context: z.null() }));
    const loop = graphLoop({ id: "loop", input: graphRef.workflowInput(), inputContract: controlInput, outputContract: number,
      body: loopBody, conditionVersion: "1", while: () => true });
    const loopGraph = defineGraph({ id: "loop-graph", definitionVersion: "1", input: controlInput, nodes: [loop], entry: loop, result: loop });
    const loopPlan = describeGraphEntryV1(loopGraph, { kind: "selected", address: address(
      { nodeId: "loop", occurrence: { kind: "loop", iteration: 3 } }, { nodeId: "body-later" }) });
    expect(loopPlan.requirements.map((item) => item.role)).toEqual(["control-input", "loop-iteration", "entry-input"]);
    const loopValues = valuesFor(loopPlan, { entry: 8, "control/loop@loop=3/input": { state: 7, context: null }, "control/loop@loop=3/iteration": 3 });
    expect(validateGraphEntryBoundaryV1(loopPlan, { schemaVersion: 1, planSha256: loopPlan.planSha256, values: loopValues }).values.entry).toBe(8);
    expect(() => validateGraphEntryBoundaryV1(loopPlan, { schemaVersion: 1, planSha256: loopPlan.planSha256,
      values: { ...loopValues, "control/loop@loop=3/iteration": 2 } })).toThrow(/match/);
  });
});
