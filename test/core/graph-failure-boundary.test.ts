import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineGraph, defineGraphValue, defineStep, defineWorkflow, graphMap, graphRef, graphStep,
} from "../../core/src/index.ts";
import {
  graphFailureBoundariesV1, graphFailureBoundaryRecordV1, graphFailureBoundaryV1,
  type GraphCatchHandlerInputV1, type GraphCleanupHandlerInputV1,
} from "../../core/src/application/graphFailureBoundary.ts";
import {
  defineGraphCatchPolicyV1, defineGraphCleanupPolicyV1, defineGraphRetryPolicyV1,
} from "../../core/src/application/graphFailurePolicy.ts";

const number = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });
const nullValue = z.null();

function placement() {
  const calculateStep = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1",
    input: z.number(), output: z.number(), execute: async (_context, input) => input + 1 });
  return graphStep({ id: "calculate", step: calculateStep, input: graphRef.workflowInput<number>(),
    inputSchema: { type: "number" }, outputSchema: { type: "number" } });
}

function fixture(withPolicies: boolean) {
  const calculate = placement();
  if (withPolicies) {
    const catchHandler = defineStep({ schemaVersion: 1, id: "recover-calculation", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1<number>>(), output: z.number(),
      execute: async (_context, value) => value.scope.input });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "release-calculation-resources", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: nullValue,
      execute: async () => null });
    graphFailureBoundaryV1({ placement: calculate, scope: "node-instance",
      retries: [defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-calculation",
        policyVersion: "1", scope: "node-instance", maxAttempts: 3,
        retryOn: ["external-provider"], exhaustion: "propagate-failure" })],
      catches: [{ policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover-calculation",
        policyVersion: "1", handlerDefinitionId: "recover-calculation", failures: [{ class: "external-provider" }],
        output: number, afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: catchHandler }],
      cleanup: [{ policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup",
        policyId: "release-calculation-resources", policyVersion: "1", handlerDefinitionId: "release-calculation-resources",
        triggers: ["success", "failure", "cancellation"], execution: "once-per-scope-outcome",
        failureMode: "fail-run-preserve-original" }), handler: cleanupHandler }],
    });
  }
  return { calculate, graph: defineWorkflow({ workflow: { kind: "failure-boundary-test", version: 1 },
    workflowContractVersion: "1", resultKind: "failure-boundary-test.result", input: number,
    nodes: [calculate], entry: calculate, result: calculate }) };
}

describe("private graph failure boundary attachment", () => {
  it("pins attached policies and retained handler definitions in the graph declaration", () => {
    const plain = fixture(false);
    const retained = fixture(true);
    expect(retained.graph.declarationSha256).not.toBe(plain.graph.declarationSha256);
    expect(retained.graph.capabilities).toEqual(expect.arrayContaining([
      "graph.failure-envelope@1", "graph.retry.node-instance@1", "graph.catch.after-retry@1",
      "graph.catch.recovery-output@1", "graph.cleanup.once-per-scope-outcome@1",
      "graph.cleanup.outcome-trigger@1",
    ]));
    const [record] = graphFailureBoundaryRecordV1(retained.calculate) as Array<Record<string, unknown>>;
    expect(record.scope).toBe("node-instance");
    expect(JSON.stringify(record)).toContain("recover-calculation");
    expect(JSON.stringify(record)).toContain("definitionSha256");
    expect(graphFailureBoundariesV1(retained.calculate)).toHaveLength(1);
  });

  it("rejects ambiguous scopes and handler contracts before graph construction", () => {
    const calculate = placement();
    const retry = defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-node",
      policyVersion: "1", scope: "node-instance", maxAttempts: 2, retryOn: ["workflow"], exhaustion: "propagate-failure" });
    expect(() => graphFailureBoundaryV1({ placement: calculate, scope: "map-item", retries: [retry] }))
      .toThrow(/requires a map placement/);
    const loopRetry = defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-loop",
      policyVersion: "1", scope: "loop-instance", maxAttempts: 2, retryOn: ["workflow"], exhaustion: "propagate-failure" });
    expect(() => graphFailureBoundaryV1({ placement: calculate, scope: "node-instance", retries: [
      loopRetry,
    ] })).toThrow(/scope differs/);
    expect(() => graphFailureBoundaryV1({ placement: calculate, scope: "node-instance", retries: [
      { ...retry, policyId: "forged" },
    ] })).toThrow(/helpers/);

    const wrongHandler = defineStep({ schemaVersion: 1, id: "wrong-handler", definitionVersion: "1",
      input: z.unknown().transform(() => null), output: z.number(), execute: async () => 1 });
    const catchPolicy = defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover",
      policyVersion: "1", handlerDefinitionId: "expected-handler", failures: [{ class: "workflow" }],
      output: number, afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" });
    expect(() => graphFailureBoundaryV1({ placement: calculate, scope: "node-instance",
      catches: [{ policy: catchPolicy, handler: wrongHandler }] })).toThrow(/definition ID differs/);

    const itemInput = defineGraphValue({ version: "1", schema: { type: "object" },
      validator: z.object({ item: z.number(), index: z.number(), context: z.null() }) });
    const itemStep = graphStep({ id: "item", input: graphRef.workflowInput<{ item: number; index: number; context: null }>(),
      step: defineStep({ schemaVersion: 1, id: "item", definitionVersion: "1", input: itemInput.validator,
        output: z.number(), execute: async (_context, value) => value.item }),
      inputSchema: itemInput.schema, outputSchema: number.schema });
    const body = defineGraph({ id: "item-body", definitionVersion: "1",
      input: itemInput, nodes: [itemStep], entry: itemStep, result: itemStep });
    const map = graphMap({ id: "items", input: graphRef.workflowInput<{ items: number[]; context: null }>(),
      inputContract: defineGraphValue({ version: "1", schema: { type: "object" },
        validator: z.object({ items: z.array(z.number()), context: z.null() }) }),
      outputContract: defineGraphValue({ version: "1", schema: { type: "array" }, validator: z.array(z.number()) }), body });
    expect(() => graphFailureBoundaryV1({ placement: map, scope: "node-instance", retries: [retry] }))
      .toThrow(/requires a step placement/);
    const recoverItem = defineStep({ schemaVersion: 1, id: "recover-item", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1>(), output: z.number(), execute: async () => 1 });
    expect(() => graphFailureBoundaryV1({ placement: map, scope: "map-item", catches: [{
      policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover-item",
        policyVersion: "1", handlerDefinitionId: "recover-item", failures: [{ class: "workflow" }],
        output: number, afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }),
      handler: recoverItem,
    }] })).not.toThrow();
  });

  it("cannot mutate failure policy metadata after the graph hash is frozen", () => {
    const { calculate } = fixture(false);
    const retry = defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "late-retry",
      policyVersion: "1", scope: "node-instance", maxAttempts: 2,
      retryOn: ["workflow"], exhaustion: "propagate-failure" });
    expect(() => graphFailureBoundaryV1({ placement: calculate, scope: "node-instance", retries: [retry] }))
      .toThrow(/before graph construction/);
  });
});
