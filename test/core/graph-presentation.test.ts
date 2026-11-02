import { expect, it, vi } from "vitest";
import { z } from "zod";
import { defineGraphValue, defineGraph, defineStep, defineWorkflow, graphStep, graphChoice, graphSubgraph,
  graphRef, graphValue, describeGraphV1, describeGraphEntryPresentationV1 } from "../../core/src/index.ts";
import { defineGraphInvocationWorkflow } from "../../cli/scaffold/workflows/graph-invocation/src/workflow.ts";
import { graphDescriptionSchema, graphEntryPresentationSchema } from "../../apps/packages/run/contract/src/graphDescription.ts";

it("exports data, ordering, and nested graph structure without executing workflow callbacks", () => {
  const execute = vi.fn(async (_context, input: number) => input), parse = vi.fn((v: unknown) => z.number().parse(v));
  const contract = defineGraphValue({ version: "1", schema: { type: "number", description: "A number", examples: [2] }, validator: { parse } });
  const step = defineStep({ schemaVersion: 1, id: "identity", definitionVersion: "1", input: { parse }, output: { parse }, execute });
  const make = (id: string, input = graphRef.workflowInput<number>(), after: ReturnType<typeof graphStep<number, number>>[] = []) => graphStep({ id, step, input, after,
    inputSchema: contract.schema, outputSchema: contract.schema });
  const leaf = make("leaf");
  const body = defineGraph({ id: "body", definitionVersion: "1", input: contract, nodes: [leaf], entry: leaf, result: leaf });
  const first = make("first"), select = vi.fn(() => "one");
  const choice = graphChoice({ id: "choice", input: graphRef.output(first), inputContract: contract, outputContract: contract,
    selectionVersion: "1", select, cases: { one: body, two: body } });
  const subgraph = graphSubgraph({ id: "nested", input: graphRef.output(choice), body });
  const last = make("last", graphValue.field(graphValue.object({ chosen: graphRef.output(subgraph), other: graphRef.output(first) }), "chosen"), [first]);
  const secretLiteral = make("literal", graphValue.literal(123456));
  const graph = defineWorkflow({ workflow: { kind: "visual", version: 1 }, workflowContractVersion: "1", resultKind: "visual.result",
    input: contract, nodes: [last, secretLiteral, choice, subgraph, first], entry: first, result: last, required: [secretLiteral] });
  const description = describeGraphV1(graph);
  expect(graphDescriptionSchema.parse(description)).toEqual(description);
  expect(description.scopes).toHaveLength(4);
  expect(description.nodes.filter(node => node.nodeId === "leaf").map(node => node.id)).toEqual([
    "root/node/choice/body/one/node/leaf", "root/node/choice/body/two/node/leaf", "root/node/nested/body/node/leaf",
  ]);
  expect(description.edges).toContainEqual(expect.objectContaining({ source: "root/node/first", target: "root/node/last", kind: "order" }));
  expect(description.edges).toContainEqual(expect.objectContaining({ source: "root/node/first", target: "root/node/last", kind: "data" }));
  expect(description.edges).toContainEqual(expect.objectContaining({ source: "root/node/choice", target: "root/node/nested", kind: "data" }));
  expect(JSON.stringify(description)).not.toContain("123456");
  expect(execute).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  expect(Object.isFrozen(description.nodes)).toBe(true);
});

it("maps the six Map item 2 fields onto the same graph and continuation used by execution", () => {
  const graph = defineGraphInvocationWorkflow();
  const description = describeGraphV1(graph);
  const selected = graph.invocationEntries!.find(entry => entry.id === "map-item-1")!;
  const view = describeGraphEntryPresentationV1(graph, selected.entry);
  expect(graphEntryPresentationSchema.parse(view)).toEqual(view);
  expect(view.selectedNodeId).toBe("root/node/map/body/node/map-item");
  expect(view.scopes).toContainEqual({ scopeId: "root", activeNodeIds: ["root/node/join-result", "root/node/loop", "root/node/map", "root/node/reduce"] });
  expect(view.requirementTargets).toHaveLength(6);
  expect(view.requirementTargets).toContainEqual({ requirementId: "control/map@map=1/completed", nodeId: "root/node/map", port: "state" });
  expect(view.requirementTargets).toContainEqual({ requirementId: "entry", nodeId: view.selectedNodeId, port: "input" });
  expect(view.requirementTargets.every(target => description.nodes.some(node => node.id === target.nodeId))).toBe(true);
  expect(description.edges).toContainEqual(expect.objectContaining({ source: "root/node/step2", target: "root/node/join-result",
    sourcePort: "input", sourcePath: ["input1"], targetPath: ["input1"] }));
  expect(description.nodes.some(node => node.kind === "loop" && node.bodyScopeIds.length === 1)).toBe(true);
  expect(describeGraphEntryPresentationV1(graph, { kind: "default" }).requirementTargets).toEqual([
    { requirementId: "entry", nodeId: "root/input", port: "input" },
  ]);
});
