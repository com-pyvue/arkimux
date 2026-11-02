import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineGraphValue, defineGraph, defineWorkflow, graphStep, graphSubgraph,
  graphMap, graphReduce, graphLoop, graphChoice, assertGraphCapabilitiesV1,
  defineStep, graphRef, graphValue, resolveGraphBindingV1,
  graphInstanceKeyV1, graphInstanceNodeV1, validateGraphInstanceAddressV1,
  type JsonValue, type ValueValidatorV1,
} from "../../core/src/index.ts";
import { graphDependenciesV1, graphNodeDetails } from "../../core/src/application/graphWorkflow.ts";

const numberSchema = { type: "number" };
const number = defineGraphValue({ version: "1", schema: numberSchema, validator: z.number() });
function step<I extends JsonValue, O extends JsonValue>(id: string, input: ValueValidatorV1<I>, output: ValueValidatorV1<O>) {
  return defineStep({ schemaVersion: 1, id, definitionVersion: "1", input, output,
    execute: vi.fn(async () => { throw new Error("Must not execute during declaration."); }) });
}
function numberNode(id: string, input = graphRef.workflowInput<number>()) {
  return graphStep({ id, input, step: step("reusable-number", z.number(), z.number()), inputSchema: numberSchema, outputSchema: numberSchema });
}
function numberBody() {
  const first = numberNode("first");
  return defineGraph({ id: "number-body", definitionVersion: "1", input: number, nodes: [first], entry: first, result: first });
}
function body<I extends JsonValue, O extends JsonValue>(id: string, input: z.ZodType<I>, output: z.ZodType<O>) {
  const leaf = graphStep({ id: "leaf", input: graphRef.workflowInput<I>(), step: step(id, input, output),
    inputSchema: z.toJSONSchema(input) as Record<string, JsonValue>, outputSchema: z.toJSONSchema(output) as Record<string, JsonValue> });
  return defineGraph({ id, definitionVersion: "1", input: leaf.inputContract, nodes: [leaf], entry: leaf, result: leaf });
}
function value<T extends JsonValue>(schema: z.ZodType<T>) {
  return defineGraphValue({ version: "1", schema: z.toJSONSchema(schema) as Record<string, JsonValue>, validator: schema });
}

describe("graph declarations", () => {
  it("derives edges from destination bindings, not node array order", () => {
    const first = numberNode("first");
    const second = numberNode("second", graphRef.output(first));
    const graph = defineWorkflow({ workflow: { kind: "example", version: 1 }, workflowContractVersion: "1", resultKind: "example.result",
      input: number, nodes: [second, first], entry: first, result: second });
    expect(graphDependenciesV1(graph, second)).toEqual([first]);
    expect(graph.output).toBe(second.outputContract);
    expect(graph.scheduling).toBe("serial");
    expect("execute" in graph).toBe(false);
    expect(graphNodeDetails(first).kind).toBe("step");
    expect((graphNodeDetails(first) as { step: { execute: unknown } }).step.execute).not.toHaveBeenCalled();
    const reordered = defineWorkflow({ workflow: graph.workflow, workflowContractVersion: "1", resultKind: graph.resultKind,
      input: number, nodes: [first, second], entry: first, result: second });
    expect(reordered.declarationSha256).toBe(graph.declarationSha256);
    const changedResult = defineWorkflow({ workflow: graph.workflow, workflowContractVersion: "1", resultKind: "example.changed-result",
      input: number, nodes: [first, second], entry: first, result: second });
    expect(changedResult.declarationSha256).not.toBe(graph.declarationSha256);
  });

  it("retains a finite user-facing invocation entry catalog in the workflow identity", () => {
    const first = numberNode("first");
    const second = numberNode("second", graphRef.output(first));
    const entries = [
      { id: "first", label: "Step 1", entry: { kind: "default" as const } },
      { id: "second", label: "Step 2", entry: { kind: "selected" as const,
        address: { schemaVersion: 1 as const, path: [{ nodeId: "second" }] } } },
    ];
    const graph = defineWorkflow({ workflow: { kind: "entry-catalog", version: 1 }, workflowContractVersion: "1",
      resultKind: "entry-catalog.result", input: number, nodes: [first, second], entry: first, result: second,
      invocationEntries: entries });
    entries[0]!.label = "Changed later";
    expect(graph.invocationEntries).toEqual([
      { id: "first", label: "Step 1", entry: { kind: "default" } },
      { id: "second", label: "Step 2", entry: { kind: "selected",
        address: { schemaVersion: 1, path: [{ nodeId: "second" }] } } },
    ]);
    const withoutCatalog = defineWorkflow({ workflow: graph.workflow, workflowContractVersion: "1",
      resultKind: graph.resultKind, input: number, nodes: [first, second], entry: first, result: second });
    expect(graph.declarationSha256).not.toBe(withoutCatalog.declarationSha256);
    expect(() => defineWorkflow({ workflow: graph.workflow, workflowContractVersion: "1", resultKind: graph.resultKind,
      input: number, nodes: [first, second], entry: first, result: second, invocationEntries: [] })).toThrow(/nonempty/);
    expect(() => defineWorkflow({ workflow: graph.workflow, workflowContractVersion: "1", resultKind: graph.resultKind,
      input: number, nodes: [first, second], entry: first, result: second,
      invocationEntries: [{ id: "same", label: "One", entry: { kind: "default" } },
        { id: "same", label: "Two", entry: { kind: "default" } }] })).toThrow(/Duplicate/);
    expect(() => defineWorkflow({ workflow: graph.workflow, workflowContractVersion: "1", resultKind: graph.resultKind,
      input: number, nodes: [first, second], entry: first, result: second,
      invocationEntries: [{ id: "missing", label: "Missing", entry: { kind: "selected",
        address: { schemaVersion: 1, path: [{ nodeId: "missing" }] } } }] })).toThrow(/outside the declared scope/);
  });

  it("uses actual step validators and independent placement identities", () => {
    const parser = vi.fn((v: unknown) => z.number().parse(v));
    const reusable = step("add-one", { parse: parser }, z.number());
    const first = graphStep({ id: "one", input: graphRef.workflowInput<number>(), step: reusable, inputSchema: numberSchema, outputSchema: numberSchema });
    const second = graphStep({ id: "two", input: graphRef.output(first), step: reusable, inputSchema: numberSchema, outputSchema: numberSchema });
    const graph = defineGraph({ id: "reused", definitionVersion: "1", input: number, nodes: [first, second], entry: first, result: second });
    expect(parser).not.toHaveBeenCalled();
    expect(first.input.parse(12)).toBe(12);
    expect(parser).toHaveBeenCalledWith(12);
    expect(() => second.input.parse("12")).toThrow();
    expect(graph.nodes.map((node) => node.id)).toEqual(["one", "two"]);
    expect(reusable.execute).not.toHaveBeenCalled();
  });

  it("adds ordering-only dependencies and explicitly required non-result work", () => {
    const first = numberNode("first");
    const sideEffect = graphStep({ id: "side-effect", step: step("side-effect", z.number(), z.number()), inputSchema: numberSchema,
      outputSchema: numberSchema, input: graphValue.literal(1), after: [first] });
    expect(() => defineGraph({ id: "graph", definitionVersion: "1", input: number, nodes: [first, sideEffect], entry: first, result: first })).toThrow(/unused/);
    const graph = defineGraph({ id: "graph", definitionVersion: "1", input: number, nodes: [first, sideEffect], entry: first, result: first, required: [sideEffect] });
    expect(graph.required).toEqual([first, sideEffect]);
    expect(graphDependenciesV1(graph, sideEffect)).toEqual([first]);
  });

  it("rejects missing, same-ID foreign references, duplicate nodes and dependent default entry", () => {
    const first = numberNode("first"), foreign = numberNode("first"), second = numberNode("second", graphRef.output(foreign));
    const options = { id: "graph", definitionVersion: "1", input: number, nodes: [first, second], entry: first, result: second };
    expect(() => defineGraph(options)).toThrow(/outside this scope/);
    expect(() => defineGraph({ ...options, nodes: [foreign, second], entry: second })).toThrow(/Default graph entry/);
    expect(() => defineGraph({ ...options, nodes: [first, foreign, second] })).toThrow(/Duplicate/);
    expect(() => defineGraph({ ...options, nodes: [second] })).toThrow(/outside/);
  });

  it("rejects unsupported policy and unknown extension fields instead of ignoring them", () => {
    const first = numberNode("first");
    const options = { workflow: { kind: "example", version: 1 }, workflowContractVersion: "1", resultKind: "example.result",
      input: number, nodes: [first], entry: first, result: first };
    expect(() => defineWorkflow({ ...options, scheduling: "parallel" } as never)).toThrow(/Unsupported/);
    expect(() => defineWorkflow({ ...options, concurrency: 4 } as never)).toThrow(/unknown fields/);
    expect(() => graphStep({ id: "bad", step: step("n", z.number(), z.number()), input: graphValue.literal(1), inputSchema: numberSchema,
      outputSchema: numberSchema, retry: { maxAttempts: 3 } } as never)).toThrow(/unknown fields/);
    expect(() => assertGraphCapabilitiesV1(defineWorkflow(options), ["graph.serial@1"])).toThrow(/Unsupported graph capabilities/);
    const graph = defineWorkflow(options);
    expect(() => assertGraphCapabilitiesV1(graph, graph.capabilities)).not.toThrow();
  });

  it("snapshots schemas and node lists without freezing caller data", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const contract = defineGraphValue({ version: "1", schema, validator: z.object({ name: z.string() }) });
    schema.properties.name.type = "number";
    expect(contract.schema).toMatchObject({ properties: { name: { type: "string" } } });
    const first = numberNode("first"), nodes = [first];
    const graph = defineGraph({ id: "graph", definitionVersion: "1", input: number, nodes, entry: first, result: first });
    nodes.length = 0;
    expect(graph.nodes).toHaveLength(1);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(() => defineGraphValue({ version: "1", schema: { $ref: "https://example.com/schema" }, validator: z.number() })).toThrow(/self-contained/);
    expect(() => defineGraphValue({ version: "1", schema: { $defs: { child: { $dynamicRef: "file:///secret" } } }, validator: z.number() })).toThrow(/self-contained/);
  });
});

describe("bindings", () => {
  it("combines node inputs, outputs, nested field paths and literals", () => {
    const first = numberNode("first");
    const binding = graphValue.object({ original: graphRef.input(first), output: graphRef.output(first), constant: graphValue.literal(null),
      path: graphValue.field(graphValue.field(graphRef.workflowInput<{ nested: { value: number } }>(), "nested"), "value") });
    expect(resolveGraphBindingV1(binding, { input: { nested: { value: 9 } }, completed: new Map([["first", { input: 10, output: 11 }]]) }))
      .toEqual({ original: 10, output: 11, constant: null, path: 9 });
  });
  it("distinguishes missing from null and cannot hide a failed dependency with fallback", () => {
    const binding = graphValue.field(graphRef.workflowInput<{ value: number | null }>(), "value", { fallback: 7 });
    expect(resolveGraphBindingV1(binding, { input: {}, completed: new Map() })).toBe(7);
    expect(resolveGraphBindingV1(binding, { input: { value: null }, completed: new Map() })).toBeNull();
    const required = graphValue.field(graphRef.workflowInput<{ value: number }>(), "value");
    expect(() => resolveGraphBindingV1(required, { input: {}, completed: new Map() })).toThrow(/missing/);
    const first = graphStep({ id: "first", step: step("first", z.number(), z.object({ value: z.number() })), input: graphValue.literal(1),
      inputSchema: numberSchema, outputSchema: { type: "object" } });
    const nodeFallback = graphValue.field(graphRef.output(first), "value", { fallback: 7 });
    expect(() => resolveGraphBindingV1(nodeFallback, { input: {}, completed: new Map() })).toThrow(/has not succeeded/);
    expect(() => resolveGraphBindingV1(graphRef.input(first), { input: {}, completed: new Map() })).toThrow(/has not succeeded/);
  });
  it("does not mistake user literal objects for reference declarations", () => {
    const literal = { kind: "node-output", node: "missing" };
    const binding = graphValue.literal(literal);
    literal.node = "changed";
    expect(resolveGraphBindingV1(binding, { input: null, completed: new Map() })).toEqual({ kind: "node-output", node: "missing" });
    expect(() => numberNode("forged", { kind: "graph-binding" } as never)).toThrow(/helpers/);
    expect(resolveGraphBindingV1(graphValue.array([graphValue.literal(1), graphValue.literal(2)]), { input: null, completed: new Map() })).toEqual([1, 2]);
  });
  it("rejects non-JSON values without evaluating accessors", () => {
    const getter = vi.fn(() => 3);
    const input = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    expect(() => graphValue.literal(input)).toThrow(/accessors/);
    expect(() => resolveGraphBindingV1(graphRef.workflowInput(), { input, completed: new Map() })).toThrow(/accessors/);
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => graphValue.literal(cyclic as JsonValue)).toThrow(/cycles/);
    expect(() => graphValue.literal(new Array(3))).toThrow(/dense/);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("structured controls", () => {
  it("reuses a subgraph with isolated references", () => {
    const shared = numberBody();
    const one = graphSubgraph({ id: "one", input: graphRef.workflowInput<number>(), body: shared });
    const two = graphSubgraph({ id: "two", input: graphRef.output(one), body: shared });
    const graph = defineGraph({ id: "nested", definitionVersion: "1", input: number, nodes: [one, two], entry: one, result: two });
    expect(graph.capabilities).toContain("graph.subgraph@1");
    const address = (nodeId: string) => ({ schemaVersion: 1 as const, path: [
      { nodeId, occurrence: { kind: "subgraph" as const } }, { nodeId: "first" },
    ] });
    expect(graphInstanceKeyV1(graph, { executionId: "run-1" }, address("one")))
      .not.toBe(graphInstanceKeyV1(graph, { executionId: "run-1" }, address("two")));
    const leaked = numberNode("leaked", graphRef.output(shared.result));
    expect(() => defineGraph({ id: "bad", definitionVersion: "1", input: number, nodes: [one, leaked], entry: one, result: leaked })).toThrow(/outside this scope/);
  });

  it("declares map, reduce and pre-test loops without calling callbacks", () => {
    const mapBody = body("map-body", z.object({ item: z.number(), index: z.number().int().nonnegative(), context: z.null() }), z.number());
    const mapInput = value(z.object({ items: z.array(z.number()), context: z.null() }));
    const map = graphMap({ id: "map", input: graphValue.literal({ items: [1, 2], context: null }), inputContract: mapInput,
      outputContract: value(z.array(z.number())), body: mapBody });
    const reduceBody = body("reduce-body", z.object({ item: z.number(), index: z.number().int().nonnegative(), accumulator: z.number(), context: z.null() }), z.number());
    const reduce = graphReduce({ id: "reduce", input: graphValue.object({ items: graphRef.output(map), initial: graphValue.literal(0), context: graphValue.literal(null) }),
      inputContract: value(z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() })), outputContract: number, body: reduceBody });
    const loopBody = body("loop-body", z.object({ state: z.number(), iteration: z.number().int().nonnegative(), context: z.null() }), z.number());
    const condition = vi.fn(() => false);
    const loop = graphLoop({ id: "loop", input: graphValue.object({ state: graphRef.output(reduce), context: graphValue.literal(null) }),
      inputContract: value(z.object({ state: z.number(), context: z.null() })), outputContract: number, body: loopBody, conditionVersion: "1", while: condition });
    const graph = defineGraph({ id: "controls", definitionVersion: "1", input: number, nodes: [loop, map, reduce], entry: map, result: loop });
    expect(graph.capabilities).toEqual(expect.arrayContaining(["graph.loop@1", "graph.map@1", "graph.reduce@1", "graph.step@1"]));
    expect(graphDependenciesV1(graph, loop)).toEqual([reduce]);
    expect(condition).not.toHaveBeenCalled();
    expect(map.input.parse({ items: [], context: null })).toEqual({ items: [], context: null });
    expect(() => map.input.parse({ items: ["wrong"], context: null })).toThrow();
  });

  it("encapsulates branch merge as a typed choice, without executing selection", () => {
    const select = vi.fn(() => "a");
    const choice = graphChoice({ id: "choice", input: graphRef.workflowInput<number>(), inputContract: number, outputContract: number,
      selectionVersion: "1", select, cases: { a: numberBody(), b: numberBody() } });
    const final = numberNode("final", graphRef.output(choice));
    const graph = defineGraph({ id: "conditional", definitionVersion: "1", input: number, nodes: [choice, final], entry: choice, result: final });
    expect(graphDependenciesV1(graph, final)).toEqual([choice]);
    expect(select).not.toHaveBeenCalled();
    expect(() => graphChoice({ id: "empty", input: graphRef.workflowInput<number>(), inputContract: number, outputContract: number,
      selectionVersion: "1", select, cases: {} })).toThrow(/named cases/);
  });

  it("supports nested controls and collision-free scoped addresses, not bare repeated IDs", () => {
    const item = body("item-body", z.object({ item: z.number(), index: z.number().int().nonnegative(), context: z.null() }), z.number());
    const map = graphMap({ id: "map", input: graphValue.literal({ items: [1, 2], context: null }),
      inputContract: value(z.object({ items: z.array(z.number()), context: z.null() })), outputContract: value(z.array(z.number())), body: item });
    const mapBody = defineGraph({ id: "map-body", definitionVersion: "1", input: number, nodes: [map], entry: map, result: map });
    const outer = graphSubgraph({ id: "outer", input: graphRef.workflowInput<number>(), body: mapBody });
    const graph = defineGraph({ id: "nested", definitionVersion: "1", input: number, nodes: [outer], entry: outer, result: outer });
    const address = (index: number) => ({ schemaVersion: 1 as const, path: [
      { nodeId: "outer", occurrence: { kind: "subgraph" as const } },
      { nodeId: "map", occurrence: { kind: "map" as const, index } }, { nodeId: "leaf" },
    ] });
    const first = graphInstanceKeyV1(graph, { executionId: "run-1" }, address(0));
    expect(graphInstanceKeyV1(graph, { executionId: "run-1" }, address(0))).toBe(first);
    expect(graphInstanceKeyV1(graph, { executionId: "run-1" }, address(1))).not.toBe(first);
    expect(graphInstanceKeyV1(graph, { executionId: "run-2" }, address(0))).not.toBe(first);
    expect(graphInstanceNodeV1(graph, address(0))).toBe(item.result);
    const firstItemScope = { schemaVersion: 1 as const, path: [
      { nodeId: "outer", occurrence: { kind: "subgraph" as const } },
      { nodeId: "map", occurrence: { kind: "map" as const, index: 0 } },
    ] };
    expect(validateGraphInstanceAddressV1(graph, firstItemScope)).toEqual(firstItemScope);
    expect(graphInstanceNodeV1(graph, firstItemScope)).toBe(map);
    expect(() => validateGraphInstanceAddressV1(graph, { schemaVersion: 1, path: [{ nodeId: "leaf" }] })).toThrow(/outside/);
    expect(() => validateGraphInstanceAddressV1(graph, address(-1))).toThrow(/non-negative/);
    expect(() => validateGraphInstanceAddressV1(graph, { ...address(0), attempt: 2 })).toThrow(/unknown fields/);
    const wrong = address(0) as unknown as { schemaVersion: number; path: unknown[] };
    wrong.path[1] = { nodeId: "map", occurrence: { kind: "loop", iteration: 0 } };
    expect(() => validateGraphInstanceAddressV1(graph, wrong)).toThrow(/does not match/);
  });

  it("resolves choice addresses and rejects undeclared cases and extra target context", () => {
    const choice = graphChoice({ id: "choice", input: graphRef.workflowInput<number>(), inputContract: number, outputContract: number,
      selectionVersion: "1", select: () => "a", cases: { a: numberBody(), b: numberBody() } });
    const graph = defineGraph({ id: "choices", definitionVersion: "1", input: number, nodes: [choice], entry: choice, result: choice });
    const address = (name: string) => ({ schemaVersion: 1 as const, path: [{ nodeId: "choice", occurrence: { kind: "choice" as const, case: name } }, { nodeId: "first" }] });
    expect(graphInstanceNodeV1(graph, address("b")).id).toBe("first");
    expect(() => validateGraphInstanceAddressV1(graph, address("missing"))).toThrow(/Unknown choice case/);
    const caseScope = { schemaVersion: 1 as const,
      path: [{ nodeId: "choice", occurrence: { kind: "choice" as const, case: "a" } }] };
    expect(validateGraphInstanceAddressV1(graph, caseScope)).toEqual(caseScope);
    expect(graphInstanceNodeV1(graph, caseScope)).toBe(choice);
    expect(() => validateGraphInstanceAddressV1(graph, { schemaVersion: 2, path: [{ nodeId: "choice" }] })).toThrow(/schemaVersion 1/);
  });
});
