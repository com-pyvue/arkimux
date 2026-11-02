import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DurableGraphSchedulerV1,
  describeGraphEntryV1,
  defineGraph,
  defineGraphValue,
  defineStep,
  defineWorkflow,
  graphChoice,
  graphLoop,
  graphMap,
  graphReduce,
  graphRef,
  graphStep,
  graphSubgraph,
  graphValue,
  type GraphDefinitionV1,
  type GraphEntryPlanV1,
  type GraphInstanceSegmentV1,
  type GraphNodeV1,
  type GraphValueContractV1,
  type JsonValue,
  validateGraphEntryBoundaryV1,
} from "../../core/src/index.ts";
import type { ExecutionHostContextV1 } from "../../core/src/application/durableExecution.ts";
import { ExternalProviderError } from "../../core/src/application/externalError.ts";
import { graphFailureBoundaryV1,
  type GraphCatchHandlerInputV1,
  type GraphCleanupHandlerInputV1 } from "../../core/src/application/graphFailureBoundary.ts";
import { defineGraphCatchPolicyV1,
  defineGraphCleanupPolicyV1,
  defineGraphRetryPolicyV1 } from "../../core/src/application/graphFailurePolicy.ts";
import { graphExecutionCheckpointIdV1 } from "../../core/src/application/durableGraphScheduler.ts";
import { DurableWorkflowEngineV2 } from "../../core/src/application/durableWorkflowEngine.ts";
import type { StepExecutionContextV1 } from "../../core/src/application/durableWorkflow.ts";
import {
  FileAgentOperationStoreV1,
  FileDurableExecutionEventSinkV1,
  FileEffectOperationStoreV1,
  FileStepCheckpointStoreV2,
} from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";

const contract = <T extends JsonValue>(validator: z.ZodType<T>) => defineGraphValue({
  version: "1",
  schema: z.toJSONSchema(validator) as Record<string, JsonValue>,
  validator,
});
const number = contract(z.number());
const numbers = contract(z.array(z.number()));
const objectSchema = <T extends Record<string, JsonValue>>(validator: z.ZodType<T>) => contract(validator);

function host(executionId: string, attemptId = "attempt-1", fence = 1): ExecutionHostContextV1 {
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

async function scheduler(root: string): Promise<DurableGraphSchedulerV1> {
  const engine = new DurableWorkflowEngineV2({
    storage: {
      steps: new FileStepCheckpointStoreV2({ root }),
      agents: new FileAgentOperationStoreV1({ root }),
      effects: new FileEffectOperationStoreV1({ root }),
      events: new FileDurableExecutionEventSinkV1({ root }),
    },
    agents: {
      resolve: () => { throw new Error("No agent operations expected."); },
      invoke: async () => { throw new Error("No agent operations expected."); },
    },
  });
  return new DurableGraphSchedulerV1({ engine });
}

function leaf<I extends JsonValue, O extends JsonValue>(
  id: string,
  input: z.ZodType<I>,
  output: z.ZodType<O>,
  execute: (value: I) => O | Promise<O>,
) {
  return defineStep({
    schemaVersion: 1,
    id,
    definitionVersion: "1",
    input,
    output,
    execute: async (_context, value) => execute(value as I),
  });
}

function singleStepGraph<I extends JsonValue, O extends JsonValue>(
  id: string,
  input: z.ZodType<I>,
  output: z.ZodType<O>,
  execute: (value: I) => O | Promise<O>,
): GraphDefinitionV1<I, O> {
  const node = graphStep({
    id: "body",
    input: graphRef.workflowInput<I>(),
    step: leaf(id, input, output, execute),
    inputSchema: z.toJSONSchema(input),
    outputSchema: z.toJSONSchema(output),
  });
  return defineGraph({ id, definitionVersion: "1", input: node.inputContract, nodes: [node], entry: node, result: node });
}

const address = (...path: GraphInstanceSegmentV1[]) => ({ schemaVersion: 1 as const, path });
function acceptedBoundary(plan: GraphEntryPlanV1, value: (role: string) => JsonValue) {
  return validateGraphEntryBoundaryV1(plan, {
    schemaVersion: 1,
    planSha256: plan.planSha256,
    values: Object.fromEntries(plan.requirements.map(requirement => [requirement.id, value(requirement.role)])),
  });
}

describe("durable serial graph scheduler", () => {
  it("retries an explicitly retryable node instance with the same checkpoints and reuses completed operations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-node-retry-"));
    let stableCalls = 0, flakyCalls = 0;
    const step = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1",
      input: z.number(), output: z.number(), execute: async (context, input) => {
        const stable = await context.effects.run({ schemaVersion: 1, operationId: "stable-read", definitionVersion: "1",
          safety: "read", input: z.number(), output: z.number(), execute: async (_operation, value) => {
            stableCalls++; return value + 1;
          } }, input);
        return context.effects.run({ schemaVersion: 1, operationId: "flaky-read", definitionVersion: "1",
          safety: "read", input: z.number(), output: z.number(), execute: async (_operation, value) => {
            flakyCalls++;
            if (flakyCalls === 1) throw new ExternalProviderError("fixture-provider", "Provider is busy.", {
              code: "provider_busy", retryability: "retryable",
            });
            return value * 2;
          } }, stable);
      } });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(), step,
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance", retries: [defineGraphRetryPolicyV1({
      schemaVersion: 1, kind: "retry", policyId: "retry-provider", policyVersion: "1", scope: "node-instance",
      maxAttempts: 2, retryOn: ["external-provider"], exhaustion: "propagate-failure",
    })] });
    const graph = defineWorkflow({ workflow: { kind: "node-retry-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "node-retry.result", input: number, nodes: [node], entry: node, result: node });

    expect(await (await scheduler(root)).execute({ graph, host: host("node-retry-run"), input: 10 })).toBe(22);
    expect({ stableCalls, flakyCalls }).toEqual({ stableCalls: 1, flakyCalls: 2 });

    const checkpointId = graphExecutionCheckpointIdV1(graph, address({ nodeId: "calculate" }), "step");
    const stepStore = new FileStepCheckpointStoreV2({ root });
    const effectStore = new FileEffectOperationStoreV1({ root });
    await expect(stepStore.read({ runRef: { executionId: "node-retry-run" }, stepId: checkpointId })).resolves.toMatchObject({
      state: "COMPLETED", attemptCount: 2,
      retryAdmissions: [{ policyId: "retry-provider", fromAttempt: 1 }],
    });
    await expect(effectStore.read({ runRef: { executionId: "node-retry-run" },
      operationId: `${checkpointId}:stable-read` })).resolves.toMatchObject({ state: "COMPLETED", attemptCount: 1 });
    await expect(effectStore.read({ runRef: { executionId: "node-retry-run" },
      operationId: `${checkpointId}:flaky-read` })).resolves.toMatchObject({ state: "COMPLETED", attemptCount: 2,
      retryAdmissions: [{ policyId: "retry-provider", fromAttempt: 1 }] });
  });

  it.each([
    ["subgraph-instance", "subgraph"],
    ["map-item", "map"],
    ["map-instance", "map"],
    ["reduce-iteration", "reduce"],
    ["reduce-instance", "reduce"],
    ["loop-iteration", "loop"],
    ["loop-instance", "loop"],
  ] as const)("retries a failed leaf through the exact %s scope", async (scope, kind) => {
    const root = await mkdtemp(path.join(tmpdir(), `durable-graph-${scope}-retry-`));
    let calls = 0;
    const failOnce = (): void => {
      calls++;
      if (calls === 1) throw new ExternalProviderError("fixture-provider", "Provider is busy.", {
        code: "provider_busy", retryability: "retryable",
      });
    };
    let control: GraphNodeV1;
    let input: JsonValue;
    let expected: JsonValue;
    let occurrence: GraphInstanceSegmentV1["occurrence"];
    if (kind === "subgraph") {
      const body = singleStepGraph("retry-subgraph-body", z.number(), z.number(), value => {
        failOnce(); return value + 1;
      });
      control = graphSubgraph({ id: "control", input: graphRef.workflowInput<number>(), body });
      input = 1;
      expected = 2;
      occurrence = { kind: "subgraph" };
    } else if (kind === "map") {
      const bodyInput = z.object({ item: z.number(), index: z.number(), context: z.null() });
      const body = singleStepGraph("retry-map-body", bodyInput, z.number(), value => {
        failOnce(); return value.item * 2;
      });
      const inputContract = objectSchema(z.object({ items: z.array(z.number()), context: z.null() }));
      control = graphMap({ id: "control", input: graphRef.workflowInput(), inputContract,
        outputContract: numbers, body });
      input = { items: [1], context: null };
      expected = [2];
      occurrence = { kind: "map", index: 0 };
    } else if (kind === "reduce") {
      const bodyInput = z.object({ item: z.number(), index: z.number(), accumulator: z.number(), context: z.null() });
      const body = singleStepGraph("retry-reduce-body", bodyInput, z.number(), value => {
        failOnce(); return value.accumulator + value.item;
      });
      const inputContract = objectSchema(z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() }));
      control = graphReduce({ id: "control", input: graphRef.workflowInput(), inputContract,
        outputContract: number, body });
      input = { items: [1], initial: 0, context: null };
      expected = 1;
      occurrence = { kind: "reduce", index: 0 };
    } else {
      const bodyInput = z.object({ state: z.number(), iteration: z.number(), context: z.null() });
      const body = singleStepGraph("retry-loop-body", bodyInput, z.number(), value => {
        failOnce(); return value.state + 1;
      });
      const inputContract = objectSchema(z.object({ state: z.number(), context: z.null() }));
      control = graphLoop({ id: "control", input: graphRef.workflowInput(), inputContract,
        outputContract: number, body, conditionVersion: "1",
        while: value => (value as { state: number }).state < 1 });
      input = { state: 0, context: null };
      expected = 1;
      occurrence = { kind: "loop", iteration: 0 };
    }
    const policyId = `retry-${scope}`;
    graphFailureBoundaryV1({ placement: control, scope, retries: [defineGraphRetryPolicyV1({
      schemaVersion: 1, kind: "retry", policyId, policyVersion: "1", scope,
      maxAttempts: 2, retryOn: ["external-provider"], exhaustion: "propagate-failure",
    })] });
    const graph = defineWorkflow({ workflow: { kind: `retry-${scope}`, version: 1 }, workflowContractVersion: "1",
      resultKind: `retry-${scope}.result`, input: control.inputContract,
      nodes: [control], entry: control, result: control });
    const executionId = `retry-${scope}-run`;

    expect(await (await scheduler(root)).execute({ graph, host: host(executionId), input })).toEqual(expected);
    expect(calls).toBe(2);
    if (!occurrence) throw new Error(`Retry fixture ${scope} has no control occurrence.`);
    const scopeAddress = scope.endsWith("instance")
      ? address({ nodeId: "control" })
      : address({ nodeId: "control", occurrence });
    const markerId = graphExecutionCheckpointIdV1(graph, scopeAddress,
      `control-retry-${policyId}-scope-attempt-2`);
    const leafId = graphExecutionCheckpointIdV1(graph,
      address({ nodeId: "control", occurrence }, { nodeId: "body" }), "step");
    const store = new FileStepCheckpointStoreV2({ root });
    await expect(store.read({ runRef: { executionId }, stepId: markerId }))
      .resolves.toMatchObject({ state: "COMPLETED", attemptCount: 1 });
    await expect(store.read({ runRef: { executionId }, stepId: leafId }))
      .resolves.toMatchObject({ state: "COMPLETED", attemptCount: 2 });
  });

  it("counts control retry attempts for the scope instead of resetting for a later leaf", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-control-retry-budget-"));
    let firstCalls = 0, secondCalls = 0;
    const fail = (message: string): never => {
      throw new ExternalProviderError("fixture-provider", message, {
        code: "provider_busy", retryability: "retryable",
      });
    };
    const first = graphStep({ id: "first", input: graphRef.workflowInput<number>(),
      step: leaf("first", z.number(), z.number(), value => {
        firstCalls++;
        if (firstCalls === 1) return fail("First leaf is busy.");
        return value + 1;
      }), inputSchema: number.schema, outputSchema: number.schema });
    const second = graphStep({ id: "second", input: graphRef.output(first),
      step: leaf("second", z.number(), z.number(), () => {
        secondCalls++;
        return fail("Second leaf is busy.");
      }), inputSchema: number.schema, outputSchema: number.schema });
    const body = defineGraph({ id: "control-retry-budget-body", definitionVersion: "1", input: number,
      nodes: [first, second], entry: first, result: second });
    const control = graphSubgraph({ id: "control", input: graphRef.workflowInput<number>(), body });
    graphFailureBoundaryV1({ placement: control, scope: "subgraph-instance", retries: [defineGraphRetryPolicyV1({
      schemaVersion: 1, kind: "retry", policyId: "retry-control", policyVersion: "1",
      scope: "subgraph-instance", maxAttempts: 2, retryOn: ["external-provider"], exhaustion: "propagate-failure",
    })] });
    const graph = defineWorkflow({ workflow: { kind: "control-retry-budget", version: 1 }, workflowContractVersion: "1",
      resultKind: "control-retry-budget.result", input: number,
      nodes: [control], entry: control, result: control });

    await expect((await scheduler(root)).execute({ graph, host: host("control-retry-budget-run"), input: 1 }))
      .rejects.toThrow("Second leaf is busy.");
    expect({ firstCalls, secondCalls }).toEqual({ firstCalls: 2, secondCalls: 1 });
  });

  it("retries a retained loop condition through the whole loop scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-loop-condition-retry-"));
    let conditionCalls = 0;
    const bodyInput = z.object({ state: z.number(), iteration: z.number(), context: z.null() });
    const body = singleStepGraph("loop-condition-retry-body", bodyInput, z.number(), value => value.state + 1);
    const inputContract = objectSchema(z.object({ state: z.number(), context: z.null() }));
    const control = graphLoop({ id: "control", input: graphRef.workflowInput(), inputContract,
      outputContract: number, body, conditionVersion: "1", while: value => {
        conditionCalls++;
        if (conditionCalls === 1) throw new ExternalProviderError("fixture-provider", "Condition provider is busy.", {
          code: "provider_busy", retryability: "retryable",
        });
        return (value as { state: number }).state < 1;
      } });
    graphFailureBoundaryV1({ placement: control, scope: "loop-instance", retries: [defineGraphRetryPolicyV1({
      schemaVersion: 1, kind: "retry", policyId: "retry-loop-condition", policyVersion: "1",
      scope: "loop-instance", maxAttempts: 2, retryOn: ["external-provider"], exhaustion: "propagate-failure",
    })] });
    const graph = defineWorkflow({ workflow: { kind: "loop-condition-retry", version: 1 }, workflowContractVersion: "1",
      resultKind: "loop-condition-retry.result", input: inputContract,
      nodes: [control], entry: control, result: control });

    await expect((await scheduler(root)).execute({ graph, host: host("loop-condition-retry-run"),
      input: { state: 0, context: null } })).resolves.toBe(1);
    expect(conditionCalls).toBe(3);
    const conditionId = graphExecutionCheckpointIdV1(graph, address({ nodeId: "control" }), "loop-condition-0");
    await expect(new FileStepCheckpointStoreV2({ root }).read({
      runRef: { executionId: "loop-condition-retry-run" }, stepId: conditionId,
    })).resolves.toMatchObject({ state: "COMPLETED", attemptCount: 2 });
  });

  it("does not infer retryability from a provider message or HTTP status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-unknown-retry-"));
    let calls = 0;
    const step = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1",
      input: z.number(), output: z.number(), execute: async () => {
        calls++;
        throw new ExternalProviderError("fixture-provider", "HTTP 503. Retry later.", { httpStatus: 503 });
      } });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(), step,
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance", retries: [defineGraphRetryPolicyV1({
      schemaVersion: 1, kind: "retry", policyId: "retry-provider", policyVersion: "1", scope: "node-instance",
      maxAttempts: 2, retryOn: ["external-provider"], exhaustion: "propagate-failure",
    })] });
    const graph = defineWorkflow({ workflow: { kind: "unknown-retry-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "unknown-retry.result", input: number, nodes: [node], entry: node, result: node });

    await expect((await scheduler(root)).execute({ graph, host: host("unknown-retry-run"), input: 10 }))
      .rejects.toThrow("HTTP 503. Retry later.");
    expect(calls).toBe(1);
  });

  it("runs one retained catch after retry exhaustion and replays its recovery without callbacks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-node-catch-"));
    let failingCalls = 0;
    const catchCalls = vi.fn(async (_context: unknown, value: GraphCatchHandlerInputV1<number>) => {
      expect(value.failure).toMatchObject({ class: "external-provider", code: "provider_busy",
        retryability: "retryable", instance: { attempt: 2 } });
      expect(value.scope.address.path).toEqual([{ nodeId: "calculate" }]);
      return value.scope.input + 100;
    });
    const step = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "1",
      input: z.number(), output: z.number(), execute: async () => {
        failingCalls++;
        throw new ExternalProviderError("fixture-provider", "Provider is still busy.", {
          code: "provider_busy", retryability: "retryable",
        });
      } });
    const catchHandler = defineStep({ schemaVersion: 1, id: "recover-calculation", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1<number>>(), output: z.number(), execute: catchCalls });
    const cleanupCalls = vi.fn(async (_context: unknown, value: GraphCleanupHandlerInputV1<number>) => {
      expect(value.original).toEqual({ status: "succeeded" });
      expect(value.scope).toMatchObject({ address: { path: [{ nodeId: "calculate" }] }, input: 10 });
      return null;
    });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "release-calculation", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: cleanupCalls });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(), step,
      inputSchema: number.schema, outputSchema: number.schema });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance",
      retries: [defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-provider",
        policyVersion: "1", scope: "node-instance", maxAttempts: 2,
        retryOn: ["external-provider"], exhaustion: "propagate-failure" })],
      catches: [{ policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch",
        policyId: "recover-provider", policyVersion: "1", handlerDefinitionId: "recover-calculation",
        failures: [{ class: "external-provider", codes: ["provider_busy"] }], output: number,
        afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: catchHandler }],
      cleanup: [{ policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup",
        policyId: "release-calculation", policyVersion: "1", handlerDefinitionId: "release-calculation",
        triggers: ["success"], execution: "once-per-scope-outcome",
        failureMode: "fail-run-preserve-original" }), handler: cleanupHandler }],
    });
    const graph = defineWorkflow({ workflow: { kind: "node-catch-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "node-catch.result", input: number, nodes: [node], entry: node, result: node });
    const runtime = await scheduler(root);

    await expect(runtime.execute({ graph, host: host("node-catch-run"), input: 10 })).resolves.toBe(110);
    expect({ failingCalls, catchCalls: catchCalls.mock.calls.length, cleanupCalls: cleanupCalls.mock.calls.length })
      .toEqual({ failingCalls: 2, catchCalls: 1, cleanupCalls: 1 });

    const stepStore = new FileStepCheckpointStoreV2({ root });
    const nodeAddress = address({ nodeId: "calculate" });
    const originalId = graphExecutionCheckpointIdV1(graph, nodeAddress, "step");
    const handlerId = graphExecutionCheckpointIdV1(graph, nodeAddress, "catch-recover-provider-handler");
    const recoveryId = graphExecutionCheckpointIdV1(graph, nodeAddress, "catch-recover-provider-recovery");
    const cleanupId = graphExecutionCheckpointIdV1(graph, nodeAddress, "cleanup-release-calculation-handler");
    const cleanupRecordId = graphExecutionCheckpointIdV1(graph, nodeAddress, "cleanup-release-calculation-record");
    await expect(stepStore.read({ runRef: { executionId: "node-catch-run" }, stepId: originalId }))
      .resolves.toMatchObject({ state: "FAILED", attemptCount: 2,
        retryAdmissions: [{ policyId: "retry-provider", fromAttempt: 1 }] });
    await expect(stepStore.read({ runRef: { executionId: "node-catch-run" }, stepId: handlerId }))
      .resolves.toMatchObject({ state: "COMPLETED", attemptCount: 1, completed: { output: 110 } });
    await expect(stepStore.read({ runRef: { executionId: "node-catch-run" }, stepId: recoveryId }))
      .resolves.toMatchObject({ state: "COMPLETED", attemptCount: 1, completed: { output: {
        status: "recovered", policyId: "recover-provider", originalFailure: { code: "provider_busy" }, output: 110,
      } } });
    await expect(stepStore.read({ runRef: { executionId: "node-catch-run" }, stepId: cleanupId }))
      .resolves.toMatchObject({ state: "COMPLETED", attemptCount: 1 });
    await expect(stepStore.read({ runRef: { executionId: "node-catch-run" }, stepId: cleanupRecordId }))
      .resolves.toMatchObject({ state: "COMPLETED", attemptCount: 1, completed: { output: {
        policyId: "release-calculation", original: { status: "succeeded" }, cleanup: { status: "completed" },
      } } });

    await expect(runtime.execute({ graph, host: host("node-catch-run", "attempt-2", 2), input: 10 })).resolves.toBe(110);
    expect({ failingCalls, catchCalls: catchCalls.mock.calls.length, cleanupCalls: cleanupCalls.mock.calls.length })
      .toEqual({ failingCalls: 2, catchCalls: 1, cleanupCalls: 1 });
  });

  it("runs retained cleanup once after success and replays its record without callbacks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-success-cleanup-"));
    const stepCalls = vi.fn((value: number) => value + 1);
    const cleanupCalls = vi.fn(async (_context: unknown, value: GraphCleanupHandlerInputV1<number>) => {
      expect(value).toMatchObject({ original: { status: "succeeded" }, scope: { input: 10 } });
      return null;
    });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(),
      step: leaf("calculate", z.number(), z.number(), stepCalls),
      inputSchema: number.schema, outputSchema: number.schema });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "release-resource", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: cleanupCalls });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance", cleanup: [{
      policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "release-resource",
        policyVersion: "1", handlerDefinitionId: "release-resource", triggers: ["success"],
        execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" }),
      handler: cleanupHandler,
    }] });
    const graph = defineWorkflow({ workflow: { kind: "success-cleanup-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "success-cleanup.result", input: number, nodes: [node], entry: node, result: node });
    const runtime = await scheduler(root);

    await expect(runtime.execute({ graph, host: host("success-cleanup-run"), input: 10 })).resolves.toBe(11);
    await expect(runtime.execute({ graph, host: host("success-cleanup-run", "attempt-2", 2), input: 10 })).resolves.toBe(11);
    expect({ stepCalls: stepCalls.mock.calls.length, cleanupCalls: cleanupCalls.mock.calls.length })
      .toEqual({ stepCalls: 1, cleanupCalls: 1 });
  });

  it("runs retained cleanup after an unhandled failure and preserves the original error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-failure-cleanup-"));
    const stepCalls = vi.fn(() => { throw new Error("Calculation failed."); });
    const cleanupCalls = vi.fn(async (_context: unknown, value: GraphCleanupHandlerInputV1<number>) => {
      expect(value.original).toMatchObject({ status: "failed", failure: { code: "step_failed" } });
      return null;
    });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(),
      step: leaf("calculate", z.number(), z.number(), stepCalls),
      inputSchema: number.schema, outputSchema: number.schema });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "release-failed-resource", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: cleanupCalls });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance", cleanup: [{
      policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "release-failed-resource",
        policyVersion: "1", handlerDefinitionId: "release-failed-resource", triggers: ["failure"],
        execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" }),
      handler: cleanupHandler,
    }] });
    const graph = defineWorkflow({ workflow: { kind: "failure-cleanup-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "failure-cleanup.result", input: number, nodes: [node], entry: node, result: node });
    const runtime = await scheduler(root);

    await expect(runtime.execute({ graph, host: host("failure-cleanup-run"), input: 10 })).rejects.toThrow("Calculation failed.");
    await expect(runtime.execute({ graph, host: host("failure-cleanup-run", "attempt-2", 2), input: 10 }))
      .rejects.toThrow("The workflow operation failed. Inspect its runtime diagnostics before retrying.");
    expect({ stepCalls: stepCalls.mock.calls.length, cleanupCalls: cleanupCalls.mock.calls.length })
      .toEqual({ stepCalls: 1, cleanupCalls: 1 });
  });

  it.each([
    ["fail-run-preserve-original", false],
    ["record-only-preserve-original", true],
  ] as const)("applies cleanup failure mode %s without repeating the handler", async (failureMode, succeeds) => {
    const root = await mkdtemp(path.join(tmpdir(), `durable-graph-cleanup-failure-${failureMode}-`));
    const stepCalls = vi.fn((value: number) => value + 1);
    const cleanupCalls = vi.fn(async () => { throw new Error("Cleanup failed."); });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(),
      step: leaf("calculate", z.number(), z.number(), stepCalls),
      inputSchema: number.schema, outputSchema: number.schema });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "failing-cleanup", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: cleanupCalls });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance", cleanup: [{
      policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "failing-cleanup",
        policyVersion: "1", handlerDefinitionId: "failing-cleanup", triggers: ["success"],
        execution: "once-per-scope-outcome", failureMode }), handler: cleanupHandler,
    }] });
    const graph = defineWorkflow({ workflow: { kind: `cleanup-failure-${failureMode}`, version: 1 },
      workflowContractVersion: "1", resultKind: "cleanup-failure.result", input: number,
      nodes: [node], entry: node, result: node });
    const runtime = await scheduler(root);
    const execute = (attemptId: string, fence: number) => runtime.execute({
      graph, host: host(`cleanup-failure-${failureMode}`, attemptId, fence), input: 10,
    });

    if (succeeds) {
      await expect(execute("attempt-1", 1)).resolves.toBe(11);
      await expect(execute("attempt-2", 2)).resolves.toBe(11);
    } else {
      await expect(execute("attempt-1", 1)).rejects.toThrow("Cleanup failed.");
      await expect(execute("attempt-2", 2))
        .rejects.toThrow("The workflow operation failed. Inspect its runtime diagnostics before retrying.");
    }
    expect({ stepCalls: stepCalls.mock.calls.length, cleanupCalls: cleanupCalls.mock.calls.length })
      .toEqual({ stepCalls: 1, cleanupCalls: 1 });
  });

  it("keeps an ambiguous cleanup effect outcome unknown without writing a cleanup record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-cleanup-unknown-"));
    const cleanupCalls = vi.fn(async (context: StepExecutionContextV1) => {
      await context.effects.run({ schemaVersion: 1, operationId: "release-resource", definitionVersion: "1",
        safety: "unsafe-write", input: z.null(), output: z.null(),
        execute: async () => { throw new Error("Release response was lost."); } }, null);
      return null;
    });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(),
      step: leaf("calculate", z.number(), z.number(), value => value + 1),
      inputSchema: number.schema, outputSchema: number.schema });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "release-resource", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: cleanupCalls });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance", cleanup: [{
      policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "release-resource",
        policyVersion: "1", handlerDefinitionId: "release-resource", triggers: ["success"],
        execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" }),
      handler: cleanupHandler,
    }] });
    const graph = defineWorkflow({ workflow: { kind: "cleanup-unknown-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "cleanup-unknown.result", input: number, nodes: [node], entry: node, result: node });
    const execute = (attemptId: string, fence: number) => scheduler(root).then(runtime => runtime.execute({
      graph, host: host("cleanup-unknown-run", attemptId, fence), input: 10,
    }));

    await expect(execute("attempt-1", 1)).rejects.toThrow();
    await expect(execute("attempt-2", 2)).rejects.toThrow();
    expect(cleanupCalls).toHaveBeenCalledOnce();
    const recordId = graphExecutionCheckpointIdV1(graph, address({ nodeId: "calculate" }), "cleanup-release-resource-record");
    await expect(new FileStepCheckpointStoreV2({ root }).read({ runRef: { executionId: "cleanup-unknown-run" }, stepId: recordId }))
      .resolves.toBeUndefined();
  });

  it("propagates an unmatched failure without running its catch handler", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-unmatched-catch-"));
    const catchHandler = defineStep({ schemaVersion: 1, id: "recover-provider", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1<number>>(), output: z.number(), execute: vi.fn(async () => 1) });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(),
      step: leaf("calculate", z.number(), z.number(), () => { throw new Error("Calculation failed."); }),
      inputSchema: number.schema, outputSchema: number.schema });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance",
      catches: [{ policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch",
        policyId: "recover-provider", policyVersion: "1", handlerDefinitionId: "recover-provider",
        failures: [{ class: "external-provider" }], output: number,
        afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: catchHandler }],
    });
    const graph = defineWorkflow({ workflow: { kind: "unmatched-catch-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "unmatched-catch.result", input: number, nodes: [node], entry: node, result: node });

    await expect((await scheduler(root)).execute({ graph, host: host("unmatched-catch-run"), input: 10 }))
      .rejects.toThrow("Calculation failed.");
    expect(catchHandler.execute).not.toHaveBeenCalled();
  });

  it("propagates cancellation without running a matching catch handler", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-cancelled-catch-"));
    const cancellation: { aborted: boolean; reason: "cancelled" } = { aborted: false, reason: "cancelled" };
    const catchHandler = defineStep({ schemaVersion: 1, id: "recover-cancelled", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1<number>>(), output: z.number(), execute: vi.fn(async () => 1) });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(),
      step: leaf("calculate", z.number(), z.number(), () => {
        cancellation.aborted = true;
        throw new Error("Stop requested.");
      }),
      inputSchema: number.schema, outputSchema: number.schema });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance",
      catches: [{ policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch",
        policyId: "recover-cancelled", policyVersion: "1", handlerDefinitionId: "recover-cancelled",
        failures: [{ class: "workflow" }], output: number,
        afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: catchHandler }],
    });
    const graph = defineWorkflow({ workflow: { kind: "cancelled-catch-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "cancelled-catch.result", input: number, nodes: [node], entry: node, result: node });

    await expect((await scheduler(root)).execute({
      graph, host: { ...host("cancelled-catch-run"), cancellation }, input: 10,
    })).rejects.toThrow("Stop requested.");
    expect(catchHandler.execute).not.toHaveBeenCalled();
    const stepId = graphExecutionCheckpointIdV1(graph, address({ nodeId: "calculate" }), "step");
    await expect(new FileStepCheckpointStoreV2({ root }).read({
      runRef: { executionId: "cancelled-catch-run" }, stepId,
    })).resolves.toMatchObject({ state: "CANCELLED", terminal: { code: "cancelled" } });
  });

  it("runs cancellation cleanup in finalization reserve and keeps cancellation terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-cancelled-cleanup-"));
    const cancellation: { aborted: boolean; reason: "cancelled" } = { aborted: false, reason: "cancelled" };
    const cleanupCalls = vi.fn(async (_context: unknown, value: GraphCleanupHandlerInputV1<number>) => {
      expect(value.original).toEqual({ status: "cancelled", reason: "cancelled" });
      return null;
    });
    const node = graphStep({ id: "calculate", input: graphRef.workflowInput<number>(),
      step: leaf("calculate", z.number(), z.number(), () => {
        cancellation.aborted = true;
        throw new Error("Stop requested.");
      }),
      inputSchema: number.schema, outputSchema: number.schema });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "release-cancelled-resource", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: cleanupCalls });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance", cleanup: [{
      policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "release-cancelled-resource",
        policyVersion: "1", handlerDefinitionId: "release-cancelled-resource", triggers: ["cancellation"],
        execution: "once-per-scope-outcome", failureMode: "record-only-preserve-original" }),
      handler: cleanupHandler,
    }] });
    const graph = defineWorkflow({ workflow: { kind: "cancelled-cleanup-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "cancelled-cleanup.result", input: number, nodes: [node], entry: node, result: node });

    await expect((await scheduler(root)).execute({
      graph, host: { ...host("cancelled-cleanup-run"), cancellation }, input: 10,
    })).rejects.toThrow("Stop requested.");
    await expect((await scheduler(root)).execute({
      graph, host: host("cancelled-cleanup-run", "attempt-2", 2), input: 10,
    })).rejects.toThrow();
    expect(cleanupCalls).toHaveBeenCalledOnce();
    const nodeAddress = address({ nodeId: "calculate" });
    const recordId = graphExecutionCheckpointIdV1(graph, nodeAddress, "cleanup-release-cancelled-resource-record");
    await expect(new FileStepCheckpointStoreV2({ root }).read({
      runRef: { executionId: "cancelled-cleanup-run" }, stepId: recordId,
    })).resolves.toMatchObject({ state: "COMPLETED", completed: { output: {
      original: { status: "cancelled", reason: "cancelled" }, cleanup: { status: "completed" },
    } } });
  });

  it("propagates an unknown write outcome without running a matching catch handler", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-unknown-outcome-catch-"));
    const catchHandler = defineStep({ schemaVersion: 1, id: "recover-write", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1<number>>(), output: z.number(), execute: vi.fn(async () => 1) });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "cleanup-write", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: vi.fn(async () => null) });
    const step = defineStep({ schemaVersion: 1, id: "write", definitionVersion: "1",
      input: z.number(), output: z.number(), execute: async (context, input) => context.effects.run({
        schemaVersion: 1,
        operationId: "ambiguous-write",
        definitionVersion: "1",
        safety: "unsafe-write",
        input: z.number(),
        output: z.number(),
        execute: async () => { throw new Error("Write response was lost."); },
      }, input) });
    const node = graphStep({ id: "write", input: graphRef.workflowInput<number>(), step,
      inputSchema: number.schema, outputSchema: number.schema });
    graphFailureBoundaryV1({ placement: node, scope: "node-instance",
      catches: [{ policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch",
        policyId: "recover-write", policyVersion: "1", handlerDefinitionId: "recover-write",
        failures: [{ class: "workflow" }], output: number,
        afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: catchHandler }],
      cleanup: [{ policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup",
        policyId: "cleanup-write", policyVersion: "1", handlerDefinitionId: "cleanup-write",
        triggers: ["success", "failure", "cancellation"], execution: "once-per-scope-outcome",
        failureMode: "fail-run-preserve-original" }), handler: cleanupHandler }],
    });
    const graph = defineWorkflow({ workflow: { kind: "unknown-outcome-catch-fixture", version: 1 },
      workflowContractVersion: "1", resultKind: "unknown-outcome-catch.result", input: number,
      nodes: [node], entry: node, result: node });

    await expect((await scheduler(root)).execute({ graph, host: host("unknown-outcome-catch-run"), input: 10 }))
      .rejects.toThrow("The workflow operation failed. Inspect its runtime diagnostics before retrying.");
    expect(catchHandler.execute).not.toHaveBeenCalled();
    expect(cleanupHandler.execute).not.toHaveBeenCalled();
    const stepId = graphExecutionCheckpointIdV1(graph, address({ nodeId: "write" }), "step");
    await expect(new FileStepCheckpointStoreV2({ root }).read({
      runRef: { executionId: "unknown-outcome-catch-run" }, stepId,
    })).resolves.toMatchObject({ state: "OUTCOME_UNKNOWN", terminal: { code: "outcome_unknown" } });
  });

  it("rejects node-instance policies on controls during construction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-unsupported-catch-"));
    const bodyCalls = vi.fn((value: number) => value + 1);
    const body = singleStepGraph("body", z.number(), z.number(), bodyCalls);
    const control = graphSubgraph({ id: "control", input: graphRef.workflowInput<number>(), body });
    const catchHandler = defineStep({ schemaVersion: 1, id: "recover-control", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1<number>>(), output: z.number(), execute: async () => 1 });
    expect(() => graphFailureBoundaryV1({ placement: control, scope: "node-instance",
      catches: [{ policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch",
        policyId: "recover-control", policyVersion: "1", handlerDefinitionId: "recover-control",
        failures: [{ class: "workflow" }], output: number,
        afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: catchHandler }],
    })).toThrow("requires a step placement");
    expect(bodyCalls).not.toHaveBeenCalled();
  });

  it("recovers one map item and runs item cleanup with the exact indexed scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-map-item-boundary-"));
    const bodyCalls = vi.fn((value: { item: number; index: number; context: null }) => {
      if (value.index === 1) throw new Error("Item failed.");
      return value.item * 2;
    });
    const catchCalls = vi.fn((value: GraphCatchHandlerInputV1<{ item: number; index: number; context: null }>) => {
      expect(value.scope.address.path).toEqual([{ nodeId: "mapped", occurrence: { kind: "map", index: 1 } }]);
      return 99;
    });
    const cleanupCalls = vi.fn((value: GraphCleanupHandlerInputV1<{ item: number; index: number; context: null }>) => {
      expect(value.scope.address.path[0]?.occurrence).toEqual({ kind: "map", index: value.scope.input.index });
      return null;
    });
    const itemInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), context: z.null() });
    const body = singleStepGraph("map-item-boundary-body", itemInput, z.number(), bodyCalls);
    const mapInput = objectSchema(z.object({ items: z.array(z.number()), context: z.null() }));
    const mapped = graphMap({ id: "mapped", input: graphRef.workflowInput(), inputContract: mapInput,
      outputContract: numbers, body });
    const catchHandler = defineStep({ schemaVersion: 1, id: "recover-map-item", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1<{ item: number; index: number; context: null }>>(),
      output: z.number(), execute: async (_context, value) => catchCalls(value) });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "cleanup-map-item", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<{ item: number; index: number; context: null }>>(),
      output: z.null(), execute: async (_context, value) => cleanupCalls(value) });
    graphFailureBoundaryV1({ placement: mapped, scope: "map-item",
      catches: [{ policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover-map-item",
        policyVersion: "1", handlerDefinitionId: "recover-map-item", failures: [{ class: "workflow" }], output: number,
        afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: catchHandler }],
      cleanup: [{ policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "cleanup-map-item",
        policyVersion: "1", handlerDefinitionId: "cleanup-map-item", triggers: ["success"],
        execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" }), handler: cleanupHandler }],
    });
    const graph = defineWorkflow({ workflow: { kind: "map-item-boundary", version: 1 }, workflowContractVersion: "1",
      resultKind: "map-item-boundary.result", input: mapInput, nodes: [mapped], entry: mapped, result: mapped });
    const runtime = await scheduler(root);
    const input = { items: [1, 2, 3], context: null } as const;

    expect(await runtime.execute({ graph, host: host("map-item-boundary-run"), input })).toEqual([2, 99, 6]);
    expect(bodyCalls).toHaveBeenCalledTimes(3);
    expect(catchCalls).toHaveBeenCalledOnce();
    expect(cleanupCalls).toHaveBeenCalledTimes(3);
    expect(await runtime.execute({ graph, host: host("map-item-boundary-run", "attempt-2", 2), input })).toEqual([2, 99, 6]);
    expect(bodyCalls).toHaveBeenCalledTimes(3);
    expect(catchCalls).toHaveBeenCalledOnce();
    expect(cleanupCalls).toHaveBeenCalledTimes(3);
  });

  it("recovers reduce and loop iterations before continuing their serial controls", async () => {
    const reduceRoot = await mkdtemp(path.join(tmpdir(), "durable-graph-reduce-iteration-boundary-"));
    const reduceInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), accumulator: z.number(), context: z.null() });
    const reduceBody = singleStepGraph("reduce-iteration-boundary-body", reduceInput, z.number(), value => {
      if (value.index === 1) throw new Error("Reduce iteration failed.");
      return value.accumulator + value.item;
    });
    const reduceContract = objectSchema(z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() }));
    const reduced = graphReduce({ id: "reduced", input: graphRef.workflowInput(), inputContract: reduceContract,
      outputContract: number, body: reduceBody });
    const reduceCatch = defineStep({ schemaVersion: 1, id: "recover-reduce-iteration", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1>(), output: z.number(), execute: async () => 50 });
    graphFailureBoundaryV1({ placement: reduced, scope: "reduce-iteration", catches: [{
      policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover-reduce-iteration",
        policyVersion: "1", handlerDefinitionId: "recover-reduce-iteration", failures: [{ class: "workflow" }], output: number,
        afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: reduceCatch,
    }] });
    const reduceGraph = defineWorkflow({ workflow: { kind: "reduce-iteration-boundary", version: 1 }, workflowContractVersion: "1",
      resultKind: "reduce-iteration-boundary.result", input: reduceContract, nodes: [reduced], entry: reduced, result: reduced });
    expect(await (await scheduler(reduceRoot)).execute({ graph: reduceGraph, host: host("reduce-iteration-boundary-run"),
      input: { items: [1, 2, 3], initial: 0, context: null } })).toBe(53);

    const loopRoot = await mkdtemp(path.join(tmpdir(), "durable-graph-loop-iteration-boundary-"));
    const loopInput = z.object({ state: z.number(), iteration: z.number().int().nonnegative(), context: z.null() });
    const loopBody = singleStepGraph("loop-iteration-boundary-body", loopInput, z.number(), value => {
      if (value.iteration === 1) throw new Error("Loop iteration failed.");
      return value.state + 1;
    });
    const loopContract = objectSchema(z.object({ state: z.number(), context: z.null() }));
    const looped = graphLoop({ id: "looped", input: graphRef.workflowInput(), inputContract: loopContract,
      outputContract: number, body: loopBody, conditionVersion: "1",
      while: value => (value as { state: number }).state < 12 });
    const loopCatch = defineStep({ schemaVersion: 1, id: "recover-loop-iteration", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1>(), output: z.number(), execute: async () => 10 });
    graphFailureBoundaryV1({ placement: looped, scope: "loop-iteration", catches: [{
      policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "recover-loop-iteration",
        policyVersion: "1", handlerDefinitionId: "recover-loop-iteration", failures: [{ class: "workflow" }], output: number,
        afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: loopCatch,
    }] });
    const loopGraph = defineWorkflow({ workflow: { kind: "loop-iteration-boundary", version: 1 }, workflowContractVersion: "1",
      resultKind: "loop-iteration-boundary.result", input: loopContract, nodes: [looped], entry: looped, result: looped });
    expect(await (await scheduler(loopRoot)).execute({ graph: loopGraph, host: host("loop-iteration-boundary-run"),
      input: { state: 0, context: null } })).toBe(12);
  });

  it.each([
    ["subgraph-instance", "subgraph"], ["map-instance", "map"],
    ["reduce-instance", "reduce"], ["loop-instance", "loop"],
  ] as const)("recovers a failed %s as one whole %s output", async (scope, kind) => {
    const root = await mkdtemp(path.join(tmpdir(), `durable-graph-${kind}-instance-boundary-`));
    const failingNumber = singleStepGraph(`${kind}-instance-body`, z.number(), z.number(), () => { throw new Error("Control failed."); });
    let control: GraphNodeV1;
    let input: JsonValue;
    let outputContract: GraphValueContractV1 = number;
    if (kind === "subgraph") {
      control = graphSubgraph({ id: "control", input: graphRef.workflowInput<number>(), body: failingNumber });
      input = 1;
    } else if (kind === "map") {
      const bodyInput = z.object({ item: z.number(), index: z.number(), context: z.null() });
      const body = singleStepGraph("map-instance-body", bodyInput, z.number(), () => { throw new Error("Control failed."); });
      const contract = objectSchema(z.object({ items: z.array(z.number()), context: z.null() }));
      outputContract = numbers;
      control = graphMap({ id: "control", input: graphRef.workflowInput(), inputContract: contract, outputContract, body });
      input = { items: [1], context: null };
    } else if (kind === "reduce") {
      const bodyInput = z.object({ item: z.number(), index: z.number(), accumulator: z.number(), context: z.null() });
      const body = singleStepGraph("reduce-instance-body", bodyInput, z.number(), () => { throw new Error("Control failed."); });
      const contract = objectSchema(z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() }));
      control = graphReduce({ id: "control", input: graphRef.workflowInput(), inputContract: contract, outputContract, body });
      input = { items: [1], initial: 0, context: null };
    } else {
      const bodyInput = z.object({ state: z.number(), iteration: z.number(), context: z.null() });
      const body = singleStepGraph("loop-instance-body", bodyInput, z.number(), () => { throw new Error("Control failed."); });
      const contract = objectSchema(z.object({ state: z.number(), context: z.null() }));
      control = graphLoop({ id: "control", input: graphRef.workflowInput(), inputContract: contract, outputContract,
        body, conditionVersion: "1", while: () => true });
      input = { state: 0, context: null };
    }
    const recoveredOutput = kind === "map" ? [7] : 7;
    const catchHandler = defineStep({ schemaVersion: 1, id: `recover-${kind}`, definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1>(), output: outputContract.validator,
      execute: async () => recoveredOutput });
    graphFailureBoundaryV1({ placement: control, scope, catches: [{ policy: defineGraphCatchPolicyV1({
      schemaVersion: 1, kind: "catch", policyId: `recover-${kind}`, policyVersion: "1",
      handlerDefinitionId: `recover-${kind}`, failures: [{ class: "workflow" }], output: outputContract,
      afterRetry: "exhausted-or-not-retryable", cancellation: "propagate",
    }), handler: catchHandler }] });
    const graph = defineWorkflow({ workflow: { kind: `${kind}-instance-boundary`, version: 1 }, workflowContractVersion: "1",
      resultKind: `${kind}-instance-boundary.result`, input: control.inputContract, nodes: [control], entry: control, result: control });
    expect(await (await scheduler(root)).execute({ graph, host: host(`${kind}-instance-boundary-run`), input })).toEqual(recoveredOutput);
  });

  it("runs whole-control failure cleanup once and preserves the original error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-control-failure-cleanup-"));
    const bodyCalls = vi.fn(() => { throw new Error("Subgraph failed."); });
    const body = singleStepGraph("control-failure-cleanup-body", z.number(), z.number(), bodyCalls);
    const control = graphSubgraph({ id: "control", input: graphRef.workflowInput<number>(), body });
    const cleanupCalls = vi.fn(async (_context: unknown, value: GraphCleanupHandlerInputV1<number>) => {
      expect(value).toMatchObject({
        original: { status: "failed", failure: { code: "step_failed" } },
        scope: { address: { path: [{ nodeId: "control" }] }, input: 10 },
      });
      return null;
    });
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "cleanup-control", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: cleanupCalls });
    graphFailureBoundaryV1({ placement: control, scope: "subgraph-instance", cleanup: [{
      policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "cleanup-control",
        policyVersion: "1", handlerDefinitionId: "cleanup-control", triggers: ["failure"],
        execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" }), handler: cleanupHandler,
    }] });
    const graph = defineWorkflow({ workflow: { kind: "control-failure-cleanup", version: 1 }, workflowContractVersion: "1",
      resultKind: "control-failure-cleanup.result", input: number, nodes: [control], entry: control, result: control });
    const runtime = await scheduler(root);

    await expect(runtime.execute({ graph, host: host("control-failure-cleanup-run"), input: 10 }))
      .rejects.toThrow("Subgraph failed.");
    await expect(runtime.execute({ graph, host: host("control-failure-cleanup-run", "attempt-2", 2), input: 10 }))
      .rejects.toThrow("The workflow operation failed. Inspect its runtime diagnostics before retrying.");
    expect(bodyCalls).toHaveBeenCalledOnce();
    expect(cleanupCalls).toHaveBeenCalledOnce();
  });

  it("runs retry, catch and cleanup for selected-entry control scopes without fabricating skipped history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-selected-policy-"));
    const callback = vi.fn((value: { item: number; index: number; context: null }) => {
      if (value.index === 0) throw new ExternalProviderError("fixture-provider", "Selected item is busy.", {
        code: "provider_busy", retryability: "retryable",
      });
      return value.item;
    });
    const bodyInput = z.object({ item: z.number(), index: z.number(), context: z.null() });
    const body = singleStepGraph("selected-policy-body", bodyInput, z.number(), callback);
    const mapInput = objectSchema(z.object({ items: z.array(z.number()), context: z.null() }));
    const mapped = graphMap({ id: "mapped", input: graphRef.workflowInput(), inputContract: mapInput,
      outputContract: numbers, body });
    const catchCalls = vi.fn((value: GraphCatchHandlerInputV1) => {
      expect(value.scope.address.path).toEqual([{ nodeId: "mapped", occurrence: { kind: "map", index: 0 } }]);
      return 99;
    });
    const catchHandler = defineStep({ schemaVersion: 1, id: "catch-selected-item", definitionVersion: "1",
      input: z.custom<GraphCatchHandlerInputV1>(), output: z.number(),
      execute: async (_context, value) => catchCalls(value) });
    const itemCleanupCalls = vi.fn(async () => null);
    const cleanupHandler = defineStep({ schemaVersion: 1, id: "cleanup-selected-item", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1>(), output: z.null(), execute: itemCleanupCalls });
    graphFailureBoundaryV1({ placement: mapped, scope: "map-item",
      retries: [defineGraphRetryPolicyV1({ schemaVersion: 1, kind: "retry", policyId: "retry-selected-item",
        policyVersion: "1", scope: "map-item", maxAttempts: 2,
        retryOn: ["external-provider"], exhaustion: "propagate-failure" })],
      catches: [{ policy: defineGraphCatchPolicyV1({ schemaVersion: 1, kind: "catch", policyId: "catch-selected-item",
        policyVersion: "1", handlerDefinitionId: "catch-selected-item", failures: [{ class: "external-provider" }],
        output: number, afterRetry: "exhausted-or-not-retryable", cancellation: "propagate" }), handler: catchHandler }],
      cleanup: [{ policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "cleanup-selected-item",
        policyVersion: "1", handlerDefinitionId: "cleanup-selected-item", triggers: ["success"],
        execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" }), handler: cleanupHandler }],
    });
    const instanceCleanupCalls = vi.fn(async () => null);
    const instanceCleanup = defineStep({ schemaVersion: 1, id: "cleanup-selected-map", definitionVersion: "1",
      input: z.custom<GraphCleanupHandlerInputV1>(), output: z.null(), execute: instanceCleanupCalls });
    graphFailureBoundaryV1({ placement: mapped, scope: "map-instance", cleanup: [{
      policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "cleanup-selected-map",
        policyVersion: "1", handlerDefinitionId: "cleanup-selected-map", triggers: ["success"],
        execution: "once-per-scope-outcome", failureMode: "fail-run-preserve-original" }), handler: instanceCleanup,
    }] });
    const graph = defineWorkflow({ workflow: { kind: "selected-policy", version: 1 }, workflowContractVersion: "1",
      resultKind: "selected-policy.result", input: mapInput, nodes: [mapped], entry: mapped, result: mapped });
    const plan = describeGraphEntryV1(graph, { kind: "selected", address: address(
      { nodeId: "mapped", occurrence: { kind: "map", index: 0 } }, { nodeId: "body" }) });
    const boundary = acceptedBoundary(plan, role => {
      if (role === "entry-input") return { item: 1, index: 0, context: null };
      if (role === "control-input") return { items: [1, 2], context: null };
      return [];
    });
    const runtime = await scheduler(root);

    await expect(runtime.executeEntry({ graph, host: host("selected-policy-run"), plan, boundary }))
      .resolves.toEqual([99, 2]);
    await expect(runtime.executeEntry({ graph, host: host("selected-policy-run", "attempt-2", 2), plan, boundary }))
      .resolves.toEqual([99, 2]);
    expect(callback.mock.calls.map(call => call[0].index)).toEqual([0, 0, 1]);
    expect(catchCalls).toHaveBeenCalledOnce();
    expect(itemCleanupCalls).toHaveBeenCalledTimes(2);
    expect(instanceCleanupCalls).toHaveBeenCalledOnce();
  });

  it("executes branches and joins by dependency and replays completed instances without callbacks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-branches-"));
    let active = 0, maximumActive = 0;
    const calls: string[] = [];
    const operation = (name: string, fn: (value: number) => number) => leaf(name, z.number(), z.number(), async value => {
      active++; maximumActive = Math.max(maximumActive, active); calls.push(name);
      await Promise.resolve();
      active--;
      return fn(value);
    });
    const entry = graphStep({ id: "entry", input: graphRef.workflowInput<number>(), step: operation("entry-step", value => value + 1),
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const left = graphStep({ id: "left", input: graphRef.output(entry), step: operation("left-step", value => value * 2),
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const right = graphStep({ id: "right", input: graphRef.output(entry), step: operation("right-step", value => value * 3),
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const joinInput = z.object({ left: z.number(), right: z.number() });
    const join = graphStep({ id: "join", input: graphValue.object({ left: graphRef.output(left), right: graphRef.output(right) }),
      step: leaf("join-step", joinInput, z.number(), value => value.left + value.right),
      inputSchema: z.toJSONSchema(joinInput), outputSchema: { type: "number" } });
    const graph = defineWorkflow({ workflow: { kind: "branch-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "branch.result", input: number, nodes: [join, right, entry, left], entry, result: join });
    const runtime = await scheduler(root);

    expect(await runtime.execute({ graph, host: host("branch-run"), input: 2 })).toBe(15);
    expect(calls).toEqual(["entry-step", "left-step", "right-step"]);
    expect(maximumActive).toBe(1);
    expect(await runtime.execute({ graph, host: host("branch-run", "attempt-2", 2), input: 2 })).toBe(15);
    expect(calls).toEqual(["entry-step", "left-step", "right-step"]);

    const checkpoints = await Promise.all((await readdir(path.join(root, "steps"))).map(async file =>
      JSON.parse(await readFile(path.join(root, "steps", file), "utf8")) as { state: string; ref: { stepId: string } }));
    expect(checkpoints).toHaveLength(4);
    expect(checkpoints.every(value => value.state === "COMPLETED" && value.ref.stepId.startsWith("graph-"))).toBe(true);
  });

  it("executes map, reduce, loop, choice and subgraph controls serially and retains their decisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-controls-"));
    const bodyCalls = vi.fn();
    const select = vi.fn((value: number) => value >= 15 ? "high" : "low");
    const condition = vi.fn((value: { state: number; iteration: number; context: null }) => value.state < 15);

    const mapInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), context: z.null() });
    const mapBody = singleStepGraph("map-body", mapInput, z.number(), value => { bodyCalls("map", value.index); return value.item * 2; });
    const mapContract = objectSchema(z.object({ items: z.array(z.number()), context: z.null() }));
    const mapped = graphMap({ id: "mapped", input: graphRef.workflowInput(), inputContract: mapContract, outputContract: numbers, body: mapBody });

    const reduceInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), accumulator: z.number(), context: z.null() });
    const reduceBody = singleStepGraph("reduce-body", reduceInput, z.number(), value => {
      bodyCalls("reduce", value.index); return value.accumulator + value.item;
    });
    const reduceContract = objectSchema(z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() }));
    const reduced = graphReduce({ id: "reduced", input: graphValue.object({ items: graphRef.output(mapped), initial: graphValue.literal(0), context: graphValue.literal(null) }),
      inputContract: reduceContract, outputContract: number, body: reduceBody });

    const loopBodyInput = z.object({ state: z.number(), iteration: z.number().int().nonnegative(), context: z.null() });
    const loopBody = singleStepGraph("loop-body", loopBodyInput, z.number(), value => {
      bodyCalls("loop", value.iteration); return value.state + 1;
    });
    const loopContract = objectSchema(z.object({ state: z.number(), context: z.null() }));
    const looped = graphLoop({ id: "looped", input: graphValue.object({ state: graphRef.output(reduced), context: graphValue.literal(null) }),
      inputContract: loopContract, outputContract: number, body: loopBody, conditionVersion: "1", while: condition });

    const high = singleStepGraph("high-case", z.number(), z.number(), value => { bodyCalls("choice", 0); return value * 2; });
    const low = singleStepGraph("low-case", z.number(), z.number(), value => value);
    const chosen = graphChoice({ id: "chosen", input: graphRef.output(looped), inputContract: number, outputContract: number,
      selectionVersion: "1", select, cases: { high, low } });
    const tailBody = singleStepGraph("tail-body", z.number(), z.number(), value => { bodyCalls("subgraph", 0); return value + 1; });
    const tail = graphSubgraph({ id: "tail", input: graphRef.output(chosen), body: tailBody });

    const graph = defineWorkflow({ workflow: { kind: "controls-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "controls.result", input: mapContract, nodes: [tail, chosen, mapped, looped, reduced], entry: mapped, result: tail });
    const runtime = await scheduler(root);
    const input = { items: [1, 2, 3], context: null } as const;

    expect(await runtime.execute({ graph, host: host("controls-run"), input })).toBe(31);
    expect(bodyCalls.mock.calls).toEqual([
      ["map", 0], ["map", 1], ["map", 2],
      ["reduce", 0], ["reduce", 1], ["reduce", 2],
      ["loop", 0], ["loop", 1], ["loop", 2],
      ["choice", 0], ["subgraph", 0],
    ]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(condition).toHaveBeenCalledTimes(4);

    expect(await runtime.execute({ graph, host: host("controls-run", "attempt-2", 2), input })).toBe(31);
    expect(bodyCalls).toHaveBeenCalledTimes(11);
    expect(select).toHaveBeenCalledTimes(1);
    expect(condition).toHaveBeenCalledTimes(4);
  });

  it("returns ordered empty-map and empty-reduce results without executing their bodies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-empty-"));
    const callback = vi.fn((value: { item: number; index: number; context: null }) => value.item);
    const item = z.object({ item: z.number(), index: z.number().int().nonnegative(), context: z.null() });
    const body = singleStepGraph("empty-body", item, z.number(), callback);
    const mapInput = objectSchema(z.object({ items: z.array(z.number()), context: z.null() }));
    const map = graphMap({ id: "map", input: graphRef.workflowInput(), inputContract: mapInput, outputContract: numbers, body });
    const graph = defineWorkflow({ workflow: { kind: "empty-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "empty.result", input: mapInput, nodes: [map], entry: map, result: map });
    const runtime = await scheduler(root);
    expect(await runtime.execute({ graph, host: host("empty-run"), input: { items: [], context: null } })).toEqual([]);
    expect(callback).not.toHaveBeenCalled();

    const reduceInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), accumulator: z.number(), context: z.null() });
    const reduceBody = singleStepGraph("empty-reduce-body", reduceInput, z.number(), value => value.accumulator + value.item);
    const reduceContract = objectSchema(z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() }));
    const reduce = graphReduce({ id: "reduce", input: graphRef.workflowInput(), inputContract: reduceContract, outputContract: number, body: reduceBody });
    const reduceGraph = defineWorkflow({ workflow: { kind: "empty-reduce-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "empty-reduce.result", input: reduceContract, nodes: [reduce], entry: reduce, result: reduce });
    expect(await (await scheduler(await mkdtemp(path.join(tmpdir(), "durable-graph-empty-reduce-"))))
      .execute({ graph: reduceGraph, host: host("empty-reduce-run"), input: { items: [], initial: 7, context: null } })).toBe(7);
  });

  it("uses each control node's declared input normalization before scheduling its body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-normalized-control-"));
    const normalized = defineGraphValue<{ items: number[]; context: null }>({
      version: "1",
      schema: { type: "object" },
      validator: {
        parse(value) {
          const candidate = value as { items: unknown[] };
          return { items: candidate.items.map(item => Number(item)), context: null };
        },
      },
    });
    const item = z.object({ item: z.number(), index: z.number().int().nonnegative(), context: z.null() });
    const body = singleStepGraph("normalized-map-body", item, z.number(), value => value.item * 2);
    const map = graphMap({ id: "map", input: graphRef.workflowInput(), inputContract: normalized, outputContract: numbers, body });
    const graph = defineWorkflow({ workflow: { kind: "normalized-control", version: 1 }, workflowContractVersion: "1",
      resultKind: "normalized-control.result", input: normalized, nodes: [map], entry: map, result: map });
    expect(await (await scheduler(root)).execute({
      graph,
      host: host("normalized-control-run"),
      input: { items: ["2"], context: null } as never,
    })).toEqual([4]);
  });

  it("starts at a selected root node, uses caller-supplied skipped values and creates no upstream checkpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-selected-root-"));
    const firstCall = vi.fn((value: number) => value + 1);
    const selectedCall = vi.fn((value: number) => value * 2);
    const first = graphStep({ id: "first", input: graphRef.workflowInput<number>(), step: leaf("first", z.number(), z.number(), firstCall),
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const selected = graphStep({ id: "selected", input: graphRef.output(first), step: leaf("selected", z.number(), z.number(), selectedCall),
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const joinedInput = z.object({ selected: z.number(), skippedInput: z.number(), skippedOutput: z.number(), root: z.number() });
    const result = graphStep({ id: "result", input: graphValue.object({
      selected: graphRef.output(selected), skippedInput: graphRef.input(first), skippedOutput: graphRef.output(first),
      root: graphRef.workflowInput<number>(),
    }), step: leaf("joined-result", joinedInput, z.number(), value => value.selected + value.skippedInput + value.skippedOutput + value.root),
    inputSchema: z.toJSONSchema(joinedInput), outputSchema: { type: "number" } });
    const graph = defineWorkflow({ workflow: { kind: "selected-root", version: 1 }, workflowContractVersion: "1",
      resultKind: "selected-root.result", input: number, nodes: [first, selected, result], entry: first, result });
    const plan = describeGraphEntryV1(graph, { kind: "selected", address: address({ nodeId: "selected" }) });
    const boundary = validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256, values: {
      entry: 5, "node/first/input": 2, "node/first/output": 3, "scope/root": 2,
    } });

    expect(await (await scheduler(root)).executeEntry({ graph, host: host("selected-root-run"), plan, boundary })).toBe(17);
    expect(firstCall).not.toHaveBeenCalled();
    expect(selectedCall).toHaveBeenCalledOnce();
    expect(await readdir(path.join(root, "steps"))).toHaveLength(2);
  });

  it("continues a selected map occurrence, preserving its caller-supplied prefix and item order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-graph-selected-map-"));
    const firstCall = vi.fn((value: { item: number; index: number; context: string }) => value.item * 2);
    const laterCall = vi.fn((value: number) => value + 1);
    const bodyInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), context: z.string() });
    const bodyFirst = graphStep({ id: "body-first", input: graphRef.workflowInput(),
      step: leaf("map-first", bodyInput, z.number(), firstCall), inputSchema: z.toJSONSchema(bodyInput), outputSchema: { type: "number" } });
    const bodyLater = graphStep({ id: "body-later", input: graphRef.output(bodyFirst),
      step: leaf("map-later", z.number(), z.number(), laterCall), inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const body = defineGraph({ id: "selected-map-body", definitionVersion: "1", input: bodyFirst.inputContract,
      nodes: [bodyFirst, bodyLater], entry: bodyFirst, result: bodyLater });
    const controlInput = z.object({ items: z.array(z.number()), context: z.string() });
    const mapped = graphMap({ id: "mapped", input: graphRef.workflowInput(), inputContract: contract(controlInput),
      outputContract: numbers, body });
    const result = graphStep({ id: "result", input: graphRef.output(mapped), step: leaf("map-sum", z.array(z.number()), z.number(),
      values => values.reduce((sum, value) => sum + value, 0)), inputSchema: { type: "array" }, outputSchema: { type: "number" } });
    const graph = defineWorkflow({ workflow: { kind: "selected-map", version: 1 }, workflowContractVersion: "1",
      resultKind: "selected-map.result", input: mapped.inputContract, nodes: [mapped, result], entry: mapped, result });
    const plan = describeGraphEntryV1(graph, { kind: "selected", address: address(
      { nodeId: "mapped", occurrence: { kind: "map", index: 1 } }, { nodeId: "body-later" },
    ) });
    const boundary = acceptedBoundary(plan, role => {
      if (role === "entry-input") return 22;
      if (role === "control-input") return { items: [10, 11, 12], context: "ctx" };
      if (role === "map-completed-outputs") return [20];
      throw new Error(`Unexpected requirement ${role}.`);
    });

    const runtime = await scheduler(root);
    expect(await runtime.executeEntry({ graph, host: host("selected-map-run"), plan, boundary })).toBe(68);
    expect(firstCall.mock.calls.map(call => call[0].index)).toEqual([2]);
    expect(laterCall.mock.calls.map(call => call[0])).toEqual([22, 24]);
    expect(await runtime.executeEntry({ graph, host: host("selected-map-run", "attempt-2", 2), plan, boundary })).toBe(68);
    expect(firstCall.mock.calls.map(call => call[0].index)).toEqual([2]);
    expect(laterCall.mock.calls.map(call => call[0])).toEqual([22, 24]);
  });

  it("continues selected reduce and loop occurrences from caller-supplied control state", async () => {
    const reduceRoot = await mkdtemp(path.join(tmpdir(), "durable-graph-selected-reduce-"));
    const reduceFirst = vi.fn((value: { item: number; index: number; accumulator: number; context: null }) => value.accumulator + value.item);
    const reduceLater = vi.fn((value: number) => value);
    const reduceBodyInput = z.object({ item: z.number(), index: z.number().int().nonnegative(), accumulator: z.number(), context: z.null() });
    const reduceBodyFirst = graphStep({ id: "body-first", input: graphRef.workflowInput(),
      step: leaf("reduce-first", reduceBodyInput, z.number(), reduceFirst), inputSchema: z.toJSONSchema(reduceBodyInput), outputSchema: { type: "number" } });
    const reduceBodyLater = graphStep({ id: "body-later", input: graphRef.output(reduceBodyFirst),
      step: leaf("reduce-later", z.number(), z.number(), reduceLater), inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const reduceBody = defineGraph({ id: "selected-reduce-body", definitionVersion: "1", input: reduceBodyFirst.inputContract,
      nodes: [reduceBodyFirst, reduceBodyLater], entry: reduceBodyFirst, result: reduceBodyLater });
    const reduceControl = z.object({ items: z.array(z.number()), initial: z.number(), context: z.null() });
    const reduced = graphReduce({ id: "reduced", input: graphRef.workflowInput(), inputContract: contract(reduceControl),
      outputContract: number, body: reduceBody });
    const reduceGraph = defineWorkflow({ workflow: { kind: "selected-reduce", version: 1 }, workflowContractVersion: "1",
      resultKind: "selected-reduce.result", input: reduced.inputContract, nodes: [reduced], entry: reduced, result: reduced });
    const reducePlan = describeGraphEntryV1(reduceGraph, { kind: "selected", address: address(
      { nodeId: "reduced", occurrence: { kind: "reduce", index: 1 } }, { nodeId: "body-later" },
    ) });
    const reduceBoundary = acceptedBoundary(reducePlan, role => {
      if (role === "entry-input") return 3;
      if (role === "control-input") return { items: [1, 2, 3], initial: 0, context: null };
      if (role === "reduce-accumulator") return 1;
      throw new Error(`Unexpected requirement ${role}.`);
    });
    expect(await (await scheduler(reduceRoot)).executeEntry({ graph: reduceGraph, host: host("selected-reduce-run"),
      plan: reducePlan, boundary: reduceBoundary })).toBe(6);
    expect(reduceFirst.mock.calls.map(call => call[0].index)).toEqual([2]);
    expect(reduceLater.mock.calls.map(call => call[0])).toEqual([3, 6]);

    const loopRoot = await mkdtemp(path.join(tmpdir(), "durable-graph-selected-loop-"));
    const loopFirst = vi.fn((value: { state: number; iteration: number; context: null }) => value.state + 1);
    const loopLater = vi.fn((value: number) => value + 1);
    const whileCondition = vi.fn((value: { state: number; iteration: number; context: null }) => value.state < 10);
    const loopBodyInput = z.object({ state: z.number(), iteration: z.number().int().nonnegative(), context: z.null() });
    const loopBodyFirst = graphStep({ id: "body-first", input: graphRef.workflowInput(),
      step: leaf("loop-first", loopBodyInput, z.number(), loopFirst), inputSchema: z.toJSONSchema(loopBodyInput), outputSchema: { type: "number" } });
    const loopBodyLater = graphStep({ id: "body-later", input: graphRef.output(loopBodyFirst),
      step: leaf("loop-later", z.number(), z.number(), loopLater), inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    const loopBody = defineGraph({ id: "selected-loop-body", definitionVersion: "1", input: loopBodyFirst.inputContract,
      nodes: [loopBodyFirst, loopBodyLater], entry: loopBodyFirst, result: loopBodyLater });
    const loopControl = z.object({ state: z.number(), context: z.null() });
    const looped = graphLoop({ id: "looped", input: graphRef.workflowInput(), inputContract: contract(loopControl),
      outputContract: number, body: loopBody, conditionVersion: "1", while: whileCondition });
    const loopGraph = defineWorkflow({ workflow: { kind: "selected-loop", version: 1 }, workflowContractVersion: "1",
      resultKind: "selected-loop.result", input: looped.inputContract, nodes: [looped], entry: looped, result: looped });
    const loopPlan = describeGraphEntryV1(loopGraph, { kind: "selected", address: address(
      { nodeId: "looped", occurrence: { kind: "loop", iteration: 3 } }, { nodeId: "body-later" },
    ) });
    const loopBoundary = acceptedBoundary(loopPlan, role => {
      if (role === "entry-input") return 8;
      if (role === "control-input") return { state: 7, context: null };
      if (role === "loop-iteration") return 3;
      throw new Error(`Unexpected requirement ${role}.`);
    });
    expect(await (await scheduler(loopRoot)).executeEntry({ graph: loopGraph, host: host("selected-loop-run"),
      plan: loopPlan, boundary: loopBoundary })).toBe(11);
    expect(loopFirst.mock.calls.map(call => call[0].iteration)).toEqual([4]);
    expect(loopLater.mock.calls.map(call => call[0])).toEqual([8, 10]);
    expect(whileCondition.mock.calls.map(call => call[0].iteration)).toEqual([4, 5]);
  });

  it("continues selected subgraph and choice bodies without invoking their skipped entry or selector", async () => {
    for (const kind of ["subgraph", "choice"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `durable-graph-selected-${kind}-`));
      const firstCall = vi.fn((value: number) => value + 1);
      const laterCall = vi.fn((value: number) => value * 2);
      const first = graphStep({ id: "body-first", input: graphRef.workflowInput<number>(),
        step: leaf(`${kind}-first`, z.number(), z.number(), firstCall), inputSchema: { type: "number" }, outputSchema: { type: "number" } });
      const later = graphStep({ id: "body-later", input: graphRef.output(first),
        step: leaf(`${kind}-later`, z.number(), z.number(), laterCall), inputSchema: { type: "number" }, outputSchema: { type: "number" } });
      const body = defineGraph({ id: `${kind}-body`, definitionVersion: "1", input: number, nodes: [first, later], entry: first, result: later });
      const select = vi.fn(() => "chosen");
      const control = kind === "subgraph"
        ? graphSubgraph({ id: "control", input: graphRef.workflowInput<number>(), body })
        : graphChoice({ id: "control", input: graphRef.workflowInput<number>(), inputContract: number, outputContract: number,
            selectionVersion: "1", select, cases: { chosen: body } });
      const graph = defineWorkflow({ workflow: { kind: `selected-${kind}`, version: 1 }, workflowContractVersion: "1",
        resultKind: `selected-${kind}.result`, input: number, nodes: [control], entry: control, result: control });
      const occurrence = kind === "subgraph"
        ? { kind: "subgraph" as const }
        : { kind: "choice" as const, case: "chosen" };
      const plan = describeGraphEntryV1(graph, { kind: "selected", address: address(
        { nodeId: "control", occurrence }, { nodeId: "body-later" },
      ) });
      const boundary = acceptedBoundary(plan, role => {
        if (role === "entry-input") return 6;
        if (role === "control-input") return 5;
        throw new Error(`Unexpected requirement ${role}.`);
      });
      expect(await (await scheduler(root)).executeEntry({ graph, host: host(`selected-${kind}-run`), plan, boundary })).toBe(12);
      expect(firstCall).not.toHaveBeenCalled();
      expect(laterCall).toHaveBeenCalledWith(6);
      expect(select).not.toHaveBeenCalled();
    }
  });

  it("rejects a host capability request for parallel scheduling", async () => {
    const node = graphStep({ id: "node", input: graphRef.workflowInput<number>(), step: leaf("node", z.number(), z.number(), value => value),
      inputSchema: { type: "number" }, outputSchema: { type: "number" } });
    expect(() => defineWorkflow({ workflow: { kind: "parallel-fixture", version: 1 }, workflowContractVersion: "1",
      resultKind: "parallel.result", input: number, nodes: [node], entry: node, result: node, scheduling: "parallel" } as never))
      .toThrow(/serial only/);
  });
});
