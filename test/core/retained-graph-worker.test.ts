import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import {
  admitGraphInvocationV1,
  createGraphAcceptedBoundaryV1,
  createGraphEntryRequestV1,
  createGraphRunInvocationV1,
  validateGraphEntryBoundaryV1,
  validateGraphEntryRequestStateV1,
  type GraphWorkflowV1,
  type JsonValue,
} from "../../core/src/index.ts";
import { validateRetainedGraphInputV1 } from "../../core/src/application/retainedGraphInput.ts";
import { graphExecutionCheckpointIdV1 } from "../../core/src/application/durableGraphScheduler.ts";
import { constructionDescriptorFile } from "../../core/src/application/retainedWorkflowConstruction.ts";
import type { ExecutableBindingV1 } from "../../core/src/application/retainedExecution.ts";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { FileStepCheckpointStoreV2 } from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";
import { LocalRetainedWorkflowRunnerV1 } from "../../local/src/localRetainedWorkflowRunner.ts";
import { resolveLocalDurableExecutionPaths } from "../../local/src/localDurableWorkflowRuntime.ts";
import { createRetainedGraph } from "./fixtures/retained-graph-workflow.ts";

const roots: string[] = [];
const stores: FileRetainedExecutionStoreV1[] = [];
const requirements = { node: "22" };
const limits = { totalMs: 120_000, attemptMs: 60_000, finalizationReserveMs: 1_000 };
const configurationRef = { configurationId: "graph-config-v1", contentHash: "c".repeat(64) };

async function setup(options: { acquisition: "supplied" | "deferred"; selected?: boolean; failFirst: boolean; cancelFirst?: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "retained-graph-worker-")); roots.push(root);
  const storeRoot = path.join(root, "retained"), store = await FileRetainedExecutionStoreV1.open(storeRoot); stores.push(store);
  const graphModule = path.join(root, "retained-graph.mjs");
  await bundle({ entryPoints: [fileURLToPath(new URL("./fixtures/retained-graph-workflow.ts", import.meta.url))], outfile: graphModule,
    bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const build = await store.publishBuild({ inputSha256: "a".repeat(64), entryPoint: "workflow.mjs", files: {
    "workflow.mjs": await readFile(graphModule),
    [constructionDescriptorFile]: Buffer.from(JSON.stringify({ schemaVersion: 1, export: "createRetainedGraph" })),
  }, hostRequirements: requirements });
  const context = { environment: {}, runConfiguration: { failFirst: options.failFirst, cancelFirst: options.cancelFirst ?? false },
    readAsset: () => { throw new Error("No retained assets expected."); } };
  const graph = createRetainedGraph(context).graph as GraphWorkflowV1;
  const ref = { executionId: options.acquisition === "supplied" ? "graph-supplied" : "graph-deferred" };
  const entry = options.selected
    ? { kind: "selected" as const, address: { schemaVersion: 1 as const, path: [{ nodeId: "second" }] } }
    : { kind: "default" as const };
  const admission = options.acquisition === "supplied"
    ? admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied", entry, values: { entry: 4 } })
    : admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry, wait: { duration: "1d" } });
  const createdAt = new Date().toISOString();
  const invocation = createGraphRunInvocationV1({ graph, admission, runRef: ref, runConfiguration: configurationRef,
    executableBindingId: `binding-${ref.executionId}`, buildSha256: build.buildSha256, createdAt });
  const binding: ExecutableBindingV1 = { id: invocation.executableBindingId, buildSha256: build.buildSha256,
    workflow: graph.workflow, invocation, runConfiguration: context.runConfiguration,
    executionProfile: { maxScratchBytes: 1024 * 1024 }, nonSecretEnvironment: {}, credentialReferences: [], hostRequirements: requirements };
  let graphInput;
  if (admission.acquisition === "supplied") {
    const accepted = createGraphAcceptedBoundaryV1({ graph, invocation, boundary: admission.boundary,
      acceptanceId: "acceptance-supplied", acceptedAt: createdAt });
    graphInput = validateRetainedGraphInputV1({ schemaVersion: 1, invocation, accepted });
  } else {
    const request = createGraphEntryRequestV1(graph, invocation, { requestId: "request-deferred" });
    const requestState = validateGraphEntryRequestStateV1(graph, invocation, { schemaVersion: 1, request,
      revision: 1, status: "pending", updatedAt: createdAt });
    graphInput = validateRetainedGraphInputV1({ schemaVersion: 1, invocation, requestState });
  }
  await store.createRun(ref, binding, { graph, state: graphInput });
  const workerPath = path.join(root, "worker.mjs");
  await bundle({ entryPoints: [fileURLToPath(new URL("../../local/src/retainedAttemptWorker.ts", import.meta.url))], outfile: workerPath,
    bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  let preparations = 0, closes = 0, prepared!: () => void;
  const agentsPrepared = new Promise<void>(resolve => { prepared = resolve; });
  const runner = (current = store) => new LocalRetainedWorkflowRunnerV1({ store: current, projectRoot: root, workerPath,
    prepareAgents: async (_binding, _signal, prompts) => {
      preparations++; expect(prompts).toEqual({}); prepared();
      return { bindings: {}, invoke: async () => { throw new Error("No agent call expected."); }, close: async () => { closes++; } };
    } });
  return { root, storeRoot, graphModule, store, graph, ref, invocation, runner,
    preparations: () => preparations, closes: () => closes, agentsPrepared };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("retained graph worker dispatch", () => {
  it("reconstructs and executes supplied graph input in the isolated retained worker", async () => {
    const fixture = await setup({ acquisition: "supplied", failFirst: false });
    const outcome = await fixture.runner().execute(fixture.ref, limits, requirements);
    expect(outcome).toMatchObject({ status: "completed", output: 9 });
    const control = await fixture.store.read(fixture.ref);
    expect(control).toMatchObject({ status: "complete", output: 9, owner: null });
    expect(fixture.preparations()).toBe(1); expect(fixture.closes()).toBe(1);
  });

  it("starts no worker while deferred, then resumes the same selected-entry Run from retained code", async () => {
    const fixture = await setup({ acquisition: "deferred", selected: true, failFirst: true });
    const before = await fixture.runner().execute(fixture.ref, limits, requirements);
    expect(before.status).toBe("failed");
    expect(await fixture.store.read(fixture.ref)).toMatchObject({ status: "waiting_for_input", owner: null });
    expect((await fixture.store.read(fixture.ref))?.compute).toBeUndefined();
    expect(fixture.preparations()).toBe(0);
    const requirementsById = Object.fromEntries(fixture.invocation.entryPlan.requirements.map(requirement =>
      [requirement.id, requirement.role === "entry-input" ? { original: 4, first: 5 } : 4]));
    const boundary = validateGraphEntryBoundaryV1(fixture.invocation.entryPlan, { schemaVersion: 1,
      planSha256: fixture.invocation.entryPlan.planSha256, values: requirementsById as Record<string, JsonValue> });
    await fixture.store.submitGraphInput(fixture.ref, fixture.graph, { acceptanceId: "acceptance-deferred",
      expectedRevision: 1, boundary });
    await fixture.store.close(); stores.splice(stores.indexOf(fixture.store), 1);
    await rm(fixture.graphModule);
    const reopened = await FileRetainedExecutionStoreV1.open(fixture.storeRoot); stores.push(reopened);
    expect((await reopened.recover()).map(run => run.runRef)).toEqual([fixture.ref]);
    const outcome = await fixture.runner(reopened).execute(fixture.ref, limits, requirements);
    expect(outcome).toMatchObject({ status: "completed", output: 9 });
    const control = await reopened.read(fixture.ref);
    expect(control).toMatchObject({ status: "complete", output: 9, owner: null });
    expect(fixture.preparations()).toBe(1); expect(fixture.closes()).toBe(1);
  });

  it("lets a cancelled retained graph persist its cleanup record before worker teardown", async () => {
    const fixture = await setup({ acquisition: "supplied", failFirst: false, cancelFirst: true });
    const cancellation = new AbortController();
    const execution = fixture.runner().execute(fixture.ref, limits, requirements, cancellation.signal);
    await fixture.agentsPrepared;
    const storageRoot = resolveLocalDurableExecutionPaths(fixture.root, fixture.ref).root;
    const stepStore = new FileStepCheckpointStoreV2({ root: storageRoot });
    const firstAddress = { schemaVersion: 1 as const, path: [{ nodeId: "first" }] };
    const stepId = graphExecutionCheckpointIdV1(fixture.graph, firstAddress, "step");
    for (let attempt = 0; attempt < 100 && (await stepStore.read({ runRef: fixture.ref, stepId }))?.state !== "RUNNING"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await expect(stepStore.read({ runRef: fixture.ref, stepId })).resolves.toMatchObject({ state: "RUNNING" });
    cancellation.abort();
    await expect(execution).resolves.toMatchObject({ status: "cancelled" });

    const recordId = graphExecutionCheckpointIdV1(fixture.graph, firstAddress,
      "cleanup-release-first-step-record");
    await expect(stepStore.read({ runRef: fixture.ref, stepId: recordId }))
      .resolves.toMatchObject({ state: "COMPLETED", completed: { output: {
        original: { status: "cancelled", reason: "host_terminated" }, cleanup: { status: "completed" },
      } } });
    expect(fixture.closes()).toBe(1);
  });
});
