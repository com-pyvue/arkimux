import assert from "node:assert/strict";
import { test } from "node:test";
import { admitGraphInvocationV1, describeGraphEntryV1 } from "@com-pyvue/agent-execution-core";
import { graphInputSchema, graphResultSchema, step2InputSchema } from "../workflows/graph-invocation/src/contract.js";
import { constructGraphInvocationWorkflow } from "../workflows/graph-invocation/src/workflow.js";
import { graphFixtureSelection, graphFixtureValues } from "../scripts/graph-fixture.js";

test("graph fixture declares the exact public validators and expected controls", () => {
  const { graph, agentPrompts } = constructGraphInvocationWorkflow();
  const input = graphInputSchema.parse({ schemaVersion: 1, value: 1, values: [1], mode: "double", loopUntil: 1 });
  assert.deepEqual(graph.input.validator.parse(input), input);
  assert.deepEqual(agentPrompts, {});
  assert.equal(graph.workflow.kind, "graph-invocation");
  assert.equal(graph.result.id, "join-result");
  assert.deepEqual([...new Set(graph.nodes.map(node => node.kind))].sort(), ["choice", "loop", "map", "reduce", "step"]);
  const result = graphResultSchema.parse({ schemaVersion: 1, input1: input,
    output1: { original: 1, incremented: 2 }, output2: { input1: { schemaVersion: 1, value: 1, values: [1], mode: "double", loopUntil: 1 }, output1: { original: 1, incremented: 2 }, base: 2, mode: "double" },
    branch: { selected: "double", value: 4 }, mapped: [5], reduced: 5, looped: 5 });
  assert.deepEqual(graph.output.validator.parse(result), result);
});

test("Step 1, Step 2, and scoped map entry accept supplied or deferred input", async () => {
  const { graph } = constructGraphInvocationWorkflow();
  for (const entry of ["step1", "step2", "map-item-1"] as const) {
    const selection = graphFixtureSelection(entry), values = await graphFixtureValues(entry);
    const plan = describeGraphEntryV1(graph, selection);
    assert.deepEqual(plan.requirements.map(item => item.id), Object.keys(values).sort());
    assert.equal(admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied", entry: selection, values }).acquisition, "supplied");
    assert.equal(admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: selection, wait: { duration: "1d" } }).acquisition, "deferred");
  }
  assert.equal(step2InputSchema.parse((await graphFixtureValues("step2")).entry).output1.incremented, 11);
});
