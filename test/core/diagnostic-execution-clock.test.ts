import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiagnosticExecutionClockV2, readDiagnosticClock } from "../../local/src/diagnosticExecutionClock.ts";
import { LocalRetainedExecutionHostV2 } from "../../local/src/localRetainedExecutionHost.ts";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import type { DiagnosticClockRecordV2 } from "../../core/src/application/activeCompute.ts";
import { DurableWorkflowEngineV2 } from "../../core/src/application/durableWorkflowEngine.ts";
import { DurableWorkflowEngineV3 } from "../../core/src/application/durableInputWorkflowEngine.ts";
import type { ExecutionHostContextV1 } from "../../core/src/application/durableExecution.ts";
import { defineStep, hashJson, type EffectDefinitionV1, type WorkflowExecutionContextV1 } from "../../core/src/application/durableWorkflow.ts";
import { FileAgentOperationStoreV1, FileEffectOperationStoreV1, FileStepCheckpointStoreV2, FileDurableExecutionEventSinkV1 } from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";

const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
const ref = { executionId: "live-clock-run" }, requirements = { node: "22" };
const limits = { totalMs: 900_000, attemptMs: 600_000, finalizationReserveMs: 1000 };
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function clockFixture() {
  let mono = 1000; const records: DiagnosticClockRecordV2[] = [], failed = vi.fn(), changed = vi.fn();
  const clock = new DiagnosticExecutionClockV2({ monotonicNow: () => mono, startedAt: mono, limitMs: 1000,
    priorSpentMs: 100, priorExcludedPauseMs: 20, changed, failed,
    persist: async (revision, record) => { expect(revision).toBe(records.length); records.push(record); } });
  return { clock, records, failed, changed, advance: (ms: number) => { mono += ms; } };
}
async function hostFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "diagnostic-clock-unit-")); roots.push(root);
  let mono = 0, wall = Date.parse("2026-09-10T07:00:00.000Z");
  const store = await FileRetainedExecutionStoreV1.open(root, { now: () => new Date(wall) }); stores.push(store);
  const build = await store.publishBuild({ inputSha256: "a".repeat(64), entryPoint: "entry.mjs", files: { "entry.mjs": Buffer.from("export const x=1;") }, hostRequirements: requirements });
  await store.createRun(ref, { id: "binding", buildSha256: build.buildSha256, workflow: {}, invocation: {}, runConfiguration: {}, executionProfile: {}, nonSecretEnvironment: {}, credentialReferences: [], hostRequirements: requirements });
  const host = new LocalRetainedExecutionHostV2(store, { monotonicNow: () => mono });
  return { root, store, host, monotonicNow: () => mono, advance: (ms: number) => { mono += ms; wall += ms; } };
}

describe("diagnostic clock transitions", () => {
  it("excludes only an observed quiet pause and preserves budget across resume", async () => {
    const f = clockFixture(); f.advance(10);
    await f.clock.observePause({ pauseId: "pause-1", activeCount: 0, activityKnown: true });
    f.advance(86400_000);
    expect(f.clock.snapshot()).toMatchObject({ clock: "paused", spentMs: 110, remainingMs: 890, excludedPauseMs: 86400_020 });
    await f.clock.resume("pause-1"); f.advance(5);
    expect(f.clock.snapshot()).toMatchObject({ clock: "running", spentMs: 115, remainingMs: 885, excludedPauseMs: 86400_020 });
    await f.clock.finish(); f.advance(3);
    expect(f.clock.settlement()).toEqual({ elapsedMs: 18, wallElapsedMs: 86400_018, excludedPauseMs: 86400_000 });
    expect(f.records.map(record => record.revision)).toEqual([1, 2, 3]);
  });
  it("charges active external work and unknown activity even while JavaScript is paused", async () => {
    const f = clockFixture();
    await f.clock.observePause({ pauseId: "pause-1", activeCount: 1, activityKnown: true }); f.advance(20);
    expect(f.clock.snapshot()).toMatchObject({ clock: "running", reason: "external_work", spentMs: 120 });
    await f.clock.setActivity({ activeCount: 0, activityKnown: false }); f.advance(30);
    expect(f.clock.snapshot()).toMatchObject({ clock: "running", reason: "unknown_activity", spentMs: 150 });
    await f.clock.setActivity({ activeCount: 0, activityKnown: true }); f.advance(100);
    expect(f.clock.snapshot()).toMatchObject({ clock: "paused", spentMs: 150 });
    await f.clock.setActivity({ activeCount: 1, activityKnown: true }); f.advance(10);
    expect(f.clock.snapshot()).toMatchObject({ clock: "running", spentMs: 160, excludedPauseMs: 120 });
  });
  it("rejects stale identities without changing the clock or durable revision", async () => {
    const f = clockFixture(); await f.clock.observePause({ pauseId: "pause-1", activeCount: 0, activityKnown: true }); f.advance(100);
    await expect(f.clock.resume("other")).rejects.toThrow("Stale");
    await expect(f.clock.observePause({ pauseId: "other", activeCount: 0, activityKnown: true })).rejects.toThrow("different");
    expect(f.clock.snapshot()).toMatchObject({ clock: "paused", spentMs: 100, revision: 1, excludedPauseMs: 120 });
    await f.clock.resume("pause-1"); expect(f.records.at(-1)?.excludedPauseMs).toBe(100);
  });
  it("fails closed after uncertain persistence and returns null accounting", async () => {
    const failed = vi.fn(); let mono = 0;
    const clock = new DiagnosticExecutionClockV2({ monotonicNow: () => mono, startedAt: 0, limitMs: 100, priorSpentMs: 0, priorExcludedPauseMs: 0,
      changed: () => {}, failed, persist: async () => { throw new Error("private filesystem detail"); } });
    await expect(clock.observePause({ pauseId: "pause", activeCount: 0, activityKnown: true })).rejects.toThrow("persistence is uncertain");
    mono += 10;
    expect(clock.snapshot()).toMatchObject({ clock: "uncertain", spentMs: null, remainingMs: null, excludedPauseMs: null });
    await expect(clock.resume("pause")).rejects.toThrow("uncertain"); expect(failed).toHaveBeenCalledOnce();
  });
  it("blocks a regressed monotonic clock rather than minting allowance", () => {
    const f = clockFixture(); f.advance(10); expect(f.clock.elapsedMs()).toBe(10); f.advance(-1);
    expect(f.clock.snapshot()).toMatchObject({ clock: "uncertain", spentMs: null }); expect(f.failed).toHaveBeenCalledOnce();
  });
  it("charges bounded cleanup after closing a pause, and disallows reopening it", async () => {
    const f = clockFixture(); await f.clock.observePause({ pauseId: "pause", activeCount: 0, activityKnown: true }); f.advance(1000);
    await f.clock.finish(); f.advance(7);
    expect(f.clock.settlement()).toEqual({ elapsedMs: 7, wallElapsedMs: 1007, excludedPauseMs: 1000 });
    await expect(f.clock.observePause({ pauseId: "late", activeCount: 0, activityKnown: true })).rejects.toThrow("closing");
  });
});

describe("retained diagnostic accounting", () => {
  it.each([
    { version: 2, diagnostic: true, reconcile: false },
    { version: 2, diagnostic: true, reconcile: true },
    { version: 3, diagnostic: true, reconcile: false },
    { version: 3, diagnostic: true, reconcile: true },
    { version: 2, diagnostic: false, reconcile: false },
    { version: 3, diagnostic: false, reconcile: false },
  ])("registers V$version contexts before callbacks, diagnostic=$diagnostic reconcile=$reconcile", async ({ version, diagnostic, reconcile }) => {
    const f = await hostFixture(), root = path.join(f.root, "context-engine");
    const owner = await f.store.claim(ref, "context-attempt", requirements, limits);
    const excluded: unknown[] = [], observed: unknown[] = [];
    const storage = { steps: new FileStepCheckpointStoreV2({ root }), agents: new FileAgentOperationStoreV1({ root }),
      effects: new FileEffectOperationStoreV1({ root }), events: new FileDurableExecutionEventSinkV1({ root }) };
    const agents = { resolve: () => { throw new Error("Unexpected agent"); }, invoke: async () => { throw new Error("Unexpected agent"); } };
    const host: ExecutionHostContextV1 = { schemaVersion: 1, runRef: ref, attemptId: owner.attemptId, fence: owner.fence,
      deadlineAt: "2030-09-10T06:00:00.000Z", finalizationReserveMs: 1000, scratchDirectory: root,
      limits: { maxDurationMs: 1000, maxScratchBytes: 1000 }, heartbeat: async () => {}, cancellation: { aborted: false },
      ...(diagnostic ? { diagnosticExclude: (value: unknown) => { excluded.push(value); } } : {}) };
    const assertExcluded = (value: object) => {
      expect(excluded.includes(value)).toBe(diagnostic); observed.push(value);
      expect(Object.hasOwn(value, "diagnosticExclude")).toBe(false);
    };
    const validator = { parse: (value: unknown) => value as { value: number } };
    const executeEffect = vi.fn(async (context: object, input: { value: number }) => { assertExcluded(context); return { value: input.value + 1 }; });
    const reconcileEffect = vi.fn(async (context: object, input: { value: number }) => { assertExcluded(context); return { outcome: "completed" as const, output: { value: input.value + 1 } }; });
    const effect: EffectDefinitionV1<{ value: number }, { value: number }> = { schemaVersion: 1, operationId: "read", definitionVersion: "v1", input: validator, output: validator,
      ...(reconcile ? { safety: "reconcilable-write" as const, execute: executeEffect, reconcile: reconcileEffect } : { safety: "read" as const, execute: executeEffect }) };
    if (reconcile) {
      const effectRef = { runRef: ref, operationId: "calculate:read" }, at = "2026-09-10T07:00:00.000Z";
      const claimed = await storage.effects.claim({ ref: effectRef, definitionVersion: effect.definitionVersion,
        definitionSha256: hashJson({ schemaVersion: effect.schemaVersion, operationId: effect.operationId, definitionVersion: effect.definitionVersion, safety: effect.safety }),
        inputSha256: hashJson({ value: 10 }), safety: effect.safety, adapterConformanceRecorded: false, attemptId: "previous", fence: 1, expectedRevision: 0, claimedAt: at });
      await storage.effects.markDispatched({ ref: effectRef, claimToken: claimed.activeClaim!, at });
    }
    const step = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "v1", input: validator, output: validator,
      execute: async (context, input) => { assertExcluded(context); return context.effects.run(effect, input); } });
    const execute = async (context: WorkflowExecutionContextV1) => {
      assertExcluded(context);
      expect(context.runRef).toBe(ref); expect(context.deadlineAt).toBe(host.deadlineAt);
      expect(typeof context.steps.run).toBe("function");
      return (await context.steps.run(step, { value: 10 })).output;
    };
    const output = version === 2
      ? await new DurableWorkflowEngineV2({ storage, agents }).execute({ workflowContractVersion: "v1", host, execute })
      : await new DurableWorkflowEngineV3({ storage, agents, input: f.store }).execute({ workflowContractVersion: "v1", host, owner, execute });
    expect(output).toEqual(version === 2 ? { value: 11 } : { status: "completed", output: { value: 11 } });
    expect(executeEffect).toHaveBeenCalledTimes(reconcile ? 0 : 1); expect(reconcileEffect).toHaveBeenCalledTimes(reconcile ? 1 : 0);
    expect(observed).toHaveLength(3); expect(excluded).toHaveLength(diagnostic ? version === 2 ? 3 : 4 : 0);
    if (diagnostic && version === 3) {
      expect(excluded[0]).not.toBe(observed[0]); expect(excluded[1]).toBe(observed[0]);
      expect((excluded[0] as WorkflowExecutionContextV1).steps).not.toBe((observed[0] as WorkflowExecutionContextV1).steps);
    }
  });
  it("checks the updated engine clock and tracks validators/effects without extending an in-flight effect", async () => {
    const f = await hostFixture(), root = path.join(f.root, "engine"); let depth = 0, validations = 0;
    let currentDeadline = "2026-09-10T08:00:00.000Z", capturedDeadline = "";
    const checked = { parse(value: unknown) { expect(depth).toBe(1); validations++; return value as { value: number }; } };
    const engine = new DurableWorkflowEngineV2({ now: () => new Date("2030-09-10T07:00:00.000Z"),
      storage: { steps: new FileStepCheckpointStoreV2({ root }), agents: new FileAgentOperationStoreV1({ root }), effects: new FileEffectOperationStoreV1({ root }), events: new FileDurableExecutionEventSinkV1({ root }) },
      agents: { resolve: () => { throw new Error("Unexpected agent"); }, invoke: async () => { throw new Error("Unexpected agent"); } } });
    const host: ExecutionHostContextV1 = { schemaVersion: 1, runRef: ref, attemptId: "engine", fence: 1,
      deadlineAt: "2026-09-10T06:00:00.000Z", finalizationReserveMs: 1000, scratchDirectory: root,
      limits: { maxDurationMs: 1000, maxScratchBytes: 1000 }, heartbeat: async () => {}, cancellation: { aborted: false },
      diagnosticClock: { deadlineAt: () => currentDeadline, remainingMs: () => 60_000 }, diagnosticActivity: async work => { depth++; try { return await work(); } finally { depth--; } } };
    const effect: EffectDefinitionV1<{ value: number }, { value: number }> = { schemaVersion: 1, operationId: "read", definitionVersion: "v1", safety: "read", input: checked, output: checked,
      execute: async (context, input) => { expect(depth).toBe(1); capturedDeadline = context.deadlineAt; currentDeadline = "2026-09-10T09:00:00.000Z";
        expect(context.deadlineAt).toBe(capturedDeadline); return { value: input.value + 1 }; } };
    const step = defineStep({ schemaVersion: 1, id: "calculate", definitionVersion: "v1", input: checked, output: checked,
      execute: async (context, input) => { expect(depth).toBe(0); const value = await context.effects.run(effect, input);
        expect(context.deadlineAt).toBe(currentDeadline); return value; } });
    expect(await engine.execute({ workflowContractVersion: "v1", host, execute: async context => (await context.steps.run(step, { value: 10 })).output })).toEqual({ value: 11 });
    expect(capturedDeadline).toBe("2026-09-10T08:00:00.000Z"); expect(validations).toBe(4); expect(depth).toBe(0);
  });
  it("uses one fenced record for host and worker, and settles a long quiet pause", async () => {
    const f = await hostFixture();
    // The worker reader and host must observe the same fake OS clock, regardless of machine uptime.
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => BigInt(f.monotonicNow()) * 1_000_000n);
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, diagnostic: true, prepare: async context => ({ start: () => ({
      completion: (async () => {
        const clock = context.diagnosticClock!; f.advance(2000);
        await clock.observePause({ pauseId: "entry", activeCount: 0, activityKnown: true });
        expect(() => readDiagnosticClock(clock.clockPath, context.owner)).toThrow("not running");
        f.advance(2 * 86400_000);
        expect(clock.snapshot()).toMatchObject({ clock: "paused", spentMs: 2000, remainingMs: 898_000 });
        await clock.resume("entry");
        const stored = readDiagnosticClock(clock.clockPath, context.owner);
        expect(stored.deadlineAt).toBe(context.deadlineAt); expect(stored.record.excludedPauseMs).toBe(2 * 86400_000);
        expect(() => readDiagnosticClock(clock.clockPath, { ...context.owner, fence: context.owner.fence + 1 })).toThrow();
        f.advance(500); return { status: "completed" as const, output: { ok: true } };
      })(), stop: async () => { f.advance(100); },
    }) }) });
    expect(result).toMatchObject({ status: "completed", spentMs: 2600 });
    const state = (await f.store.read(ref))!;
    expect(state.owner).toBeNull(); expect(state.compute).toMatchObject({ diagnosticOnly: true, spentMs: 2600, excludedPauseMs: 2 * 86400_000,
      lastAttempt: { elapsedMs: 2600, wallElapsedMs: 2 * 86400_000 + 2600, excludedPauseMs: 2 * 86400_000 } });
  });
  it("can cancel a quiet paused worker without continuing it", async () => {
    const f = await hostFixture(), abort = new AbortController(); let stopped = false;
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, diagnostic: true, signal: abort.signal,
      prepare: async context => ({ start: () => ({ completion: (async () => {
        f.advance(10); await context.diagnosticClock!.observePause({ pauseId: "pause", activeCount: 0, activityKnown: true });
        f.advance(86400_000); abort.abort(); return await new Promise<never>(() => {});
      })(), stop: async () => { stopped = true; f.advance(5); } }) }) });
    expect(stopped).toBe(true); expect(result.status).toBe("cancelled");
    expect((await f.store.read(ref))!.compute).toMatchObject({ spentMs: 15, excludedPauseMs: 86400_000 });
    expect((await f.store.read(ref))!.owner).toBeNull();
  });
  it("does not reset the work deadline when execution resumes", async () => {
    const f = await hostFixture();
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, diagnostic: true,
      prepare: async context => ({ start: () => ({ completion: (async () => {
        f.advance(598_000); await context.diagnosticClock!.observePause({ pauseId: "pause", activeCount: 0, activityKnown: true });
        f.advance(86400_000); await context.diagnosticClock!.resume("pause"); f.advance(1000);
        return { status: "completed" as const, output: {} };
      })(), stop: async () => {} }) }) });
    expect(result).toMatchObject({ status: "failed", code: "compute-deadline-exceeded" });
    expect((await f.store.read(ref))!.compute!.spentMs).toBe(599_000);
  });
  it("does not revive an exhausted budget by observing a late pause", async () => {
    const f = await hostFixture(); let stopped = false;
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, diagnostic: true,
      prepare: async context => ({ start: () => ({ completion: (async () => {
        f.advance(599_000); await context.diagnosticClock!.observePause({ pauseId: "late", activeCount: 0, activityKnown: true });
        return await new Promise<never>(() => {});
      })(), stop: async () => { stopped = true; } }) }) });
    expect(stopped).toBe(true); expect(result).toMatchObject({ status: "failed", code: "compute-deadline-exceeded" });
  });
  it("fences durable clock revisions and refuses changing an ordinary Run into a diagnostic Run", async () => {
    const f = await hostFixture(), owner = await f.store.claim(ref, "first", requirements, limits, true);
    const initial = (await f.store.read(ref))!.compute!.active!.diagnostic!;
    const next = { ...initial, revision: 1, wallMs: 10, chargedMs: 10 };
    await f.store.recordDiagnosticClock(ref, owner, 0, next);
    await expect(f.store.recordDiagnosticClock(ref, owner, 0, next)).rejects.toThrow("Stale");
    await expect(f.store.recordDiagnosticClock(ref, { ...owner, fence: owner.fence + 1 }, 1, { ...next, revision: 2 })).rejects.toThrow("stale-owner");
    await expect(f.store.recordDiagnosticClock(ref, owner, 1, { ...next, revision: 2, wallMs: 9, chargedMs: 9 })).rejects.toThrow("decrease");
    const request = await f.store.openRequest(ref, owner, { stepId: "ask", title: "Ask", form: { schemaVersion: 1, id: "form", version: "v1", fields: [] }, expiresAfter: "1h" });
    await f.store.settleAttempt(ref, owner, { elapsedMs: 10, outcome: "suspended", requestId: request.requestId, diagnostic: { wallElapsedMs: 10, excludedPauseMs: 0 } });
    await f.store.submit(ref, request.requestId, { submissionId: "answer", expectedRevision: 1, response: { schemaVersion: 1, fields: {}, files: {} } }, "developer", async (_request, response) => response);
    await expect(f.store.claim(ref, "second", requirements, limits)).rejects.toThrow("binding-mismatch");
    await f.store.claim(ref, "second", requirements, limits, true);
  });
});
