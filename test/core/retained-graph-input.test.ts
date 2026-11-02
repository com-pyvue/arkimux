import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  admitGraphInvocationV1,
  createGraphAcceptedBoundaryV1,
  createGraphEntryRequestV1,
  createGraphRunInvocationV1,
  defineGraphValue,
  defineStep,
  defineWorkflow,
  graphRef,
  graphStep,
  validateGraphEntryRequestStateV1,
} from "../../core/src/index.ts";
import { validateRetainedGraphInputV1, type RetainedGraphInputV1 } from "../../core/src/application/retainedGraphInput.ts";
import type { ExecutableBindingV1 } from "../../core/src/application/retainedExecution.ts";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";

const roots: string[] = [];
const stores: FileRetainedExecutionStoreV1[] = [];
const requirements = { node: "22.19.0" };
const runRef = { executionId: "graph-run-1" };
const configuration = { configurationId: "graph-config-v1", contentHash: "b".repeat(64) };
const createdAt = "2026-09-18T10:00:00.000Z";
const expiresAt = "2026-09-19T10:00:00.000Z";

const value = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });
const step = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1", input: z.number(), output: z.number(),
  execute: vi.fn(async (input: number) => input + 1) });
const calculate = graphStep({ id: "calculate", step, input: graphRef.workflowInput<number>(),
  inputSchema: { type: "number" }, outputSchema: { type: "number" } });
const graph = defineWorkflow({ workflow: { kind: "retained-graph-input-test", version: 1 }, workflowContractVersion: "1",
  resultKind: "retained-graph-input-test.result", input: value, nodes: [calculate], entry: calculate, result: calculate });

async function setup(acquisition: "supplied" | "deferred") {
  const root = await mkdtemp(path.join(tmpdir(), "retained-graph-input-")); roots.push(root);
  let clock = new Date(createdAt);
  const store = await FileRetainedExecutionStoreV1.open(root, { now: () => clock }); stores.push(store);
  const build = await store.publishBuild({ inputSha256: "a".repeat(64), entryPoint: "entry.mjs",
    files: { "entry.mjs": Buffer.from("export const retained = true;") }, hostRequirements: requirements });
  const admission = acquisition === "supplied"
    ? admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition, entry: { kind: "default" }, values: { entry: 7 } })
    : admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition, entry: { kind: "default" }, wait: { duration: "1d" } });
  const invocation = createGraphRunInvocationV1({ graph, admission, runRef, runConfiguration: configuration,
    executableBindingId: "graph-binding-1", buildSha256: build.buildSha256, createdAt });
  const binding: ExecutableBindingV1 = { id: invocation.executableBindingId, buildSha256: build.buildSha256,
    workflow: graph.workflow, invocation, runConfiguration: configuration, executionProfile: { id: "local" },
    nonSecretEnvironment: {}, credentialReferences: [], hostRequirements: requirements };
  let state: RetainedGraphInputV1;
  if (admission.acquisition === "supplied") {
    const accepted = createGraphAcceptedBoundaryV1({ graph, invocation, boundary: admission.boundary,
      acceptanceId: "acceptance-supplied", acceptedAt: createdAt });
    state = validateRetainedGraphInputV1({ schemaVersion: 1, invocation, accepted });
  } else {
    const request = createGraphEntryRequestV1(graph, invocation, { requestId: "request-1" });
    const requestState = validateGraphEntryRequestStateV1(graph, invocation, { schemaVersion: 1, request,
      revision: 1, status: "pending", updatedAt: createdAt });
    state = validateRetainedGraphInputV1({ schemaVersion: 1, invocation, requestState });
  }
  return { root, store, build, binding, invocation, state,
    advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); } };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("retained graph input authority", () => {
  it("starts supplied input immediately and restores its immutable boundary", async () => {
    const fixture = await setup("supplied");
    const created = await fixture.store.createRun(runRef, fixture.binding, { graph, state: fixture.state });
    expect(created.status).toBe("running");
    expect((await fixture.store.readGraphInput(runRef, graph))?.accepted?.boundary.values.entry).toBe(7);
    expect(await fixture.store.createRun(runRef, fixture.binding, { graph, state: fixture.state })).toEqual(created);
  });

  it("does not let Run creation bypass the deferred-input transition authority", async () => {
    const fixture = await setup("deferred");
    const requestState = fixture.state.requestState!;
    const acceptedAt = "2026-09-18T11:00:00.000Z";
    const accepted = createGraphAcceptedBoundaryV1({ graph, invocation: fixture.invocation, request: requestState.request,
      boundary: { schemaVersion: 1, planSha256: fixture.invocation.entryPlan.planSha256, values: { entry: 8 } },
      acceptanceId: "acceptance-injected", acceptedAt });
    const transitioned = validateRetainedGraphInputV1({ schemaVersion: 1, invocation: fixture.invocation,
      requestState: { ...requestState, revision: 2, status: "submitted", updatedAt: acceptedAt }, accepted });
    await expect(fixture.store.createRun(runRef, fixture.binding, { graph, state: transitioned }))
      .rejects.toThrow(/must start with its original pending/);
    expect(await fixture.store.read(runRef)).toBeUndefined();
  });

  it("keeps deferred input waiting, then atomically accepts it and queues the same Run", async () => {
    const fixture = await setup("deferred");
    await fixture.store.createRun(runRef, fixture.binding, { graph, state: fixture.state });
    expect((await fixture.store.read(runRef))?.status).toBe("waiting_for_input");
    await expect(fixture.store.claim(runRef, "attempt-before-input", requirements)).rejects.toThrow("request-closed");
    await expect(fixture.store.submitGraphInput(runRef, graph, { acceptanceId: "acceptance-1", expectedRevision: 1,
      boundary: { schemaVersion: 1, planSha256: fixture.invocation.entryPlan.planSha256, values: { entry: "bad" } } }))
      .rejects.toThrow(/entry is invalid/);
    expect((await fixture.store.read(runRef))?.revision).toBe(1);

    fixture.advance(60_000);
    const body = { acceptanceId: "acceptance-1", expectedRevision: 1,
      boundary: { schemaVersion: 1, planSha256: fixture.invocation.entryPlan.planSha256, values: { entry: 9 } } };
    const accepted = await fixture.store.submitGraphInput(runRef, graph, body);
    expect(accepted.boundary.values.entry).toBe(9);
    const control = await fixture.store.read(runRef);
    expect(control?.status).toBe("resume_queued");
    expect(control?.revision).toBe(2);
    expect(control?.graphInput?.requestState).toMatchObject({ status: "submitted", revision: 2 });
    expect(await fixture.store.submitGraphInput(runRef, graph, body)).toEqual(accepted);
    await expect(fixture.store.submitGraphInput(runRef, graph, { ...body, acceptanceId: "acceptance-other" }))
      .rejects.toThrow("submission-reused");

    await fixture.store.close(); stores.splice(stores.indexOf(fixture.store), 1);
    const reopened = await FileRetainedExecutionStoreV1.open(fixture.root); stores.push(reopened);
    expect((await reopened.readGraphInput(runRef, graph))?.accepted).toEqual(accepted);
    expect((await reopened.claim(runRef, "attempt-after-input", requirements)).fence).toBe(1);
  });

  it("admits exactly one competing deferred submission", async () => {
    const fixture = await setup("deferred");
    await fixture.store.createRun(runRef, fixture.binding, { graph, state: fixture.state });
    const boundary = { schemaVersion: 1, planSha256: fixture.invocation.entryPlan.planSha256, values: { entry: 11 } };
    const results = await Promise.allSettled(["acceptance-one", "acceptance-two"].map(acceptanceId =>
      fixture.store.submitGraphInput(runRef, graph, { acceptanceId, expectedRevision: 1, boundary })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await fixture.store.read(runRef))?.status).toBe("resume_queued");
  });

  it("closes a pending graph request when its Run is cancelled", async () => {
    const fixture = await setup("deferred");
    await fixture.store.createRun(runRef, fixture.binding, { graph, state: fixture.state });
    await fixture.store.cancel(runRef);
    const control = await fixture.store.read(runRef);
    expect(control?.status).toBe("cancelled");
    expect(control?.graphInput?.requestState).toMatchObject({ status: "cancelled", revision: 2 });
    await expect(fixture.store.submitGraphInput(runRef, graph, { acceptanceId: "acceptance-late", expectedRevision: 1,
      boundary: { schemaVersion: 1, planSha256: fixture.invocation.entryPlan.planSha256, values: { entry: 12 } } }))
      .rejects.toThrow("request-closed");
  });

  it("expires a pending graph request at its retained deadline", async () => {
    const fixture = await setup("deferred");
    await fixture.store.createRun(runRef, fixture.binding, { graph, state: fixture.state });
    fixture.advance(24 * 60 * 60 * 1000);
    expect(await fixture.store.expireGraphInput(runRef, graph)).toBe(true);
    const control = await fixture.store.read(runRef);
    expect(control?.status).toBe("failed");
    expect(control?.failure?.code).toBe("input-expired");
    expect(control?.graphInput?.requestState).toMatchObject({ status: "expired", revision: 2 });
    expect(await fixture.store.expireGraphInput(runRef, graph)).toBe(false);
  });

  it("expires a pending graph request during restart recovery", async () => {
    const fixture = await setup("deferred");
    await fixture.store.createRun(runRef, fixture.binding, { graph, state: fixture.state });
    fixture.advance(24 * 60 * 60 * 1000);
    expect(await fixture.store.recover()).toEqual([]);
    const control = await fixture.store.read(runRef);
    expect(control?.status).toBe("failed");
    expect(control?.failure?.code).toBe("input-expired");
    expect(control?.graphInput?.requestState).toMatchObject({ status: "expired", revision: 2, updatedAt: expiresAt });
  });
});
