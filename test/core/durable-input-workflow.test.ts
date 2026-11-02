import { afterEach, describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { LocalRetainedWorkflowRunnerV1 } from "../../local/src/localRetainedWorkflowRunner.ts";
import { DurableWorkflowEngineV3 } from "../../core/src/application/durableInputWorkflowEngine.ts";
import { createLocalDurableExecutionStorage } from "../../local/src/localDurableWorkflowRuntime.ts";
import { inputWaitJsonSnapshot, type WorkflowExecutionContextV2 } from "../../core/src/application/inputWait.ts";
import { type DurableAgentOperationExecutorV1, type JsonValue } from "../../core/src/application/durableWorkflow.ts";
import type { ExecutionHostContextV1 } from "../../core/src/application/durableExecution.ts";
import { constructionDescriptorFile } from "../../core/src/application/retainedWorkflowConstruction.ts";
import { ExternalProviderError } from "../../core/src/application/externalError.ts";
import { projectRetainedRunStatus } from "../../local/src/localRetainedRunOrchestrator.ts";

const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
const ref = { executionId: "same-run" }, requirements = { node: "22" }, limits = { totalMs: 120_000, attemptMs: 60_000, finalizationReserveMs: 1000 };
const bindings = { author: { providerId: "fixture", authProviderId: "credential-ref", model: "fixed-model", configurationSha256: "a".repeat(64) } };
const form = { descriptor: { schemaVersion: 1 as const, id: "city-form", version: "v1", fields: [] }, output: { parse: () => ({ schemaVersion: 1 as const, fields: {}, files: {} }) } };
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(code?: string, constructionExport: string | null = "createInputWorkflow") {
  const root = await mkdtemp(path.join(tmpdir(), "input-engine-unit-")); roots.push(root);
  const storeRoot = path.join(root, "retained"), store = await FileRetainedExecutionStoreV1.open(storeRoot); stores.push(store);
  const source = code ?? await readFile(fileURLToPath(new URL("./fixtures/input-workflow.mjs", import.meta.url)), "utf8");
  const build = await store.publishBuild({ inputSha256: "a".repeat(64), entryPoint: "workflow.mjs", files: {
    "workflow.mjs": Buffer.from(source), "assets/src/prompt.md": Buffer.from("Pinned prompt"),
    ...(constructionExport === null ? {} : { [constructionDescriptorFile]: Buffer.from(JSON.stringify({ schemaVersion: 1, export: constructionExport })) }),
  }, hostRequirements: requirements });
  const invocation = { schemaVersion: 1, runRef: ref, workflow: { kind: "input-demo", version: 1 }, workflowContractVersion: "input-demo-v1", resultKind: "input-demo-result-v1",
    runConfiguration: { configurationId: "config-v1", contentHash: "a".repeat(64) }, input: { prompt: "original input" }, createdAt: new Date().toISOString() };
  const binding = { id: "binding", buildSha256: build.buildSha256, workflow: invocation.workflow, invocation, runConfiguration: { marker: "pinned-config" },
    executionProfile: { maxScratchBytes: 1024 * 1024 }, nonSecretEnvironment: { SETTING: "pinned-env" }, credentialReferences: ["credential-ref"], hostRequirements: requirements };
  await store.createRun(ref, binding);
  let calls = 0, closes = 0, preparations = 0;
  const executor: DurableAgentOperationExecutorV1 = { resolve: () => bindings.author,
    invoke: async request => { calls++; return { output: request.operation.output.parse({ call: calls, stableId: request.stableOperationId }) }; } };
  const workerPath = path.join(root, "worker.mjs");
  await bundle({ entryPoints: [fileURLToPath(new URL("../../local/src/retainedAttemptWorker.ts", import.meta.url))], outfile: workerPath, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const runner = (current = store) => new LocalRetainedWorkflowRunnerV1({ store: current, projectRoot: root, workerPath,
    prepareAgents: async (saved, _signal, prompts) => { preparations++;
      expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved.runConfiguration)).toBe(true);
      expect(saved.runConfiguration).toEqual({ marker: "pinned-config" }); expect(saved.credentialReferences).toEqual(["credential-ref"]);
      expect(prompts).toEqual({ author: "Pinned prompt" });
      return { bindings, invoke: executor.invoke, close: async () => { closes++; } }; } });
  const storage = createLocalDurableExecutionStorage(root, ref);
  async function engine() {
    const owner = await store.claim(ref, `direct-${Date.now()}`, requirements, limits);
    const host: ExecutionHostContextV1 = { schemaVersion: 1, runRef: ref, attemptId: owner.attemptId, fence: owner.fence, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      finalizationReserveMs: 1000, scratchDirectory: root, limits: { maxDurationMs: 60_000, maxScratchBytes: 1000 }, cancellation: { aborted: false }, heartbeat: async () => {} };
    return { owner, host, engine: new DurableWorkflowEngineV3({ storage, agents: executor, input: store }) };
  }
  return { root, storeRoot, store, source, binding, runner, storage, engine, executor, calls: () => calls, closes: () => closes, preparations: () => preparations };
}

describe("input workflow engine and retained Local worker", () => {
  it.each([false, true])("preserves classified provider diagnostics through real worker IPC after resume=%s", async resume => {
    const f = await setup();
    if (resume) {
      expect((await f.runner().execute(ref, limits, requirements)).status).toBe("suspended");
      const waiting = (await f.store.read(ref))!, request = Object.values(waiting.requests)[0].definition;
      await f.store.submit(ref, request.requestId, { submissionId: "answer", expectedRevision: 1,
        response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "developer", async (_r, v) => v);
    }
    const original = new ExternalProviderError("fixture-provider", "Quota exceeded [model]. Retry after 42 seconds. https://provider.test/help key=opaque-test-secret",
      { code: "quota_exceeded", httpStatus: 429, retryability: "retryable",
        secretValues: ["opaque-test-secret"], cause: new Error("private internal detail") });
    f.executor.invoke = async () => { throw original; };
    const result = await f.runner().execute(ref, limits, requirements);
    const saved = (await f.store.read(ref))!, stepId = resume ? "after" : "before";
    expect(result).toMatchObject({ status: "failed", externalDiagnostic: original.externalDiagnostic, message: original.message });
    expect(saved.failure).toMatchObject({ externalDiagnostic: original.externalDiagnostic, message: original.message });
    expect(projectRetainedRunStatus(saved)).toMatchObject({ status: "failed", message: original.message });
    expect((await f.storage.steps.read({ runRef: ref, stepId }))?.terminal).toMatchObject({
      externalDiagnostic: original.externalDiagnostic, message: original.message, retryability: "retryable",
    });
    expect((await f.storage.agents.read({ runRef: ref, operationId: `${stepId}:${stepId}-agent` }))?.terminal).toMatchObject({
      externalDiagnostic: original.externalDiagnostic, retryability: "retryable",
    });
    expect(JSON.stringify([result, saved.failure])).not.toMatch(/opaque-test-secret|private internal detail|stack/);
    expect(saved.owner).toBeNull(); expect(f.closes()).toBe(resume ? 2 : 1);
  });

  it("does not publish arbitrary host provider exceptions as external diagnostics", async () => {
    const f = await setup();
    f.executor.invoke = async () => { throw new TypeError("secret-value at /private/provider-state"); };
    const result = await f.runner().execute(ref, limits, requirements), saved = (await f.store.read(ref))!;
    const step = await f.storage.steps.read({ runRef: ref, stepId: "before" });
    expect(result.status).toBe("failed"); expect(saved.failure?.externalDiagnostic).toBeUndefined();
    expect(step?.terminal?.externalDiagnostic).toBeUndefined();
    expect(JSON.stringify([result, saved.failure, step?.terminal])).not.toMatch(/secret-value|private\/provider-state|TypeError/);
    expect(saved.owner).toBeNull(); expect(f.closes()).toBe(1);
  });

  it("suspends a real worker after one agent operation, restarts, and resumes the same pinned Run", async () => {
    const f = await setup();
    const first = await f.runner().execute(ref, limits, requirements);
    expect(first.status).toBe("suspended"); expect(f.calls()).toBe(1); expect(f.closes()).toBe(1);
    const waiting = (await f.store.read(ref))!, request = Object.values(waiting.requests)[0];
    expect(waiting.owner).toBeNull(); expect(waiting.status).toBe("waiting_for_input");
    expect(await f.storage.steps.read({ runRef: ref, stepId: "ask" })).toBeUndefined();
    await f.store.publishBuild({ inputSha256: "b".repeat(64), entryPoint: "workflow.mjs", files: { "workflow.mjs": Buffer.from(f.source.replace('"original"', '"edited"')) }, hostRequirements: requirements });
    await f.store.close(); const reopened = await FileRetainedExecutionStoreV1.open(f.storeRoot); stores.push(reopened);
    const response = { schemaVersion: 1 as const, fields: { city: "Istanbul" }, files: {} };
    await reopened.submit(ref, request.definition.requestId, { submissionId: "answer", expectedRevision: 1, response }, "developer", async (_r, value) => value);
    expect((await reopened.recover()).map(s => s.runRef)).toEqual([ref]);
    const second = await f.runner(reopened).execute(ref, limits, requirements);
    expect(second.status).toBe("completed"); expect(f.calls()).toBe(2); expect(f.closes()).toBe(2);
    if (second.status === "completed") expect(second.output).toMatchObject({ before: { call: 1 }, after: { call: 2 }, answer: response, originalInput: { prompt: "original input" }, marker: "original",
      construction: { config: "pinned-config", prompt: "Pinned prompt" } });
    expect(f.preparations()).toBe(2);
    const checkpoint = await f.storage.steps.read({ runRef: ref, stepId: "ask" });
    expect(checkpoint?.state).toBe("COMPLETED");
    expect(checkpoint?.completed?.performance.inputTokens).toEqual({ availability: "unavailable", reason: "not_applicable" });
    const state = (await reopened.read(ref))!; expect(state.status).toBe("complete"); expect(state.owner).toBeNull();
    expect(Object.values(state.commands).map(c => c.state)).toEqual(["done"]);
    expect((await reopened.previewBuildCleanup()).builds.map(b => b.buildSha256)).not.toContain(f.binding.buildSha256);
  });

  it.each([null, "missingConstructor"])("rejects missing construction %s without preparing agents", async name => {
    const f = await setup(undefined, name);
    const result = await f.runner().execute(ref, limits, requirements);
    expect(result.status).toBe("failed"); expect(f.preparations()).toBe(0); expect(f.calls()).toBe(0);
    expect((await f.store.read(ref))?.owner).toBeNull();
  });

  it("allows input before the first agent call and keeps asset reads isolated", async () => {
    const original = await readFile(fileURLToPath(new URL("./fixtures/input-workflow.mjs", import.meta.url)), "utf8");
    const source = original.replace('const before = await context.steps.run(step("before", async c => c.agents.invoke(operation("before-agent"), input)), input);',
      'const before = { output: {} };').replace('const prompt = new TextDecoder()',
      'context.readAsset("src/prompt.md").fill(0); const prompt = new TextDecoder()');
    const f = await setup(source), result = await f.runner().execute(ref, limits, requirements);
    expect(result.status).toBe("suspended"); expect(f.calls()).toBe(0); expect(f.closes()).toBe(1);
    expect((await f.store.read(ref))?.owner).toBeNull();
  });

  it("rejects a constructor returning the wrong workflow identity before provider preparation", async () => {
    const source = (await readFile(fileURLToPath(new URL("./fixtures/input-workflow.mjs", import.meta.url)), "utf8"))
      .replace('workflowContractVersion: "input-demo-v1"', 'workflowContractVersion: "wrong-version"');
    const f = await setup(source), result = await f.runner().execute(ref, limits, requirements);
    expect(result.status).toBe("failed"); expect(f.preparations()).toBe(0); expect(f.calls()).toBe(0);
  });

  it.each([
    'export const createInputWorkflow = {};',
    'export function createInputWorkflow() { return {}; }',
    'export function createInputWorkflow(context) { context.environment.SETTING = "changed"; return {}; }',
    'export function createInputWorkflow(context) { context.runConfiguration.marker = "changed"; return {}; }',
    'export function createInputWorkflow(context) { context.readAsset("../../.env"); return {}; }',
  ])("rejects invalid or impure construction before preparing providers", async code => {
    const f = await setup(code), result = await f.runner().execute(ref, limits, requirements);
    expect(result.status).toBe("failed"); expect(f.preparations()).toBe(0); expect(f.calls()).toBe(0);
  });

  it("does not allow catching suspension to run a later step or publish success", async () => {
    const f = await setup(), e = await f.engine(); let after = false;
    const result = await e.engine.execute({ workflowContractVersion: "v1", owner: e.owner, host: e.host, execute: async context => {
      try { await context.steps.waitForInput({ id: "ask", title: "Input", expiresAfter: "1h", form }); } catch {}
      try { await context.steps.run({ schemaVersion: 1, id: "after", definitionVersion: "v1", input: { parse: inputWaitJsonSnapshot }, output: { parse: inputWaitJsonSnapshot }, execute: async () => { after = true; return {}; } }, {}); } catch {}
      return {};
    } });
    expect(result.status).toBe("suspended"); expect(after).toBe(false);
  });

  it("rejects a nested wait without dispatching a later provider operation", async () => {
    const f = await setup(), e = await f.engine();
    await expect(e.engine.execute({ workflowContractVersion: "v1", owner: e.owner, host: e.host, execute: async context => {
      await context.steps.run({ schemaVersion: 1, id: "outer", definitionVersion: "v1", input: { parse: inputWaitJsonSnapshot }, output: { parse: inputWaitJsonSnapshot }, execute: async step => {
        try { await context.steps.waitForInput({ id: "nested", title: "Input", expiresAfter: "1h", form }); } catch {}
        return inputWaitJsonSnapshot(await step.agents.invoke({ schemaVersion: 1, operationId: "bad", slotId: "author", output: { parse: inputWaitJsonSnapshot } }, {}));
      } }, {}); return {};
    } })).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });

  it("rejects parallel waits and unawaited input without returning a completed result", async () => {
    for (const mode of ["parallel", "unawaited"]) {
      const f = await setup(), e = await f.engine();
      await expect(e.engine.execute({ workflowContractVersion: "v1", owner: e.owner, host: e.host, execute: async context => {
        void context.steps.waitForInput({ id: "one", title: "Input", expiresAfter: "1h", form }).catch(() => {});
        if (mode === "parallel") await context.steps.waitForInput({ id: "two", title: "Input", expiresAfter: "1h", form });
        return {};
      } })).rejects.toThrow();
    }
  });

  it("does not send a shell API key to the child process", async () => {
    const previous = process.env.ARKIMUX_TEST_SECRET; process.env.ARKIMUX_TEST_SECRET = "must-not-reach-worker";
    try {
      const code = (await readFile(fileURLToPath(new URL("./fixtures/input-workflow.mjs", import.meta.url)), "utf8"))
        .replace('marker: "original"', 'marker: process.env.ARKIMUX_TEST_SECRET ?? "absent"');
      const f = await setup(code); await f.runner().execute(ref, limits, requirements);
      const request = Object.values((await f.store.read(ref))!.requests)[0];
      await f.store.submit(ref, request.definition.requestId, { submissionId: "answer", expectedRevision: 1, response: { schemaVersion: 1, fields: { city: "Paris" }, files: {} } }, "developer", async (_r, value) => value);
      const result = await f.runner().execute(ref, limits, requirements);
      expect(result.status).toBe("completed"); if (result.status === "completed") expect(result.output).toMatchObject({ marker: "absent" });
    } finally { if (previous === undefined) delete process.env.ARKIMUX_TEST_SECRET; else process.env.ARKIMUX_TEST_SECRET = previous; }
  });
});
