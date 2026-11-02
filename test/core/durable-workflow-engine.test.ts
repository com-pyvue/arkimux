import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentExecutionMetrics } from "../../core/src/application/agentProvider.ts";
import { ExternalProviderError, getExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";
import { DurableWorkflowEngineV2, type DurableEffectOperationExecutorV1 } from "../../core/src/application/durableWorkflowEngine.ts";
import { DurableWorkflowRunExecutorV2 } from "../../core/src/application/durableWorkflowRun.ts";
import {
  DurableOutcomeUnknownError,
  type ExecutionHostContextV1,
} from "../../core/src/application/durableExecution.ts";
import {
  defineStep,
  hashJson,
  stepDefinitionHash,
  type DurableAgentOperationExecutorV1,
  type EffectDefinitionV1,
  type JsonValue,
  type StepDefinitionBindingV1,
  type ValueValidatorV1,
} from "../../core/src/application/durableWorkflow.ts";
import type { DurableWorkflowDefinitionV1, WorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import {
  FileAgentOperationStoreV1,
  FileDurableExecutionEventSinkV1,
  FileEffectOperationStoreV1,
  FileStepCheckpointStoreV2,
} from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";
import { FileWorkflowInvocationStoreV1 } from "../../core/src/infrastructure/storage/fileWorkflowInvocationStore.ts";
import {
  LocalInterruptedWorkflowRecoveryCoordinatorV1,
  LocalWholeRunExecutionHostV1,
  composeLocalExecutionStorageV2,
  composeLocalExecutionStorageV3,
  createLocalDurableExecutionStorage,
  createLocalWorkflowInvocationStore,
  listInterruptedLocalRuns,
  resolveLocalDurableExecutionPaths,
  resumeInterruptedLocalRuns,
} from "../../local/src/localDurableWorkflowRuntime.ts";

const jsonObject = <T extends Record<string, JsonValue>>(): ValueValidatorV1<T> => ({
  parse(value: unknown): T {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object.");
    return structuredClone(value) as T;
  },
});
const inputValidator = jsonObject<{ city: string }>();
const weatherValidator = jsonObject<{ temperatureC: number }>();
const recommendationValidator = jsonObject<{ message: string }>();
const workflowValidator = jsonObject<{ result: string }>();
const runConfigurationReference = { configurationId: "weather-advisor-v1", contentHash: "a".repeat(64) } as const;

function workflowInvocation(executionId: string): WorkflowInvocationV1<{ city: string }> {
  return {
    schemaVersion: 1,
    runRef: { executionId },
    workflow: { kind: "weather-advisor", version: 1 },
    workflowContractVersion: "weather-advisor-v1",
    runConfiguration: runConfigurationReference,
    resultKind: "weather-advisor-result-v1",
    input: { city: "Istanbul" },
    createdAt: "2026-09-04T08:00:00.000Z",
  };
}

function host(executionId: string, attemptId = "attempt-1", fence = 1): ExecutionHostContextV1 {
  return {
    schemaVersion: 1,
    runRef: { executionId },
    attemptId,
    fence,
    deadlineAt: "2030-01-01T00:00:00.000Z",
    finalizationReserveMs: 1_000,
    scratchDirectory: `/tmp/${attemptId}`,
    limits: { maxDurationMs: 60_000, maxScratchBytes: 1_000_000 },
    cancellation: { aborted: false },
    heartbeat: async () => undefined,
  };
}

async function storage(root: string) {
  return {
    steps: new FileStepCheckpointStoreV2({ root }),
    agents: new FileAgentOperationStoreV1({ root }),
    effects: new FileEffectOperationStoreV1({ root }),
    events: new FileDurableExecutionEventSinkV1({ root }),
  };
}

function agents(invoke: () => Promise<{ readonly output: JsonValue; readonly metrics?: AgentExecutionMetrics }>): DurableAgentOperationExecutorV1 {
  return {
    resolve: () => ({
      providerId: "pi-cli",
      authProviderId: "pi-openai-codex-session",
      model: "gpt-5.4-mini",
      configurationSha256: "a".repeat(64),
    }),
    async invoke(request) {
      const result = await invoke();
      return {
        ...result,
        output: request.operation.output.parse(result.output),
      };
    },
  };
}

describe("durable workflow engine V2", () => {
  it.each(["agent", "read", "unsafe-write", "internal"] as const)("retains only classified %s failures through ordinary host, checkpoints and replay", async source => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-external-error-")), ref = { executionId: "external-error-run" };
    const saved = createLocalDurableExecutionStorage(root, ref), localHost = new LocalWholeRunExecutionHostV1({ repositoryRoot: root });
    const failure = source === "internal" ? new TypeError("private-path /internal/credential-value")
      : new ExternalProviderError("fixture-provider", "Service 503 [unavailable]. Retry in 12 seconds. https://service.test/help opaque-credential",
        { code: "SERVICE_UNAVAILABLE", secretValues: ["opaque-credential"], retryability: "retryable" });
    let calls = 0;
    const invoke = async (): Promise<{ output: JsonValue }> => { calls++; throw failure; };
    const engine = new DurableWorkflowEngineV2({ storage: saved, agents: agents(invoke) });
    const validator = jsonObject<{ city: string }>();
    const step = defineStep({ schemaVersion: 1, id: "request", definitionVersion: "1", input: validator, output: validator,
      execute: async (context, input) => source === "agent" ? context.agents.invoke({ schemaVersion: 1, operationId: "call", slotId: "advisor", output: validator }, input)
        : context.effects.run({ schemaVersion: 1, operationId: "call", definitionVersion: "1", safety: source === "unsafe-write" ? "unsafe-write" : "read",
          input: validator, output: validator, execute: async () => { calls++; throw failure; } }, input) });
    const run = async () => {
      const attempt = await localHost.nextAttempt(ref, { maxDurationMs: 60000, finalizationReserveMs: 1000, maxScratchBytes: 1000 });
      return localHost.executeAttempt(attempt, h => engine.execute({ workflowContractVersion: "1", host: h,
        execute: async context => (await context.steps.run(step, { city: "Istanbul" })).output }));
    };
    const first = await run(), replay = await run();
    expect(first.status).toBe(source === "unsafe-write" ? "outcome_unknown" : "failed");
    const terminal = (await saved.steps.read({ runRef: ref, stepId: "request" }))!.terminal!;
    const attempts = await localHost.listAttempts(ref);
    if (source === "internal") {
      expect(terminal.retryability).toBe("unknown");
      expect(getExternalErrorDiagnostic(first)).toBeUndefined(); expect(getExternalErrorDiagnostic(replay)).toBeUndefined();
      expect(JSON.stringify([first, replay, terminal, attempts])).not.toMatch(/private-path|credential-value|TypeError/);
    } else {
      const diagnostic = getExternalErrorDiagnostic(failure);
      expect(getExternalErrorDiagnostic(first)).toEqual(diagnostic); expect(getExternalErrorDiagnostic(replay)).toEqual(diagnostic);
      expect(terminal.externalDiagnostic).toEqual(diagnostic);
      const expectedRetryability = source === "unsafe-write" ? "not-retryable" : "retryable";
      expect(terminal.retryability).toBe(expectedRetryability);
      expect(attempts.every(a => a.terminal?.retryability === expectedRetryability)).toBe(true);
      expect(attempts.every(a => a.terminal?.externalDiagnostic?.message === diagnostic!.message)).toBe(true);
      expect(JSON.stringify([first, replay, terminal, attempts])).not.toContain("opaque-credential");
    }
    expect(calls).toBe(1);
  });

  it("commits each typed step before the dependent step and replays without callbacks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-engine-"));
    const durableStorage = await storage(root);
    const agentCalls = vi.fn(async () => ({
      output: { message: "Take an umbrella" },
      metrics: {
        providerId: "pi-cli",
        status: "complete" as const,
        elapsedMs: 10,
        nativeToolCalls: 0,
        toolCallUnit: "native-tool-call" as const,
        artifacts: { eventsPath: "internal/events", stderrPath: "internal/stderr", lastMessagePath: "internal/message", heartbeatPath: "internal/heartbeat" },
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    }));
    let weatherCalls = 0;
    let recommendationCalls = 0;
    const readWeather = defineStep({
      schemaVersion: 1,
      id: "read-weather",
      definitionVersion: "1",
      input: inputValidator,
      output: weatherValidator,
      async execute(context, input) {
        weatherCalls += 1;
        return context.effects.run({
          schemaVersion: 1,
          operationId: "weather.current",
          definitionVersion: "1",
          safety: "read",
          input: inputValidator,
          output: weatherValidator,
          async execute() { return { temperatureC: input.city === "Istanbul" ? 24 : 0 }; },
        }, input);
      },
    });
    const recommend = defineStep({
      schemaVersion: 1,
      id: "recommend",
      definitionVersion: "1",
      input: weatherValidator,
      output: recommendationValidator,
      async execute(context, input) {
        recommendationCalls += 1;
        return context.agents.invoke({ schemaVersion: 1, operationId: "recommendation", slotId: "advisor", output: recommendationValidator }, input);
      },
    });
    const runWorkflow = async (engine: DurableWorkflowEngineV2, executionHost: ExecutionHostContextV1) => engine.execute({
      workflowContractVersion: "weather-advisor-v1",
      host: executionHost,
      async execute(context) {
        const weather = await context.steps.run(readWeather, { city: "Istanbul" });
        const recommendation = await context.steps.run(recommend, weather.output);
        expect(recommendation.performance.inputTokens).toEqual({ availability: "reported", value: 4 });
        return workflowValidator.parse({ result: recommendation.output.message });
      },
    });
    const engine = new DurableWorkflowEngineV2({ storage: durableStorage, agents: agents(agentCalls), now: monotonicClock() });
    await expect(runWorkflow(engine, host("weather-1"))).resolves.toEqual({ result: "Take an umbrella" });
    expect([weatherCalls, recommendationCalls, agentCalls.mock.calls.length]).toEqual([1, 1, 1]);

    const restarted = new DurableWorkflowEngineV2({ storage: await storage(root), agents: agents(agentCalls), now: monotonicClock() });
    await expect(runWorkflow(restarted, host("weather-1", "attempt-2", 2))).resolves.toEqual({ result: "Take an umbrella" });
    expect([weatherCalls, recommendationCalls, agentCalls.mock.calls.length]).toEqual([1, 1, 1]);
    expect(await readdir(path.join(root, "steps"))).toEqual(["read-weather.json", "recommend.json"]);
    const persisted = await readFile(path.join(root, "steps", "recommend.json"), "utf8");
    expect(persisted).not.toContain("pi-openai-codex-session-secret");
    expect(persisted).not.toContain("internal/stderr");
  });

  it("recovers a pre-dispatch operation link but fails closed after agent dispatch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-link-"));
    const durableStorage = await storage(root);
    const step = defineStep({
      schemaVersion: 1,
      id: "recommend",
      definitionVersion: "1",
      input: inputValidator,
      output: recommendationValidator,
      async execute(context, input) {
        return context.agents.invoke({ schemaVersion: 1, operationId: "recommendation", slotId: "advisor", output: recommendationValidator }, input);
      },
    });
    const binding: StepDefinitionBindingV1 = {
      workflowContractVersion: "weather-advisor-v1",
      stepDefinitionVersion: "1",
      stepDefinitionSha256: stepDefinitionHash(step as never),
      inputSha256: hashJson({ city: "Istanbul" }),
    };
    const firstClaim = await durableStorage.steps.claim({
      ref: { runRef: { executionId: "weather-link" }, stepId: "recommend" },
      binding,
      attemptId: "attempt-1",
      fence: 1,
      expectedRevision: 0,
      claimedAt: "2026-09-04T08:00:00.000Z",
    });
    if (firstClaim.kind !== "claimed") throw new Error("Expected claim.");
    await durableStorage.steps.registerOperation({
      ref: firstClaim.checkpoint.ref,
      claimToken: firstClaim.claimToken,
      kind: "agent",
      operationId: "recommend:recommendation",
      at: "2026-09-04T08:00:01.000Z",
    });
    expect(await durableStorage.agents.read({ runRef: { executionId: "weather-link" }, operationId: "recommend:recommendation" })).toBeUndefined();
    const safeCall = vi.fn(async () => ({ output: { message: "Recovered safely" } }));
    const recovered = new DurableWorkflowEngineV2({ storage: durableStorage, agents: agents(safeCall), now: monotonicClock() });
    await expect(recovered.execute({
      workflowContractVersion: "weather-advisor-v1",
      host: host("weather-link", "attempt-2", 2),
      async execute(context) { return (await context.steps.run(step, { city: "Istanbul" })).output; },
    })).resolves.toEqual({ message: "Recovered safely" });
    expect(safeCall).toHaveBeenCalledOnce();

    const failingCall = vi.fn(async () => { throw new Error("connection lost after dispatch"); });
    const failedRoot = await mkdtemp(path.join(tmpdir(), "durable-dispatch-"));
    const first = new DurableWorkflowEngineV2({ storage: await storage(failedRoot), agents: agents(failingCall), now: monotonicClock() });
    const execute = (engine: DurableWorkflowEngineV2, attempt: ExecutionHostContextV1) => engine.execute({
      workflowContractVersion: "weather-advisor-v1",
      host: attempt,
      async execute(context) { return (await context.steps.run(step, { city: "Istanbul" })).output; },
    });
    await expect(execute(first, host("weather-unknown"))).rejects.toBeInstanceOf(DurableOutcomeUnknownError);
    const second = new DurableWorkflowEngineV2({ storage: await storage(failedRoot), agents: agents(failingCall), now: monotonicClock() });
    await expect(execute(second, host("weather-unknown", "attempt-2", 2))).rejects.toBeInstanceOf(DurableOutcomeUnknownError);
    expect(failingCall).toHaveBeenCalledOnce();
    await expect((await storage(failedRoot)).steps.read({ runRef: { executionId: "weather-unknown" }, stepId: "recommend" })).resolves.toMatchObject({ state: "OUTCOME_UNKNOWN" });
  });

  it("retries a stale dispatched read effect but durably stops an unsafe write", async () => {
    async function interrupted(safety: "read" | "unsafe-write" | "idempotent-write") {
      const root = await mkdtemp(path.join(tmpdir(), `durable-${safety}-`));
      const durableStorage = await storage(root);
      const effectCall = vi.fn(async () => ({ temperatureC: 24 }));
      const effect = {
        schemaVersion: 1,
        operationId: "weather.current",
        definitionVersion: "1",
        safety,
        input: inputValidator,
        output: weatherValidator,
        execute: effectCall,
      } as EffectDefinitionV1<{ city: string }, { temperatureC: number }>;
      const step = defineStep({
        schemaVersion: 1,
        id: "read-weather",
        definitionVersion: "1",
        input: inputValidator,
        output: weatherValidator,
        async execute(context, input) { return context.effects.run(effect, input); },
      });
      const runRef = { executionId: `${safety}-run` };
      const stepRef = { runRef, stepId: step.id };
      const stepClaim = await durableStorage.steps.claim({
        ref: stepRef,
        binding: {
          workflowContractVersion: "weather-advisor-v1",
          stepDefinitionVersion: "1",
          stepDefinitionSha256: stepDefinitionHash(step as never),
          inputSha256: hashJson({ city: "Istanbul" }),
        },
        attemptId: "attempt-1",
        fence: 1,
        expectedRevision: 0,
        claimedAt: "2026-09-04T08:00:00.000Z",
      });
      if (stepClaim.kind !== "claimed") throw new Error("Expected step claim.");
      const operationId = "read-weather:weather.current";
      await durableStorage.steps.registerOperation({ ref: stepRef, claimToken: stepClaim.claimToken, kind: "effect", operationId, at: "2026-09-04T08:00:01.000Z" });
      const operation = await durableStorage.effects.claim({
        ref: { runRef, operationId },
        definitionVersion: "1",
        definitionSha256: hashJson({ schemaVersion: 1, operationId: "weather.current", definitionVersion: "1", safety }),
        inputSha256: hashJson({ city: "Istanbul" }),
        safety,
        adapterConformanceRecorded: false,
        attemptId: "attempt-1",
        fence: 1,
        expectedRevision: 0,
        claimedAt: "2026-09-04T08:00:02.000Z",
      });
      await durableStorage.effects.markDispatched({ ref: operation.ref, claimToken: operation.activeClaim!, at: "2026-09-04T08:00:03.000Z" });
      return { root, runRef, step, effectCall };
    }

    const read = await interrupted("read");
    const readEngine = new DurableWorkflowEngineV2({ storage: await storage(read.root), agents: agents(async () => ({ output: null })), now: monotonicClock() });
    await expect(readEngine.execute({
      workflowContractVersion: "weather-advisor-v1",
      host: host(read.runRef.executionId, "attempt-2", 2),
      async execute(context) { return (await context.steps.run(read.step, { city: "Istanbul" })).output; },
    })).resolves.toEqual({ temperatureC: 24 });
    expect(read.effectCall).toHaveBeenCalledOnce();

    for (const safety of ["unsafe-write", "idempotent-write"] as const) {
      const unsafe = await interrupted(safety);
      const unsafeEngine = new DurableWorkflowEngineV2({ storage: await storage(unsafe.root), agents: agents(async () => ({ output: null })), now: monotonicClock() });
      await expect(unsafeEngine.execute({
        workflowContractVersion: "weather-advisor-v1",
        host: host(unsafe.runRef.executionId, "attempt-2", 2),
        async execute(context) { return (await context.steps.run(unsafe.step, { city: "Istanbul" })).output; },
      })).rejects.toBeInstanceOf(DurableOutcomeUnknownError);
      expect(unsafe.effectCall).not.toHaveBeenCalled();
      await expect((await storage(unsafe.root)).steps.read({ runRef: unsafe.runRef, stepId: "read-weather" })).resolves.toMatchObject({ state: "OUTCOME_UNKNOWN" });
      const operations = (await storage(unsafe.root)).effects;
      const operationRef = { runRef: unsafe.runRef, operationId: "read-weather:weather.current" };
      const terminal = await operations.read(operationRef);
      expect(terminal).toMatchObject({ state: "OUTCOME_UNKNOWN", attemptCount: 1,
        terminal: { code: "effect_dispatch_outcome_unknown" } });
      expect(terminal!.activeClaim).toBeUndefined();
      await expect(unsafeEngine.execute({ workflowContractVersion: "weather-advisor-v1",
        host: host(unsafe.runRef.executionId, "attempt-3", 3),
        execute: async context => (await context.steps.run(unsafe.step, { city: "Istanbul" })).output,
      })).rejects.toBeInstanceOf(DurableOutcomeUnknownError);
      expect(await operations.read(operationRef)).toEqual(terminal);
      expect(unsafe.effectCall).not.toHaveBeenCalled();
    }
  });

  it("uses the host effect adapter without executing the workflow effect implementation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-mock-effect-"));
    const realExecute = vi.fn(async () => { throw new Error("real effect must not execute"); });
    const effect: EffectDefinitionV1<{ city: string }, { temperatureC: number }> = {
      schemaVersion: 1,
      operationId: "weather.current",
      definitionVersion: "1",
      safety: "read",
      input: inputValidator,
      output: weatherValidator,
      execute: realExecute,
    };
    const adaptedExecute = vi.fn(async () => ({ temperatureC: 31 }));
    const effects: DurableEffectOperationExecutorV1 = {
      execute: adaptedExecute,
      async reconcile() { throw new Error("read effects do not reconcile"); },
    };
    const step = defineStep({
      schemaVersion: 1,
      id: "read-weather",
      definitionVersion: "1",
      input: inputValidator,
      output: weatherValidator,
      execute: (context, input) => context.effects.run(effect, input),
    });
    const engine = new DurableWorkflowEngineV2({
      storage: await storage(root),
      agents: agents(async () => ({ output: null })),
      effects,
      now: monotonicClock(),
    });

    await expect(engine.execute({
      workflowContractVersion: "weather-advisor-v1",
      host: host("mock-effect-run"),
      execute: async context => (await context.steps.run(step, { city: "Istanbul" })).output,
    })).resolves.toEqual({ temperatureC: 31 });
    expect(realExecute).not.toHaveBeenCalled();
    expect(adaptedExecute).toHaveBeenCalledOnce();
    expect(adaptedExecute.mock.calls[0]?.[0]).toMatchObject({
      stableOperationId: "read-weather:weather.current",
      definition: { operationId: "weather.current", safety: "read" },
      input: { city: "Istanbul" },
    });
  });

  it("uses only the project Local boundary and journals one whole-run host attempt", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-local-"));
    const runRef = { executionId: "host-run" };
    const paths = resolveLocalDurableExecutionPaths(project, runRef);
    expect(paths.root).toBe(path.join(project, ".arkimux", "local", "runs", "host-run", "durable"));
    const durableStorage = createLocalDurableExecutionStorage(project, runRef);
    expect(durableStorage.root).toBe(paths.root);
    const wholeRunHost = new LocalWholeRunExecutionHostV1({ repositoryRoot: project });
    const attempt = await wholeRunHost.nextAttempt(runRef, { maxDurationMs: 60_000, finalizationReserveMs: 1_000, maxScratchBytes: 1_000_000 });
    const callback = vi.fn(async () => ({ ok: true }));
    await expect(wholeRunHost.executeAttempt(attempt, callback)).resolves.toEqual({ status: "completed", output: { ok: true } });
    expect(callback).toHaveBeenCalledOnce();
    await expect(stat(attempt.scratchDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const records = await wholeRunHost.listAttempts(runRef);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: "COMPLETED", fence: 1, runRef });
  });

  it("composes V3 invocation storage with the unchanged Run, performance, artifact, and result stores", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-composition-"));
    const existing = {
      runState: { kind: "run-state" },
      performance: { kind: "performance" },
      artifacts: { kind: "artifacts" },
      results: { kind: "results" },
    } as const;
    const composed = composeLocalExecutionStorageV2(project, { executionId: "composed-run" }, existing);
    expect(composed).toMatchObject({ schemaVersion: 1, ...existing });
    expect(composed.root).toBe(path.join(project, ".arkimux", "local", "runs", "composed-run", "durable"));
    expect(composed.steps).toBeInstanceOf(FileStepCheckpointStoreV2);
    expect(composed.agents).toBeInstanceOf(FileAgentOperationStoreV1);
    expect(composed.effects).toBeInstanceOf(FileEffectOperationStoreV1);
    const composedV3 = composeLocalExecutionStorageV3(project, { executionId: "composed-run" }, existing);
    expect(composedV3.invocations).toBeInstanceOf(FileWorkflowInvocationStoreV1);
  });

  it("stores one immutable validated invocation without resolved configuration or Credentials", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-invocation-"));
    const runRef = { executionId: "invocation-run" };
    const paths = resolveLocalDurableExecutionPaths(project, runRef);
    const store = createLocalWorkflowInvocationStore(project, runRef);
    const invocation = workflowInvocation(runRef.executionId);
    await store.create(invocation);
    await store.create(invocation);
    await expect(store.read(runRef)).resolves.toEqual(invocation);
    expect(paths.invocation).toBe(path.join(project, ".arkimux", "local", "runs", runRef.executionId, "durable", "invocation.json"));
    expect((await stat(paths.invocation)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(paths.invocation, "utf8");
    expect(persisted).not.toMatch(/credential|apiKey|secret|token/i);
    await expect(store.create({ ...invocation, resultKind: "different-result-v1" })).rejects.toMatchObject({ name: "DurableRecordConflictError" });

    const invalidRunRef = { executionId: "invalid-invocation" };
    const invalidPaths = resolveLocalDurableExecutionPaths(project, invalidRunRef);
    await mkdir(invalidPaths.root, { recursive: true });
    await writeFile(invalidPaths.invocation, `${JSON.stringify({ ...workflowInvocation(invalidRunRef.executionId), credential: "must-not-be-stored" })}\n`, "utf8");
    await expect(createLocalWorkflowInvocationStore(project, invalidRunRef).read(invalidRunRef)).rejects.toThrow(/unknown fields \[credential\]/);
  });

  it("loads every interrupted latest attempt and ignores Runs completed by a later attempt", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-restart-"));
    await writeAttempt(project, "active-a", "attempt-1", 1, "RUNNING");
    await writeAttempt(project, "active-b", "attempt-1", 1, "RUNNING");
    await writeAttempt(project, "recovered", "attempt-1", 1, "RUNNING");
    await writeAttempt(project, "recovered", "attempt-2", 2, "COMPLETED");
    await expect(listInterruptedLocalRuns(project)).resolves.toEqual([
      { executionId: "active-a" },
      { executionId: "active-b" },
    ]);
    const resumed: string[] = [];
    await expect(resumeInterruptedLocalRuns(project, async ({ executionId }) => { resumed.push(executionId); })).resolves.toEqual([
      { executionId: "active-a" },
      { executionId: "active-b" },
    ]);
    expect(resumed).toEqual(["active-a", "active-b"]);
  });

  it.each(["waiting_for_input", "resume_queued"] as const)("leaves canonical %s Runs to retained recovery despite legacy artifacts", async status => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-retained-status-"));
    for (const artifacts of ["none", "invocation", "attempt", "both"]) {
      const executionId = `${status}-${artifacts}`;
      await writeStoredRunStatus(project, executionId, inputWaitRunStatus(status));
      if (artifacts === "invocation" || artifacts === "both") {
        await createLocalWorkflowInvocationStore(project, { executionId }).create(workflowInvocation(executionId));
      }
      if (artifacts === "attempt" || artifacts === "both") await writeAttempt(project, executionId, "attempt-1", 1, "RUNNING");
    }
    await writeRunStatus(project, "legacy-running", "running");
    await expect(listInterruptedLocalRuns(project)).resolves.toEqual([{ executionId: "legacy-running" }]);
    const resumed: string[] = [];
    await expect(resumeInterruptedLocalRuns(project, async ref => { resumed.push(ref.executionId); }))
      .resolves.toEqual([{ executionId: "legacy-running" }]);
    expect(resumed).toEqual(["legacy-running"]);
  });

  it.each(["running", "complete", "failed"] as const)("preserves legacy %s status recovery behavior", async status => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-legacy-status-"));
    const executionId = "legacy-status";
    await writeRunStatus(project, executionId, status);
    await createLocalWorkflowInvocationStore(project, { executionId }).create(workflowInvocation(executionId));
    await writeAttempt(project, executionId, "attempt-1", 1, "RUNNING");
    await expect(listInterruptedLocalRuns(project)).resolves.toEqual(status === "running" ? [{ executionId }] : []);
  });

  it.each(["waiting_for_input", "resume_queued"] as const)("rejects malformed %s metadata instead of silently skipping it", async status => {
    const invalid = [
      { requestId: undefined },
      { requestId: "../not-a-request" },
      { expiresAt: "tomorrow" },
      { expiresAt: "2027-09-16T00:00:00Z" },
      { activeComputeMs: undefined },
      { activeComputeMs: -1 },
      { activeComputeMs: 1.5 },
      { activeComputeMs: Number.MAX_SAFE_INTEGER + 1 },
      { activeComputeMs: "123" },
      { updatedAt: "not-a-timestamp" },
      { unexpected: true },
    ];
    for (const mutation of invalid) {
      const project = await mkdtemp(path.join(tmpdir(), "durable-invalid-wait-status-"));
      await writeStoredRunStatus(project, "invalid-wait", { ...inputWaitRunStatus(status), ...mutation });
      await createLocalWorkflowInvocationStore(project, { executionId: "invalid-wait" }).create(workflowInvocation("invalid-wait"));
      await writeAttempt(project, "invalid-wait", "attempt-1", 1, "RUNNING");
      await expect(listInterruptedLocalRuns(project)).rejects.toThrow();
    }
  });

  it.each([
    { status: "unknown-status", updatedAt: "2026-09-16T00:00:00.000Z" },
    { status: "running", updatedAt: "2026-09-16T00:00:00.000Z", unexpected: true },
    { status: "running", updatedAt: "2026-09-16T00:00:00.000Z", kind: "status" },
    { status: "running", updatedAt: "2026-09-16T00:00:00.000Z", kind: "heartbeat" },
    { status: "complete", updatedAt: "2026-09-16T00:00:00.000Z", unexpected: true },
    { status: "failed", updatedAt: "2026-09-16T00:00:00.000Z", message: "failed", unexpected: true },
  ])("still rejects unknown lifecycle status/fields: $status", async status => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-unknown-status-"));
    await writeStoredRunStatus(project, "invalid-status", status);
    await expect(listInterruptedLocalRuns(project)).rejects.toThrow();
  });

  it("reconstructs each interrupted call from its invocation, workflow definition, and exact Run Configuration", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-reconstruct-"));
    await writeAttempt(project, "active-a", "attempt-1", 1, "RUNNING");
    await writeAttempt(project, "active-b", "attempt-1", 1, "RUNNING");
    await writeAttempt(project, "active-d", "attempt-1", 1, "COMPLETED");
    await writeRunStatus(project, "finished", "complete");
    for (const executionId of ["active-a", "active-b", "active-c", "active-d", "finished"]) {
      await createLocalWorkflowInvocationStore(project, { executionId }).create(workflowInvocation(executionId));
    }
    const definition: DurableWorkflowDefinitionV1 = {
      workflow: { kind: "weather-advisor", version: 1 },
      workflowContractVersion: "weather-advisor-v1",
      resultKind: "weather-advisor-result-v1",
      input: jsonObject(),
      output: jsonObject(),
      async execute() { return { result: "unused" }; },
    };
    const definitionLookups: string[] = [];
    const configurationLookups: string[] = [];
    const resumed: string[] = [];
    const coordinator = new LocalInterruptedWorkflowRecoveryCoordinatorV1({
      repositoryRoot: project,
      definitions: {
        resolve(workflow, contractVersion) {
          definitionLookups.push(`${workflow.kind}@${workflow.version}:${contractVersion}`);
          return definition;
        },
      },
      runConfigurations: {
        async resolve(workflow, reference) {
          configurationLookups.push(`${workflow.kind}@${workflow.version}:${reference.configurationId}:${reference.contentHash}`);
          return { configurationId: reference.configurationId, contentHash: reference.contentHash };
        },
      },
      async resume({ invocation, runConfiguration }) {
        resumed.push(`${invocation.runRef.executionId}:${String((invocation.input as { city: string }).city)}:${runConfiguration.configurationId}`);
      },
    });
    await expect(coordinator.resumeAll()).resolves.toEqual([
      { executionId: "active-a" },
      { executionId: "active-b" },
      { executionId: "active-c" },
      { executionId: "active-d" },
    ]);
    expect(definitionLookups).toEqual(Array(4).fill("weather-advisor@1:weather-advisor-v1"));
    expect(configurationLookups).toEqual([
      `weather-advisor@1:weather-advisor-v1:${"a".repeat(64)}`,
      `weather-advisor@1:weather-advisor-v1:${"a".repeat(64)}`,
      `weather-advisor@1:weather-advisor-v1:${"a".repeat(64)}`,
      `weather-advisor@1:weather-advisor-v1:${"a".repeat(64)}`,
    ]);
    expect(resumed).toEqual([
      "active-a:Istanbul:weather-advisor-v1",
      "active-b:Istanbul:weather-advisor-v1",
      "active-c:Istanbul:weather-advisor-v1",
      "active-d:Istanbul:weather-advisor-v1",
    ]);
  });

  it("durably cancels before execution and does not start a workflow callback", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-cancel-"));
    const runRef = { executionId: "cancelled-run" };
    const wholeRunHost = new LocalWholeRunExecutionHostV1({ repositoryRoot: project, now: monotonicClock() });
    const attempt = await wholeRunHost.nextAttempt(runRef, { maxDurationMs: 60_000, finalizationReserveMs: 1_000, maxScratchBytes: 1_000_000 });
    await wholeRunHost.cancel(runRef, "cancelled");
    const callback = vi.fn(async () => ({ ok: true }));
    await expect(wholeRunHost.executeAttempt(attempt, callback)).resolves.toEqual({ status: "cancelled", reason: "cancelled" });
    expect(callback).not.toHaveBeenCalled();
    await expect(wholeRunHost.listAttempts(runRef)).resolves.toMatchObject([{ state: "CANCELLED", terminal: { code: "cancelled" } }]);

    const stepCallback = vi.fn(async () => ({ temperatureC: 24 }));
    const step = defineStep({ schemaVersion: 1, id: "not-started", definitionVersion: "1", input: inputValidator, output: weatherValidator, execute: stepCallback });
    const engine = new DurableWorkflowEngineV2({ storage: createLocalDurableExecutionStorage(project, { executionId: "cancelled-step" }), agents: agents(async () => ({ output: null })), now: monotonicClock() });
    await expect(engine.execute({
      workflowContractVersion: "weather-advisor-v1",
      host: { ...host("cancelled-step"), cancellation: { aborted: true, reason: "cancelled" } },
      async execute(context) { return (await context.steps.run(step, { city: "Istanbul" })).output; },
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(stepCallback).not.toHaveBeenCalled();
  });

  it("publishes completion through the unchanged Run State V5 and Results V1 ports", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "durable-lifecycle-"));
    const runRef = { executionId: "lifecycle-run" };
    const wholeRunHost = new LocalWholeRunExecutionHostV1({ repositoryRoot: project });
    const attempt = await wholeRunHost.nextAttempt(runRef, { maxDurationMs: 60_000, finalizationReserveMs: 1_000, maxScratchBytes: 1_000_000 });
    const engine = new DurableWorkflowEngineV2({
      storage: createLocalDurableExecutionStorage(project, runRef),
      agents: agents(async () => ({ output: null })),
      now: monotonicClock(),
    });
    const updates: unknown[] = [];
    const published: unknown[] = [];
    const invocation = workflowInvocation(runRef.executionId);
    const invocationStore = createLocalWorkflowInvocationStore(project, runRef);
    const observingHost = {
      async executeAttempt<Output extends JsonValue>(requestedAttempt: typeof attempt, callback: Parameters<typeof wholeRunHost.executeAttempt<Output>>[1]) {
        await expect(invocationStore.read(runRef)).resolves.toEqual(invocation);
        return wholeRunHost.executeAttempt(requestedAttempt, callback);
      },
      cancel: wholeRunHost.cancel.bind(wholeRunHost),
    };
    const executor = new DurableWorkflowRunExecutorV2({
      engine,
      host: observingHost,
      invocations: invocationStore,
      runState: { update: async (value) => { updates.push(value); } },
      results: {
        async publish(value) {
          published.push(value);
          return { runRef: value.runRef, resultKind: value.resultKind, resultId: "result.json" };
        },
      },
      now: monotonicClock(),
    });
    await expect(executor.execute({
      attempt,
      invocation,
      definition: {
        workflow: invocation.workflow,
        workflowContractVersion: invocation.workflowContractVersion,
        resultKind: invocation.resultKind,
        input: inputValidator,
        output: jsonObject<{ recommendation: string }>(),
        async execute(_context, input) {
          expect(input).toEqual({ city: "Istanbul" });
          return { recommendation: "Take an umbrella" };
        },
      },
    })).resolves.toEqual({ status: "complete", result: { runRef, resultKind: "weather-advisor-result-v1", resultId: "result.json" } });
    expect(updates).toEqual([
      { kind: "status", status: "running", updatedAt: "2026-09-04T08:00:00.000Z" },
      { kind: "status", status: "complete", updatedAt: "2026-09-04T08:00:00.001Z" },
    ]);
    expect(published).toEqual([{
      envelopeSchemaVersion: 1,
      resultKind: "weather-advisor-result-v1",
      runRef,
      payload: { recommendation: "Take an umbrella" },
    }]);
  });
});

function monotonicClock(): () => Date {
  let milliseconds = Date.parse("2026-09-04T08:00:00.000Z");
  return () => new Date(milliseconds++);
}

async function writeAttempt(
  project: string,
  executionId: string,
  attemptId: string,
  fence: number,
  state: "RUNNING" | "COMPLETED",
): Promise<void> {
  const runRef = { executionId };
  const paths = resolveLocalDurableExecutionPaths(project, runRef);
  await mkdir(paths.attempts, { recursive: true });
  await writeFile(path.join(paths.attempts, `${attemptId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    runRef,
    attemptId,
    fence,
    deadlineAt: "2030-01-01T00:00:00.000Z",
    finalizationReserveMs: 1_000,
    scratchDirectory: path.join(paths.scratch, attemptId),
    limits: { maxDurationMs: 60_000, maxScratchBytes: 1_000_000 },
    state,
    startedAt: "2026-09-04T08:00:00.000Z",
    updatedAt: "2026-09-04T08:00:00.000Z",
  }, null, 2)}\n`, "utf8");
}

async function writeRunStatus(
  project: string,
  executionId: string,
  status: "running" | "complete" | "failed",
): Promise<void> {
  await writeStoredRunStatus(project, executionId, {
    status,
    updatedAt: "2026-09-04T08:00:00.000Z",
    ...(status === "failed" ? { message: "failed" } : {}),
  });
}

function inputWaitRunStatus(status: "waiting_for_input" | "resume_queued") {
  return { status, updatedAt: "2026-09-16T00:00:00.000Z", requestId: "confirm-request-1",
    expiresAt: "2027-09-16T00:00:00.000Z", activeComputeMs: 123 };
}

async function writeStoredRunStatus(project: string, executionId: string, projection: Record<string, unknown>): Promise<void> {
  const runRoot = path.dirname(resolveLocalDurableExecutionPaths(project, { executionId }).root);
  const state = path.join(runRoot, "state");
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "run-status.json"), `${JSON.stringify(projection, null, 2)}\n`, "utf8");
}
