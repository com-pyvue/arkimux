import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as publicCore from "../../core/src/index.ts";
import {
  assertGraphPolicyCapabilitiesV1, defineGraphCatchPolicyV1, defineGraphCleanupPolicyV1,
  defineGraphRetryPolicyV1, graphPolicyCapabilitiesV1, validateGraphCleanupRecordV1,
  resolveGraphCleanupOutcomeV1, selectGraphFailureActionV1, validateGraphFailureEnvelopeV1,
  validateGraphRecoveryRecordV1,
} from "../../core/src/application/graphFailurePolicy.ts";
import { defineGraph, defineGraphValue, defineStep, graphMap, graphRef, graphStep, graphSubgraph } from "../../core/src/index.ts";

const number = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });
const implementation = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1",
  input: z.number(), output: z.number(), execute: vi.fn(async () => 1) });
const placement = graphStep({ id: "calculate", step: implementation, input: graphRef.workflowInput<number>(),
  inputSchema: { type: "number" }, outputSchema: { type: "number" } });
const graph = defineGraph({ id: "failure-test", definitionVersion: "1", input: number,
  nodes: [placement], entry: placement, result: placement });
const scopeAddress = { schemaVersion: 1 as const, path: [{ nodeId: "calculate" }] };
const at = "2026-09-18T10:00:00.000Z";
const failure = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, failureId: "failure-1", class: "workflow", code: "invalid-output",
  message: "The workflow output is invalid.", retryability: "not-retryable",
  instance: { address: { schemaVersion: 1, path: [{ nodeId: "calculate" }] }, attempt: 1 },
  occurredAt: at, ...overrides,
});

describe("graph failure policy extension contract", () => {
  it("retains a structured failure and preserves an exact external diagnostic", () => {
    const external = validateGraphFailureEnvelopeV1(graph, failure({ class: "external-provider",
      code: "provider-failed", message: "Provider said no.", retryability: "retryable",
      externalDiagnostic: { origin: "external", provider: "example", message: "Provider said no.", code: "denied", httpStatus: 429 } }));
    expect(external.externalDiagnostic).toEqual({ origin: "external", provider: "example",
      message: "Provider said no.", code: "denied", httpStatus: 429 });
    expect(external.instance.attempt).toBe(1);
    expect(() => validateGraphFailureEnvelopeV1(graph, failure({ class: "external-provider",
      externalDiagnostic: { origin: "external", provider: "example", message: "Different." } }))).toThrow(/message differs/);
    expect(() => validateGraphFailureEnvelopeV1(graph, failure({ stack: "private" }))).toThrow(/unknown/);
  });

  it("uses explicit retry scope and never treats cancellation as a retry class", () => {
    const retry = defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-map-item",
      policyVersion: "1", scope: "map-item", maxAttempts: 3,
      retryOn: ["external-provider", "workflow"], exhaustion: "propagate-failure" });
    expect(retry.retryOn).toEqual(["external-provider", "workflow"]);
    expect(graphPolicyCapabilitiesV1(retry)).toEqual(["graph.failure-envelope@1", "graph.retry.map-item@1"]);
    expect(() => assertGraphPolicyCapabilitiesV1(retry, [])).toThrow(/Unsupported/);
    expect(() => assertGraphPolicyCapabilitiesV1(retry, graphPolicyCapabilitiesV1(retry))).not.toThrow();
    expect(() => defineGraphRetryPolicyV1({ ...retry, maxAttempts: 1 })).toThrow(/greater than one/);
    expect(() => defineGraphRetryPolicyV1({ ...retry, retryOn: ["cancelled"] })).toThrow(/failure classes/);
  });

  it("tries the closest eligible retry, then catch, then propagation", () => {
    const outerPlacement = graphSubgraph({ id: "outer", input: graphRef.workflowInput<number>(), body: graph });
    const nestedGraph = defineGraph({ id: "nested-failure-test", definitionVersion: "1", input: number,
      nodes: [outerPlacement], entry: outerPlacement, result: outerPlacement });
    const outerScopeAddress = { schemaVersion: 1 as const, path: [{ nodeId: "outer" }] };
    const nestedNodeAddress = { schemaVersion: 1 as const, path: [
      { nodeId: "outer", occurrence: { kind: "subgraph" as const } }, { nodeId: "calculate" },
    ] };
    const inner = defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-node",
      policyVersion: "1", scope: "node-instance", maxAttempts: 2,
      retryOn: ["workflow"], exhaustion: "propagate-failure" });
    const outer = defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-loop",
      policyVersion: "1", scope: "subgraph-instance", maxAttempts: 3,
      retryOn: ["workflow"], exhaustion: "propagate-failure" });
    const recovery = defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover",
      policyVersion: "1", handlerDefinitionId: "recover-output", failures: [{ class: "workflow" }],
      output: number, afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" });
    const retained = validateGraphFailureEnvelopeV1(nestedGraph, failure({ retryability: "retryable",
      instance: { address: nestedNodeAddress, attempt: 1 } }));
    expect(selectGraphFailureActionV1(nestedGraph, retained, [
      { policy: inner, scopeAddress: nestedNodeAddress, currentAttempt: 1 },
      { policy: outer, scopeAddress: outerScopeAddress, currentAttempt: 1 },
    ], [{ policy: recovery, scopeAddress: outerScopeAddress }])).toEqual({ kind: "retry", policyId: "retry-node",
      scope: "node-instance", scopeAddress: nestedNodeAddress, nextAttempt: 2 });
    expect(selectGraphFailureActionV1(nestedGraph, retained, [
      { policy: inner, scopeAddress: nestedNodeAddress, currentAttempt: 2 },
      { policy: outer, scopeAddress: outerScopeAddress, currentAttempt: 1 },
    ], [{ policy: recovery, scopeAddress: outerScopeAddress }])).toEqual({ kind: "retry", policyId: "retry-loop",
      scope: "subgraph-instance", scopeAddress: outerScopeAddress, nextAttempt: 2 });
    expect(selectGraphFailureActionV1(nestedGraph, retained, [
      { policy: inner, scopeAddress: nestedNodeAddress, currentAttempt: 2 },
      { policy: outer, scopeAddress: outerScopeAddress, currentAttempt: 3 },
    ], [{ policy: recovery, scopeAddress: outerScopeAddress }])).toEqual({ kind: "catch", policyId: "recover",
      handlerDefinitionId: "recover-output", scopeAddress: outerScopeAddress });
    expect(selectGraphFailureActionV1(nestedGraph, retained, [], [])).toEqual({ kind: "propagate" });
    expect(selectGraphFailureActionV1(nestedGraph, validateGraphFailureEnvelopeV1(nestedGraph,
      failure({ retryability: "unknown", instance: { address: nestedNodeAddress, attempt: 1 } })),
    [{ policy: inner, scopeAddress: nestedNodeAddress, currentAttempt: 1 }],
    [{ policy: recovery, scopeAddress: outerScopeAddress }]).kind).toBe("catch");
    expect(() => selectGraphFailureActionV1(nestedGraph, retained,
      [{ policy: inner, scopeAddress: outerScopeAddress, currentAttempt: 1 }], [])).toThrow(/failed instance/);
  });

  it("distinguishes one repeated occurrence from the whole control instance", () => {
    const bodyInput = defineGraphValue({ version: "1", schema: { type: "object" },
      validator: z.object({ item: z.number(), index: z.number(), context: z.null() }) });
    const leaf = graphStep({ id: "leaf", input: graphRef.workflowInput<{ item: number; index: number; context: null }>(),
      step: defineStep({ schemaVersion: 1, id: "item", definitionVersion: "1", input: bodyInput.validator,
        output: z.number(), execute: async (_context, value) => value.item }),
      inputSchema: bodyInput.schema, outputSchema: number.schema });
    const body = defineGraph({ id: "item-body", definitionVersion: "1", input: bodyInput,
      nodes: [leaf], entry: leaf, result: leaf });
    const mapInput = defineGraphValue({ version: "1", schema: { type: "object" },
      validator: z.object({ items: z.array(z.number()), context: z.null() }) });
    const map = graphMap({ id: "map", input: graphRef.workflowInput<{ items: number[]; context: null }>(),
      inputContract: mapInput,
      outputContract: defineGraphValue({ version: "1", schema: { type: "array" }, validator: z.array(z.number()) }), body });
    const mapped = defineGraph({ id: "mapped-failure", definitionVersion: "1", input: mapInput,
      nodes: [map], entry: map, result: map });
    const failedAddress = { schemaVersion: 1 as const, path: [
      { nodeId: "map", occurrence: { kind: "map" as const, index: 1 } }, { nodeId: "leaf" },
    ] };
    const retained = validateGraphFailureEnvelopeV1(mapped, failure({ retryability: "retryable",
      instance: { address: failedAddress, attempt: 1 } }));
    const itemRetry = defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-item",
      policyVersion: "1", scope: "map-item", maxAttempts: 2, retryOn: ["workflow"], exhaustion: "propagate-failure" });
    const itemScope = { schemaVersion: 1 as const,
      path: [{ nodeId: "map", occurrence: { kind: "map" as const, index: 1 } }] };
    expect(selectGraphFailureActionV1(mapped, retained,
      [{ policy: itemRetry, scopeAddress: itemScope, currentAttempt: 1 }], [])).toMatchObject({
      kind: "retry", scope: "map-item", scopeAddress: itemScope,
    });
    expect(() => selectGraphFailureActionV1(mapped, retained, [{ policy: itemRetry,
      scopeAddress: { schemaVersion: 1, path: [{ nodeId: "map", occurrence: { kind: "map", index: 0 } }] },
      currentAttempt: 1 }], [])).toThrow(/does not enclose/);
    expect(() => selectGraphFailureActionV1(mapped, retained,
      [{ policy: itemRetry, scopeAddress: { schemaVersion: 1, path: [{ nodeId: "map" }] }, currentAttempt: 1 }], []))
      .toThrow(/exact repeated occurrence/);
  });

  it("validates recovery output while preserving the original failed attempt", () => {
    const policy = defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover-invalid-output",
      policyVersion: "1", handlerDefinitionId: "recover-output", failures: [{ class: "workflow", codes: ["invalid-output"] }],
      output: number, afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" });
    const recovered = validateGraphRecoveryRecordV1(graph, policy, { schemaVersion: 1, status: "recovered",
      policyId: policy.policyId, originalFailure: failure(), output: 7, recoveredAt: "2026-09-18T10:01:00.000Z" });
    expect(recovered.output).toBe(7);
    expect(recovered.originalFailure.code).toBe("invalid-output");
    expect(() => validateGraphRecoveryRecordV1(graph, policy, { ...recovered, output: "bad" })).toThrow();
    expect(() => validateGraphRecoveryRecordV1(graph, policy, { ...recovered,
      originalFailure: failure({ code: "other" }) })).toThrow(/does not match/);
  });

  it("records cleanup failure without discarding the original outcome", () => {
    const policy = defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "release-resource",
      policyVersion: "1", handlerDefinitionId: "release-resource", triggers: ["cancellation", "failure", "success"],
      execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" });
    const cleanupFailure = failure({ failureId: "cleanup-failure", class: "platform", code: "cleanup-failed",
      message: "Cleanup failed.", retryability: "unknown", occurredAt: "2026-09-18T10:02:00.000Z" });
    const record = validateGraphCleanupRecordV1(graph, policy, { schemaVersion: 1, policyId: policy.policyId,
      scopeOutcomeId: "scope-outcome-1", scopeAddress: failure().instance.address,
      original: { status: "failed", failure: failure() }, cleanup: { status: "failed", failure: cleanupFailure } });
    expect(record.original.status).toBe("failed");
    expect(record.cleanup.status).toBe("failed");
    if (record.original.status === "failed" && record.cleanup.status === "failed") {
      expect(record.original.failure.failureId).toBe("failure-1");
      expect(record.cleanup.failure.failureId).toBe("cleanup-failure");
    }
    expect(resolveGraphCleanupOutcomeV1(policy, record)).toMatchObject({
      runStatus: "failed", cleanupFailureAffectsRun: true,
    });
  });

  it("rejects cleanup triggers that do not cover the retained outcome", () => {
    const policy = defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "failure-cleanup",
      policyVersion: "1", handlerDefinitionId: "failure-cleanup", triggers: ["failure"],
      execution: "once-per-scope-outcome", failureMode: "record-only-preserve-original" });
    expect(() => validateGraphCleanupRecordV1(graph, policy, { schemaVersion: 1, policyId: policy.policyId,
      scopeOutcomeId: "scope-outcome-2", scopeAddress: failure().instance.address,
      original: { status: "succeeded" }, cleanup: { status: "completed", completedAt: at } })).toThrow(/does not cover/);
    expect(() => defineGraphCleanupPolicyV1({ ...policy, triggers: ["failure", "failure"] })).toThrow(/unique/);
  });

  it("keeps policy declarations internal until a runtime advertises support", () => {
    expect(publicCore).not.toHaveProperty("defineGraphRetryPolicyV1");
    expect(publicCore).not.toHaveProperty("defineGraphCatchPolicyV1");
    expect(publicCore).not.toHaveProperty("defineGraphCleanupPolicyV1");
    expect(implementation.execute).not.toHaveBeenCalled();
  });
});
