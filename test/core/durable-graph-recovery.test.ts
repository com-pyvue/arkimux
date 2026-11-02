import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  DurableGraphSchedulerV1,
  defineGraph,
  defineGraphValue,
  defineStep,
  defineWorkflow,
  graphChoice,
  graphExecutionCheckpointIdV1,
  graphLoop,
  graphMap,
  graphReduce,
  graphRef,
  graphStep,
  graphSubgraph,
  graphValue,
  type GraphDefinitionV1,
  type GraphInstanceSegmentV1,
  type GraphWorkflowV1,
  type JsonValue,
} from "../../core/src/index.ts";
import type {
  ClaimedStepTransitionV1,
  ExecutionHostContextV1,
  RegisterStepOperationRequestV1,
  RetryTerminalRequestV1,
  StepCheckpointStoreV2,
  StepCheckpointV1,
  StepClaimRequestV1,
  StepClaimResultV1,
} from "../../core/src/application/durableExecution.ts";
import type { CompletedStepV1, StepDefinitionV1, StepRefV1 } from "../../core/src/application/durableWorkflow.ts";
import { DurableWorkflowEngineV2 } from "../../core/src/application/durableWorkflowEngine.ts";
import { graphFailureBoundaryV1,
  type GraphCatchHandlerInputV1,
  type GraphCleanupHandlerInputV1 } from "../../core/src/application/graphFailureBoundary.ts";
import { defineGraphCatchPolicyV1,
  defineGraphCleanupPolicyV1 } from "../../core/src/application/graphFailurePolicy.ts";
import {
  FileAgentOperationStoreV1,
  FileDurableExecutionEventSinkV1,
  FileEffectOperationStoreV1,
  FileStepCheckpointStoreV2,
} from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";

const roots: string[] = [];
const number = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });
const numbers = defineGraphValue({ version: "1", schema: { type: "array", items: { type: "number" } }, validator: z.array(z.number()) });

class SimulatedProcessStop extends Error {
  constructor() { super("Simulated process stop after durable checkpoint commit."); }
}

class FaultAtCommitStepStore implements StepCheckpointStoreV2 {
  readonly completedIds: string[] = [];
  #stopPending = false;
  #stopped = false;

  constructor(readonly inner: StepCheckpointStoreV2, readonly targetId: string, readonly timing: "before" | "after") {}

  get stopped(): boolean { return this.#stopped; }

  read<Input extends JsonValue, Output extends JsonValue>(ref: StepRefV1): Promise<StepCheckpointV1<Input, Output> | undefined> {
    return this.inner.read<Input, Output>(ref);
  }

  claim<Input extends JsonValue, Output extends JsonValue>(request: StepClaimRequestV1): Promise<StepClaimResultV1<Input, Output>> {
    return this.inner.claim<Input, Output>(request);
  }

  registerOperation(request: RegisterStepOperationRequestV1): Promise<void> { return this.inner.registerOperation(request); }

  async complete<Input extends JsonValue, Output extends JsonValue>(request: ClaimedStepTransitionV1 & {
    readonly completed: CompletedStepV1<Input, Output>;
  }): Promise<CompletedStepV1<Input, Output>> {
    if (!this.#stopped && request.ref.stepId === this.targetId && this.timing === "before") {
      this.#stopped = true;
      this.#stopPending = true;
      throw new SimulatedProcessStop();
    }
    const completed = await this.inner.complete(request);
    this.completedIds.push(request.ref.stepId);
    if (!this.#stopped && request.ref.stepId === this.targetId && this.timing === "after") {
      this.#stopped = true;
      this.#stopPending = true;
      throw new SimulatedProcessStop();
    }
    return completed;
  }

  fail(request: ClaimedStepTransitionV1 & { readonly code: string; readonly message: string }): Promise<void> {
    if (this.#stopPending) { this.#stopPending = false; return Promise.reject(new SimulatedProcessStop()); }
    return this.inner.fail(request);
  }

  cancel(request: ClaimedStepTransitionV1 & { readonly code: "cancelled" | "deadline_exceeded" | "host_terminated" }): Promise<void> {
    return this.inner.cancel(request);
  }

  markOutcomeUnknown(request: ClaimedStepTransitionV1 & { readonly code: string; readonly message: string }): Promise<void> {
    return this.inner.markOutcomeUnknown(request);
  }

  reopenForRetry<Input extends JsonValue, Output extends JsonValue>(request: RetryTerminalRequestV1<StepRefV1>): Promise<StepCheckpointV1<Input, Output>> {
    return this.inner.reopenForRetry<Input, Output>(request);
  }
}

function host(executionId: string, attemptId: string, fence: number): ExecutionHostContextV1 {
  return {
    schemaVersion: 1,
    runRef: { executionId },
    attemptId,
    fence,
    deadlineAt: "2030-01-01T00:00:00.000Z",
    finalizationReserveMs: 1_000,
    scratchDirectory: path.join(tmpdir(), attemptId),
    limits: { maxDurationMs: 60_000, maxScratchBytes: 1_000_000 },
    cancellation: { aborted: false },
    heartbeat: async () => undefined,
  };
}

function scheduler(root: string, steps: StepCheckpointStoreV2): DurableGraphSchedulerV1 {
  return new DurableGraphSchedulerV1({ engine: new DurableWorkflowEngineV2({
    storage: {
      steps,
      agents: new FileAgentOperationStoreV1({ root }),
      effects: new FileEffectOperationStoreV1({ root }),
      events: new FileDurableExecutionEventSinkV1({ root }),
    },
    agents: {
      resolve: () => { throw new Error("No agent operations expected."); },
      invoke: async () => { throw new Error("No agent operations expected."); },
    },
  }) });
}

function leaf<I extends JsonValue, O extends JsonValue>(id: string, input: z.ZodType<I>, output: z.ZodType<O>,
  execute: (value: I) => O): Readonly<StepDefinitionV1<I, O>> {
  return defineStep({ schemaVersion: 1, id, definitionVersion: "1", input, output,
    execute: async (_context, value) => execute(value as I) });
}

function singleStepGraph<I extends JsonValue, O extends JsonValue>(id: string, input: z.ZodType<I>, output: z.ZodType<O>,
  execute: (value: I) => O): GraphDefinitionV1<I, O> {
  const node = graphStep({ id: "body", input: graphRef.workflowInput<I>(), step: leaf(id, input, output, execute),
    inputSchema: z.toJSONSchema(input), outputSchema: z.toJSONSchema(output) });
  return defineGraph({ id, definitionVersion: "1", input: node.inputContract, nodes: [node], entry: node, result: node });
}

function fixture() {
  const callbacks = {
    map: vi.fn(), reduce: vi.fn(), loop: vi.fn(), choice: vi.fn(), subgraph: vi.fn(),
    select: vi.fn((value: number) => value >= 15 ? "high" : "low"),
    condition: vi.fn((value: { state: number }) => value.state < 15),
  };
  const mapBodyInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), context: z.null() });
  const mapBody = singleStepGraph("map-body", mapBodyInput, z.number(), value => {
    callbacks.map(value.index); return value.item * 2;
  });
  const mapContract = defineGraphValue({ version: "1", schema: z.toJSONSchema(z.object({ items: z.array(z.number()), context: z.null() })),
    validator: z.object({ items: z.array(z.number()), context: z.null() }) });
  const mapped = graphMap({ id: "mapped", input: graphRef.workflowInput(), inputContract: mapContract, outputContract: numbers, body: mapBody });

  const reduceBodyInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), accumulator: z.number(), context: z.null() });
  const reduceBody = singleStepGraph("reduce-body", reduceBodyInput, z.number(), value => {
    callbacks.reduce(value.index); return value.accumulator + value.item;
  });
  const reduceContract = defineGraphValue({ version: "1", schema: z.toJSONSchema(z.object({
    items: z.array(z.number()), initial: z.number(), context: z.null(),
  })), validator: z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() }) });
  const reduced = graphReduce({ id: "reduced", input: graphValue.object({
    items: graphRef.output(mapped), initial: graphValue.literal(0), context: graphValue.literal(null),
  }), inputContract: reduceContract, outputContract: number, body: reduceBody });

  const loopBodyInput = z.object({ state: z.number(), iteration: z.number().int().nonnegative(), context: z.null() });
  const loopBody = singleStepGraph("loop-body", loopBodyInput, z.number(), value => {
    callbacks.loop(value.iteration); return value.state + 1;
  });
  const loopContract = defineGraphValue({ version: "1", schema: z.toJSONSchema(z.object({ state: z.number(), context: z.null() })),
    validator: z.object({ state: z.number(), context: z.null() }) });
  const looped = graphLoop({ id: "looped", input: graphValue.object({
    state: graphRef.output(reduced), context: graphValue.literal(null),
  }), inputContract: loopContract, outputContract: number, body: loopBody, conditionVersion: "1", while: value => callbacks.condition(value) });

  const high = singleStepGraph("high-case", z.number(), z.number(), value => { callbacks.choice(); return value * 2; });
  const low = singleStepGraph("low-case", z.number(), z.number(), value => value);
  const chosen = graphChoice({ id: "chosen", input: graphRef.output(looped), inputContract: number, outputContract: number,
    selectionVersion: "1", select: value => callbacks.select(value), cases: { high, low } });
  const tailBody = singleStepGraph("tail-body", z.number(), z.number(), value => { callbacks.subgraph(); return value + 1; });
  const tail = graphSubgraph({ id: "tail", input: graphRef.output(chosen), body: tailBody });
  const graph = defineWorkflow({ workflow: { kind: "recovery-controls", version: 1 }, workflowContractVersion: "1",
    resultKind: "recovery-controls.result", input: mapContract, nodes: [tail, chosen, mapped, looped, reduced], entry: mapped, result: tail });
  return { graph, callbacks };
}

const address = (...segments: GraphInstanceSegmentV1[]) => ({ schemaVersion: 1 as const, path: segments });
type CallbackName = "map" | "reduce" | "loop" | "choice" | "subgraph" | "select" | "condition";
function expectedCheckpointBoundaries(graph: GraphWorkflowV1): { readonly id: string; readonly callback?: CallbackName }[] {
  const checkpoint = (segments: GraphInstanceSegmentV1[], action: string) => graphExecutionCheckpointIdV1(graph, address(...segments), action);
  return [
    ...[0, 1, 2].map(index => ({ id: checkpoint([{ nodeId: "mapped", occurrence: { kind: "map", index } }, { nodeId: "body" }], "step"), callback: "map" as const })),
    { id: checkpoint([{ nodeId: "mapped" }], "map-output") },
    ...[0, 1, 2].map(index => ({ id: checkpoint([{ nodeId: "reduced", occurrence: { kind: "reduce", index } }, { nodeId: "body" }], "step"), callback: "reduce" as const })),
    { id: checkpoint([{ nodeId: "reduced" }], "reduce-output") },
    ...[0, 1, 2, 3].map(iteration => ({ id: checkpoint([{ nodeId: "looped" }], `loop-condition-${iteration}`), callback: "condition" as const })),
    ...[0, 1, 2].map(iteration => ({ id: checkpoint([{ nodeId: "looped", occurrence: { kind: "loop", iteration } }, { nodeId: "body" }], "step"), callback: "loop" as const })),
    { id: checkpoint([{ nodeId: "looped" }], "loop-output") },
    { id: checkpoint([{ nodeId: "chosen" }], "choice-selection"), callback: "select" },
    { id: checkpoint([{ nodeId: "chosen", occurrence: { kind: "choice", case: "high" } }, { nodeId: "body" }], "step"), callback: "choice" },
    { id: checkpoint([{ nodeId: "chosen" }], "choice-output") },
    { id: checkpoint([{ nodeId: "tail", occurrence: { kind: "subgraph" } }, { nodeId: "body" }], "step"), callback: "subgraph" },
    { id: checkpoint([{ nodeId: "tail" }], "subgraph-output") },
  ];
}

function expectCallbackCounts(callbacks: ReturnType<typeof fixture>["callbacks"], repeated?: CallbackName): void {
  expect(callbacks.map).toHaveBeenCalledTimes(3 + (repeated === "map" ? 1 : 0));
  expect(callbacks.reduce).toHaveBeenCalledTimes(3 + (repeated === "reduce" ? 1 : 0));
  expect(callbacks.loop).toHaveBeenCalledTimes(3 + (repeated === "loop" ? 1 : 0));
  expect(callbacks.choice).toHaveBeenCalledTimes(1 + (repeated === "choice" ? 1 : 0));
  expect(callbacks.subgraph).toHaveBeenCalledTimes(1 + (repeated === "subgraph" ? 1 : 0));
  expect(callbacks.select).toHaveBeenCalledTimes(1 + (repeated === "select" ? 1 : 0));
  expect(callbacks.condition).toHaveBeenCalledTimes(4 + (repeated === "condition" ? 1 : 0));
}

async function verifyEveryBoundary(timing: "before" | "after"): Promise<void> {
  const boundaries = expectedCheckpointBoundaries(fixture().graph);
  expect(new Set(boundaries.map(boundary => boundary.id)).size).toBe(21);
  const baselineRoot = await mkdtemp(path.join(tmpdir(), `durable-graph-recovery-${timing}-baseline-`)); roots.push(baselineRoot);
  const baseline = fixture();
  const recording = new FaultAtCommitStepStore(new FileStepCheckpointStoreV2({ root: baselineRoot }), "not-a-checkpoint", timing);
  expect(await scheduler(baselineRoot, recording).execute({ graph: baseline.graph,
    host: host(`recovery-${timing}-baseline`, "attempt-1", 1), input: { items: [1, 2, 3], context: null } })).toBe(31);
  expect([...recording.completedIds].sort()).toEqual(boundaries.map(boundary => boundary.id).sort());
  expectCallbackCounts(baseline.callbacks);
  for (const [index, boundary] of boundaries.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `durable-graph-recovery-${timing}-${index}-`)); roots.push(root);
    const { graph, callbacks } = fixture();
    const steps = new FaultAtCommitStepStore(new FileStepCheckpointStoreV2({ root }), boundary.id, timing);
    await expect(scheduler(root, steps).execute({ graph, host: host(`recovery-${timing}-${index}`, "attempt-1", 1),
      input: { items: [1, 2, 3], context: null } })).rejects.toThrow(SimulatedProcessStop);
    expect(steps.stopped).toBe(true);
    const output = await scheduler(root, new FileStepCheckpointStoreV2({ root })).execute({
      graph, host: host(`recovery-${timing}-${index}`, "attempt-2", 2), input: { items: [1, 2, 3], context: null },
    });
    expect(output).toBe(31);
    expectCallbackCounts(callbacks, timing === "before" ? boundary.callback : undefined);
  }
}

function catchFixture() {
  let failingCalls = 0;
  let catchCalls = 0;
  const failing = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1",
    input: z.number(), output: z.number(), execute: async () => {
      failingCalls++;
      throw new Error("Calculation failed.");
    } });
  const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(), step: failing,
    inputSchema: { type: "number" }, outputSchema: { type: "number" } });
  const handler = defineStep({ schemaVersion: 1, id: "recover-failure", definitionVersion: "1",
    input: z.custom<GraphCatchHandlerInputV1<number>>(), output: z.number(), execute: async (_context, input) => {
      catchCalls++;
      return input.scope.input + 100;
    } });
  graphFailureBoundaryV1({ placement: node, scope: "node-instance", catches: [{
    policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover-failure",
      policyVersion: "1", handlerDefinitionId: "recover-failure", failures: [{ class: "workflow" }],
      output: node.outputContract, afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }),
    handler,
  }] });
  const graph = defineWorkflow({ workflow: { kind: "catch-recovery-controls", version: 1 }, workflowContractVersion: "1",
    resultKind: "catch-recovery-controls.result", input: number, nodes: [node], entry: node, result: node });
  return { graph, calls: () => ({ failingCalls, catchCalls }) };
}

async function verifyCatchBoundary(target: "handler" | "recovery", timing: "before" | "after"): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `durable-graph-catch-${target}-${timing}-`));
  roots.push(root);
  const { graph, calls } = catchFixture();
  const graphAddress = address({ nodeId: "calculate" });
  const targetId = graphExecutionCheckpointIdV1(graph, graphAddress, `catch-recover-failure-${target}`);
  const steps = new FaultAtCommitStepStore(new FileStepCheckpointStoreV2({ root }), targetId, timing);
  const executionId = `catch-${target}-${timing}`;

  await expect(scheduler(root, steps).execute({ graph, host: host(executionId, "attempt-1", 1), input: 10 }))
    .rejects.toThrow(SimulatedProcessStop);
  await expect(scheduler(root, new FileStepCheckpointStoreV2({ root })).execute({
    graph, host: host(executionId, "attempt-2", 2), input: 10,
  })).resolves.toBe(110);

  expect(calls()).toEqual({ failingCalls: 1, catchCalls: target === "handler" && timing === "before" ? 2 : 1 });
  const store = new FileStepCheckpointStoreV2({ root });
  const originalId = graphExecutionCheckpointIdV1(graph, graphAddress, "step");
  const handlerId = graphExecutionCheckpointIdV1(graph, graphAddress, "catch-recover-failure-handler");
  const recoveryId = graphExecutionCheckpointIdV1(graph, graphAddress, "catch-recover-failure-recovery");
  await expect(store.read({ runRef: { executionId }, stepId: originalId })).resolves.toMatchObject({ state: "FAILED" });
  await expect(store.read({ runRef: { executionId }, stepId: handlerId })).resolves.toMatchObject({ state: "COMPLETED" });
  await expect(store.read({ runRef: { executionId }, stepId: recoveryId })).resolves.toMatchObject({ state: "COMPLETED",
    completed: { output: { status: "recovered", policyId: "recover-failure", output: 110 } } });
}

function cleanupFixture() {
  let stepCalls = 0;
  let cleanupCalls = 0;
  const step = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1",
    input: z.number(), output: z.number(), execute: async (_context, input) => {
      stepCalls++;
      return input + 1;
    } });
  const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(), step,
    inputSchema: { type: "number" }, outputSchema: { type: "number" } });
  const handler = defineStep({ schemaVersion: 1, id: "release-resource", definitionVersion: "1",
    input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: async () => {
      cleanupCalls++;
      return null;
    } });
  graphFailureBoundaryV1({ placement: node, scope: "node-instance", cleanup: [{
    policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "release-resource",
      policyVersion: "1", handlerDefinitionId: "release-resource", triggers: ["success"],
      execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" }),
    handler,
  }] });
  const graph = defineWorkflow({ workflow: { kind: "cleanup-recovery-controls", version: 1 }, workflowContractVersion: "1",
    resultKind: "cleanup-recovery-controls.result", input: number, nodes: [node], entry: node, result: node });
  return { graph, calls: () => ({ stepCalls, cleanupCalls }) };
}

async function verifyCleanupBoundary(target: "handler" | "record", timing: "before" | "after"): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `durable-graph-cleanup-${target}-${timing}-`));
  roots.push(root);
  const { graph, calls } = cleanupFixture();
  const graphAddress = address({ nodeId: "calculate" });
  const targetId = graphExecutionCheckpointIdV1(graph, graphAddress, `cleanup-release-resource-${target}`);
  const steps = new FaultAtCommitStepStore(new FileStepCheckpointStoreV2({ root }), targetId, timing);
  const executionId = `cleanup-${target}-${timing}`;

  await expect(scheduler(root, steps).execute({ graph, host: host(executionId, "attempt-1", 1), input: 10 }))
    .rejects.toThrow(SimulatedProcessStop);
  await expect(scheduler(root, new FileStepCheckpointStoreV2({ root })).execute({
    graph, host: host(executionId, "attempt-2", 2), input: 10,
  })).resolves.toBe(11);

  expect(calls()).toEqual({ stepCalls: 1, cleanupCalls: target === "handler" && timing === "before" ? 2 : 1 });
  const store = new FileStepCheckpointStoreV2({ root });
  const handlerId = graphExecutionCheckpointIdV1(graph, graphAddress, "cleanup-release-resource-handler");
  const recordId = graphExecutionCheckpointIdV1(graph, graphAddress, "cleanup-release-resource-record");
  await expect(store.read({ runRef: { executionId }, stepId: handlerId })).resolves.toMatchObject({ state: "COMPLETED" });
  await expect(store.read({ runRef: { executionId }, stepId: recordId })).resolves.toMatchObject({ state: "COMPLETED",
    completed: { output: { policyId: "release-resource", original: { status: "succeeded" },
      cleanup: { status: "completed" } } } });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("durable graph checkpoint recovery", () => {
  it("recovers from a stop before every graph/control checkpoint commit", () => verifyEveryBoundary("before"), 30_000);
  it("recovers from a stop after every graph/control checkpoint commit without repeating completed callbacks",
    () => verifyEveryBoundary("after"), 30_000);
  for (const target of ["handler", "recovery"] as const) {
    for (const timing of ["before", "after"] as const) {
      it(`recovers from a stop ${timing} the catch ${target} commit`,
        () => verifyCatchBoundary(target, timing));
    }
  }
  for (const target of ["handler", "record"] as const) {
    for (const timing of ["before", "after"] as const) {
      it(`recovers from a stop ${timing} the cleanup ${target} commit`,
        () => verifyCleanupBoundary(target, timing));
    }
  }
});
