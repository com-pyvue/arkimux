import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  admitGraphInvocationV1, createGraphAcceptedBoundaryV1, createGraphEntryRequestV1,
  createGraphRunInvocationV1, defineGraphValue, defineStep, defineWorkflow,
  graphRef, graphStep, projectGraphInvocationReadV1, validateGraphAcceptedBoundaryV1,
  validateGraphEntryBoundaryV1, validateGraphEntryRequestStateV1, validateGraphRunInvocationV1,
} from "../../core/src/index.ts";

const sha = (value: string) => value.repeat(64);
const number = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });
const step = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1", input: z.number(), output: z.number(),
  execute: vi.fn(async () => { throw new Error("Record construction must not execute workflow code."); }) });
const makeGraph = (nodeId = "calculate") => {
  const calculate = graphStep({ id: nodeId, step, input: graphRef.workflowInput<number>(),
    inputSchema: { type: "number" }, outputSchema: { type: "number" } });
  return defineWorkflow({ workflow: { kind: "record-test", version: 1 }, workflowContractVersion: "1",
    resultKind: "record-test.result", input: number, nodes: [calculate], entry: calculate, result: calculate });
};
const identity = {
  runRef: { executionId: "run-1" },
  runConfiguration: { configurationId: "record-test-v1", contentHash: sha("b") },
  executableBindingId: "binding-1",
  buildSha256: sha("a"),
  createdAt: "2026-09-18T10:00:00.000Z",
};
describe("immutable graph invocation records", () => {
  it("pins supplied input separately and exposes a public read without values", () => {
    const graph = makeGraph();
    const admission = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied",
      entry: { kind: "default" }, values: { entry: 42 } });
    expect(admission.acquisition).toBe("supplied");
    if (admission.acquisition !== "supplied") throw new Error("Expected supplied admission.");
    const invocation = createGraphRunInvocationV1({ graph, admission, ...identity });
    expect(invocation).not.toHaveProperty("input");
    expect(invocation.graphDeclarationSha256).toBe(graph.declarationSha256);
    const accepted = createGraphAcceptedBoundaryV1({ graph, invocation, boundary: admission.boundary,
      acceptanceId: "acceptance-1", acceptedAt: identity.createdAt });
    expect(accepted.source).toBe("supplied-invocation");
    expect(accepted.boundary.values.entry).toBe(42);
    const read = projectGraphInvocationReadV1({ graph, invocation, accepted });
    expect(read.input).toEqual({ status: "input_accepted", source: "supplied-invocation",
      acceptanceId: "acceptance-1", acceptedAt: identity.createdAt });
    expect(JSON.stringify(read)).not.toContain("42");
    expect(step.execute).not.toHaveBeenCalled();
  });

  it("hashes the validated boundary rather than the caller's pre-normalized value", () => {
    const normalizedNumber = defineGraphValue<number>({ version: "1", schema: { type: "number" },
      validator: z.coerce.number() });
    const normalize = graphStep({ id: "normalize", step, input: graphRef.workflowInput<number>(),
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const graph = defineWorkflow({ workflow: { kind: "normalized-record-test", version: 1 },
      workflowContractVersion: "1", resultKind: "normalized-record-test.result", input: normalizedNumber,
      nodes: [normalize], entry: normalize, result: normalize });
    const admission = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied",
      entry: { kind: "default" }, values: { entry: 7 } });
    if (admission.acquisition !== "supplied") throw new Error("Expected supplied admission.");
    const invocation = createGraphRunInvocationV1({ graph, admission, ...identity });
    const accepted = createGraphAcceptedBoundaryV1({ graph, invocation,
      boundary: { ...admission.boundary, values: { entry: "7" } },
      acceptanceId: "acceptance-normalized", acceptedAt: identity.createdAt });
    expect(accepted.boundary.values.entry).toBe(7);
  });

  it("keeps one deferred Run from readable request through immutable acceptance", () => {
    const graph = makeGraph();
    const admission = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "1d" } });
    const invocation = createGraphRunInvocationV1({ graph, admission, ...identity });
    const request = createGraphEntryRequestV1(graph, invocation, { requestId: "request-1" });
    expect(request.expiresAt).toBe("2026-09-19T10:00:00.000Z");
    const pending = validateGraphEntryRequestStateV1(graph, invocation, { schemaVersion: 1, request, revision: 1,
      status: "pending", updatedAt: identity.createdAt });
    expect(projectGraphInvocationReadV1({ graph, invocation, requestState: pending }).input).toEqual({
      status: "waiting_for_input", requestId: "request-1", createdAt: identity.createdAt, expiresAt: request.expiresAt,
    });

    const boundary = validateGraphEntryBoundaryV1(invocation.entryPlan, { schemaVersion: 1,
      planSha256: invocation.entryPlan.planSha256, values: { entry: 7 } });
    const acceptedAt = "2026-09-18T11:00:00.000Z";
    const accepted = createGraphAcceptedBoundaryV1({ graph, invocation, request, boundary,
      acceptanceId: "acceptance-2", acceptedAt });
    const submitted = validateGraphEntryRequestStateV1(graph, invocation, { schemaVersion: 1, request, revision: 2,
      status: "submitted", updatedAt: acceptedAt });
    const read = projectGraphInvocationReadV1({ graph, invocation, requestState: submitted, accepted });
    expect(read.runRef).toEqual(identity.runRef);
    expect(read.input).toEqual({ status: "input_accepted", source: "deferred-submission",
      acceptanceId: "acceptance-2", requestId: "request-1", acceptedAt });
  });

  it("restores retained JSON against the exact graph, configuration and build binding", () => {
    const graph = makeGraph();
    const admission = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "1d" } });
    const invocation = createGraphRunInvocationV1({ graph, admission, ...identity });
    const restored = validateGraphRunInvocationV1(graph, structuredClone(invocation));
    expect(restored.entryPlan.planSha256).toBe(invocation.entryPlan.planSha256);
    expect(restored.runConfiguration).toEqual(identity.runConfiguration);
    expect(restored.executableBindingId).toBe(identity.executableBindingId);
    expect(() => validateGraphRunInvocationV1(makeGraph("changed"), invocation)).toThrow(/declaration differs/);
    expect(() => validateGraphRunInvocationV1(graph, { ...invocation, buildSha256: "bad" })).toThrow(/build digest/);
    expect(() => validateGraphRunInvocationV1(graph, { ...invocation, unknown: true })).toThrow(/unknown/);
  });

  it("enforces deferred deadlines and request-state transition times", () => {
    const graph = makeGraph();
    const admission = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "1d" } });
    const invocation = createGraphRunInvocationV1({ graph, admission, ...identity });
    const request = createGraphEntryRequestV1(graph, invocation, { requestId: "request-1" });
    expect(() => validateGraphEntryRequestStateV1(graph, invocation, { schemaVersion: 1, request, revision: 1,
      status: "submitted", updatedAt: request.expiresAt })).toThrow(/transition time/);
    expect(() => validateGraphEntryRequestStateV1(graph, invocation, { schemaVersion: 1, request, revision: 1,
      status: "expired", updatedAt: identity.createdAt })).toThrow(/transition time/);
    const expired = validateGraphEntryRequestStateV1(graph, invocation, { schemaVersion: 1, request, revision: 2,
      status: "expired", updatedAt: request.expiresAt });
    expect(projectGraphInvocationReadV1({ graph, invocation, requestState: expired }).input.status).toBe("expired");
  });

  it("rejects cross-mode, cross-request and altered accepted-boundary records", () => {
    const graph = makeGraph();
    const deferred = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry: { kind: "default" }, wait: { duration: "1d" } });
    const invocation = createGraphRunInvocationV1({ graph, admission: deferred, ...identity });
    const request = createGraphEntryRequestV1(graph, invocation, { requestId: "request-1" });
    const boundary = validateGraphEntryBoundaryV1(invocation.entryPlan, { schemaVersion: 1,
      planSha256: invocation.entryPlan.planSha256, values: { entry: 7 } });
    const accepted = createGraphAcceptedBoundaryV1({ graph, invocation, request, boundary,
      acceptanceId: "acceptance-1", acceptedAt: "2026-09-18T11:00:00.000Z" });
    expect(() => validateGraphAcceptedBoundaryV1(graph, invocation, request, { ...accepted, requestId: "request-2" })).toThrow(/request or deadline/);
    expect(() => validateGraphAcceptedBoundaryV1(graph, invocation, request, { ...accepted, acceptedBodySha256: sha("d") })).toThrow(/body digest/);
    expect(() => projectGraphInvocationReadV1({ graph, invocation, requestState: {
      schemaVersion: 1, request, revision: 1, status: "pending", updatedAt: identity.createdAt,
    }, accepted })).toThrow(/Only a submitted/);
    expect(() => createGraphAcceptedBoundaryV1({ graph, invocation, boundary,
      acceptanceId: "acceptance-2", acceptedAt: "2026-09-18T11:00:00.000Z" })).toThrow(/requires its fixed request/);
  });
});
