import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  DurableGraphSchedulerV1,
  describeGraphEntryV1,
  defineGraph,
  defineGraphValue,
  defineStep,
  defineWorkflow,
  graphRef,
  graphStep,
  graphSubgraph,
  type GraphInstanceSegmentV1,
  type JsonValue,
  validateGraphEntryBoundaryV1,
} from "../../core/src/index.ts";
import type {
  AgentOperationRefV1,
  AgentOperationV1,
  ClaimedStepTransitionV1,
  DurableExecutionStorageV2,
  EffectOperationRefV1,
  EffectOperationV1,
  ExecutionHostContextV1,
  RetryTerminalRequestV1,
  StepCheckpointV1,
} from "../../core/src/application/durableExecution.ts";
import type { CompletedStepV1, DurableAgentOperationExecutorV1, StepRefV1 } from "../../core/src/application/durableWorkflow.ts";
import { DurableWorkflowEngineV2 } from "../../core/src/application/durableWorkflowEngine.ts";
import { graphExecutionCheckpointIdV1 } from "../../core/src/application/durableGraphScheduler.ts";
import { ExternalProviderError } from "../../core/src/application/externalError.ts";
import { graphFailureBoundaryV1 } from "../../core/src/application/graphFailureBoundary.ts";
import { defineGraphRetryPolicyV1 } from "../../core/src/application/graphFailurePolicy.ts";
import {
  FileAgentOperationStoreV1,
  FileDurableExecutionEventSinkV1,
  FileEffectOperationStoreV1,
  FileStepCheckpointStoreV2,
} from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";

const roots: string[] = [];
const number = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });
type FaultTarget = "agent" | "effect" | "step" | "scope-marker";
type FaultTiming = "before" | "after";

class SimulatedRetryAdmissionStop extends Error {
  constructor(target: FaultTarget, timing: FaultTiming) {
    super(`Simulated process stop ${timing} ${target} retry admission.`);
  }
}

class FaultingStepStore extends FileStepCheckpointStoreV2 {
  #stopped = false;

  constructor(root: string, readonly timing: FaultTiming) { super({ root }); }

  override async reopenForRetry<Input extends JsonValue, Output extends JsonValue>(
    request: RetryTerminalRequestV1<StepRefV1>,
  ): Promise<StepCheckpointV1<Input, Output>> {
    if (!this.#stopped && this.timing === "before") {
      this.#stopped = true;
      throw new SimulatedRetryAdmissionStop("step", this.timing);
    }
    const reopened = await super.reopenForRetry<Input, Output>(request);
    if (!this.#stopped && this.timing === "after") {
      this.#stopped = true;
      throw new SimulatedRetryAdmissionStop("step", this.timing);
    }
    return reopened;
  }
}

class FaultingScopeMarkerStore extends FileStepCheckpointStoreV2 {
  #stopped = false;
  #stopPending = false;

  constructor(root: string, readonly timing: FaultTiming, readonly markerId: string) { super({ root }); }

  override async complete<Input extends JsonValue, Output extends JsonValue>(
    request: ClaimedStepTransitionV1 & { readonly completed: CompletedStepV1<Input, Output> },
  ): Promise<CompletedStepV1<Input, Output>> {
    if (!this.#stopped && request.ref.stepId === this.markerId && this.timing === "before") {
      this.#stopped = true;
      this.#stopPending = true;
      throw new SimulatedRetryAdmissionStop("scope-marker", this.timing);
    }
    const completed = await super.complete(request);
    if (!this.#stopped && request.ref.stepId === this.markerId && this.timing === "after") {
      this.#stopped = true;
      this.#stopPending = true;
      throw new SimulatedRetryAdmissionStop("scope-marker", this.timing);
    }
    return completed;
  }

  override fail(request: ClaimedStepTransitionV1 & { readonly code: string; readonly message: string }): Promise<void> {
    if (this.#stopPending) {
      this.#stopPending = false;
      return Promise.reject(new SimulatedRetryAdmissionStop("scope-marker", this.timing));
    }
    return super.fail(request);
  }
}

class FaultingEffectStore extends FileEffectOperationStoreV1 {
  #stopped = false;

  constructor(root: string, readonly timing: FaultTiming) { super({ root }); }

  override async reopenForRetry<Output extends JsonValue>(
    request: RetryTerminalRequestV1<EffectOperationRefV1>,
  ): Promise<EffectOperationV1<Output>> {
    if (!this.#stopped && this.timing === "before") {
      this.#stopped = true;
      throw new SimulatedRetryAdmissionStop("effect", this.timing);
    }
    const reopened = await super.reopenForRetry<Output>(request);
    if (!this.#stopped && this.timing === "after") {
      this.#stopped = true;
      throw new SimulatedRetryAdmissionStop("effect", this.timing);
    }
    return reopened;
  }
}

class FaultingAgentStore extends FileAgentOperationStoreV1 {
  #stopped = false;

  constructor(root: string, readonly timing: FaultTiming) { super({ root }); }

  override async reopenForRetry<Output extends JsonValue>(
    request: RetryTerminalRequestV1<AgentOperationRefV1>,
  ): Promise<AgentOperationV1<Output>> {
    if (!this.#stopped && this.timing === "before") {
      this.#stopped = true;
      throw new SimulatedRetryAdmissionStop("agent", this.timing);
    }
    const reopened = await super.reopenForRetry<Output>(request);
    if (!this.#stopped && this.timing === "after") {
      this.#stopped = true;
      throw new SimulatedRetryAdmissionStop("agent", this.timing);
    }
    return reopened;
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

function scheduler(root: string, storageOverrides: Partial<DurableExecutionStorageV2> = {},
  agentExecutor?: DurableAgentOperationExecutorV1): DurableGraphSchedulerV1 {
  const storage: DurableExecutionStorageV2 = {
    steps: storageOverrides.steps ?? new FileStepCheckpointStoreV2({ root }),
    agents: storageOverrides.agents ?? new FileAgentOperationStoreV1({ root }),
    effects: storageOverrides.effects ?? new FileEffectOperationStoreV1({ root }),
    events: storageOverrides.events ?? new FileDurableExecutionEventSinkV1({ root }),
  };
  return new DurableGraphSchedulerV1({ engine: new DurableWorkflowEngineV2({
    storage,
    agents: agentExecutor ?? {
      resolve: () => { throw new Error("No agent operations expected."); },
      invoke: async () => { throw new Error("No agent operations expected."); },
    },
  }) });
}

function fixture(operationKind: "agent" | "effect") {
  let stableCalls = 0;
  let flakyCalls = 0;
  const step = defineStep({
    schemaVersion: 1,
    id: "calculate",
    definitionVersion: "1",
    input: z.number(),
    output: z.number(),
    execute: async (context, input) => {
      const stable = await context.effects.run({
        schemaVersion: 1,
        operationId: "stable-read",
        definitionVersion: "1",
        safety: "read",
        input: z.number(),
        output: z.number(),
        execute: async (_operation, value) => { stableCalls++; return value + 1; },
      }, input);
      if (operationKind === "agent") {
        return context.agents.invoke({
          schemaVersion: 1,
          operationId: "flaky-agent",
          slotId: "advisor",
          output: z.number(),
        }, stable);
      }
      return context.effects.run({
        schemaVersion: 1,
        operationId: "flaky-read",
        definitionVersion: "1",
        safety: "read",
        input: z.number(),
        output: z.number(),
        execute: async (_operation, value) => {
          flakyCalls++;
          if (flakyCalls === 1) throw new ExternalProviderError("fixture-provider", "Provider is busy.", {
            code: "provider_busy",
            retryability: "retryable",
          });
          return value * 2;
        },
      }, stable);
    },
  });
  const node = graphStep({
    id: "calculate",
    input: graphRef.workflowInput<number>(),
    step,
    inputSchema: { type: "number" },
    outputSchema: { type: "number" },
  });
  graphFailureBoundaryV1({
    placement: node,
    scope: "node-instance",
    retries: [defineGraphRetryPolicyV1({
      schemaVersion: 1,
      kind: "retry",
      policyId: "retry-provider",
      policyVersion: "1",
      scope: "node-instance",
      maxAttempts: 2,
      retryOn: ["external-provider"],
      exhaustion: "propagate-failure",
    })],
  });
  const graph = defineWorkflow({
    workflow: { kind: "retry-recovery-fixture", version: 1 },
    workflowContractVersion: "1",
    resultKind: "retry-recovery.result",
    input: number,
    nodes: [node],
    entry: node,
    result: node,
  });
  const agentExecutor: DurableAgentOperationExecutorV1 = {
    resolve: () => ({
      providerId: "fixture-provider",
      authProviderId: "fixture-session",
      configurationSha256: "a".repeat(64),
    }),
    async invoke(request) {
      flakyCalls++;
      if (flakyCalls === 1) throw new ExternalProviderError("fixture-provider", "Provider is busy.", {
        code: "provider_busy",
        retryability: "retryable",
      });
      return { output: request.operation.output.parse(z.number().parse(request.input) * 2) };
    },
  };
  return { graph, agentExecutor, calls: () => ({ stableCalls, flakyCalls }) };
}

function controlFixture() {
  let calls = 0;
  const step = defineStep({
    schemaVersion: 1,
    id: "calculate",
    definitionVersion: "1",
    input: z.number(),
    output: z.number(),
    execute: async (_context, input) => {
      calls++;
      if (calls === 1) throw new ExternalProviderError("fixture-provider", "Provider is busy.", {
        code: "provider_busy", retryability: "retryable",
      });
      return input + 1;
    },
  });
  const bodyNode = graphStep({ id: "body", input: graphRef.workflowInput<number>(), step,
    inputSchema: { type: "number" }, outputSchema: { type: "number" } });
  const body = defineGraph({ id: "retry-control-body", definitionVersion: "1", input: number,
    nodes: [bodyNode], entry: bodyNode, result: bodyNode });
  const control = graphSubgraph({ id: "control", input: graphRef.workflowInput<number>(), body });
  graphFailureBoundaryV1({ placement: control, scope: "subgraph-instance", retries: [defineGraphRetryPolicyV1({
    schemaVersion: 1, kind: "retry", policyId: "retry-control", policyVersion: "1",
    scope: "subgraph-instance", maxAttempts: 2, retryOn: ["external-provider"], exhaustion: "propagate-failure",
  })] });
  const graph = defineWorkflow({ workflow: { kind: "retry-control-recovery", version: 1 }, workflowContractVersion: "1",
    resultKind: "retry-control-recovery.result", input: number,
    nodes: [control], entry: control, result: control });
  return { graph, calls: () => calls };
}

const address = (...segments: GraphInstanceSegmentV1[]) => ({ schemaVersion: 1 as const, path: segments });

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("durable graph retry admission recovery", () => {
  for (const target of ["agent", "effect", "step"] as const) {
    for (const timing of ["before", "after"] as const) {
      it(`resumes the same retry after a stop ${timing} ${target} admission`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), `durable-graph-retry-${target}-${timing}-`));
        roots.push(root);
        const operationKind = target === "agent" ? "agent" : "effect";
        const { graph, agentExecutor, calls } = fixture(operationKind);
        const executionId = `retry-${target}-${timing}`;
        let firstStorage: Partial<DurableExecutionStorageV2>;
        if (target === "agent") firstStorage = { agents: new FaultingAgentStore(root, timing) };
        else if (target === "effect") firstStorage = { effects: new FaultingEffectStore(root, timing) };
        else firstStorage = { steps: new FaultingStepStore(root, timing) };

        await expect(scheduler(root, firstStorage, agentExecutor).execute({
          graph,
          host: host(executionId, "attempt-1", 1),
          input: 10,
        })).rejects.toThrow(SimulatedRetryAdmissionStop);

        await expect(scheduler(root, {}, agentExecutor).execute({
          graph,
          host: host(executionId, "attempt-2", 2),
          input: 10,
        })).resolves.toBe(22);
        expect(calls()).toEqual({ stableCalls: 1, flakyCalls: 2 });

        const stepId = graphExecutionCheckpointIdV1(graph, address({ nodeId: "calculate" }), "step");
        const runRef = { executionId };
        const checkpoint = await new FileStepCheckpointStoreV2({ root }).read({ runRef, stepId });
        const stable = await new FileEffectOperationStoreV1({ root }).read({
          runRef,
          operationId: `${stepId}:stable-read`,
        });
        const flaky = operationKind === "agent"
          ? await new FileAgentOperationStoreV1({ root }).read({ runRef, operationId: `${stepId}:flaky-agent` })
          : await new FileEffectOperationStoreV1({ root }).read({ runRef, operationId: `${stepId}:flaky-read` });

        expect(checkpoint).toMatchObject({
          state: "COMPLETED",
          attemptCount: 2,
          retryAdmissions: [{ policyId: "retry-provider", fromAttempt: 1 }],
        });
        expect(stable).toMatchObject({ state: "COMPLETED", attemptCount: 1 });
        expect(stable?.retryAdmissions).toBeUndefined();
        expect(flaky).toMatchObject({
          state: "COMPLETED",
          retryAdmissions: [{ policyId: "retry-provider", fromAttempt: 1 }],
        });
        expect(checkpoint?.retryAdmissions).toHaveLength(1);
        expect(flaky?.retryAdmissions).toHaveLength(1);
        expect(checkpoint?.retryAdmissions?.[0]?.retryId).toBe(flaky?.retryAdmissions?.[0]?.retryId);
      });
    }
  }

  for (const target of ["scope-marker", "step"] as const) {
    for (const timing of ["before", "after"] as const) {
      it(`resumes a control-scope retry after a stop ${timing} ${target} admission`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), `durable-graph-control-retry-${target}-${timing}-`));
        roots.push(root);
        const { graph, calls } = controlFixture();
        const executionId = `control-retry-${target}-${timing}`;
        const markerId = graphExecutionCheckpointIdV1(graph, address({ nodeId: "control" }),
          "control-retry-retry-control-scope-attempt-2");
        const steps = target === "scope-marker"
          ? new FaultingScopeMarkerStore(root, timing, markerId)
          : new FaultingStepStore(root, timing);

        await expect(scheduler(root, { steps }).execute({
          graph,
          host: host(executionId, "attempt-1", 1),
          input: 10,
        })).rejects.toThrow(SimulatedRetryAdmissionStop);

        await expect(scheduler(root).execute({
          graph,
          host: host(executionId, "attempt-2", 2),
          input: 10,
        })).resolves.toBe(11);
        expect(calls()).toBe(2);

        const store = new FileStepCheckpointStoreV2({ root });
        await expect(store.read({ runRef: { executionId }, stepId: markerId }))
          .resolves.toMatchObject({ state: "COMPLETED",
            attemptCount: target === "scope-marker" && timing === "before" ? 2 : 1 });
        const leafId = graphExecutionCheckpointIdV1(graph,
          address({ nodeId: "control", occurrence: { kind: "subgraph" } }, { nodeId: "body" }), "step");
        await expect(store.read({ runRef: { executionId }, stepId: leafId }))
          .resolves.toMatchObject({ state: "COMPLETED", attemptCount: 2,
            retryAdmissions: [{ policyId: "retry-control", fromAttempt: 1 }] });
      });
    }
  }

  for (const timing of ["before", "after"] as const) {
    it(`resumes selected-entry control retry after a stop ${timing} its scope admission`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `durable-graph-selected-control-retry-${timing}-`));
      roots.push(root);
      const { graph, calls } = controlFixture();
      const executionId = `selected-control-retry-${timing}`;
      const markerId = graphExecutionCheckpointIdV1(graph, address({ nodeId: "control" }),
        "control-retry-retry-control-scope-attempt-2");
      const plan = describeGraphEntryV1(graph, { kind: "selected", address: address(
        { nodeId: "control", occurrence: { kind: "subgraph" } }, { nodeId: "body" },
      ) });
      const boundary = validateGraphEntryBoundaryV1(plan, {
        schemaVersion: 1,
        planSha256: plan.planSha256,
        values: Object.fromEntries(plan.requirements.map(requirement => [requirement.id, 10])),
      });

      await expect(scheduler(root, { steps: new FaultingScopeMarkerStore(root, timing, markerId) }).executeEntry({
        graph,
        host: host(executionId, "attempt-1", 1),
        plan,
        boundary,
      })).rejects.toThrow(SimulatedRetryAdmissionStop);
      await expect(scheduler(root).executeEntry({
        graph,
        host: host(executionId, "attempt-2", 2),
        plan,
        boundary,
      })).resolves.toBe(11);
      expect(calls()).toBe(2);
    });
  }
});
