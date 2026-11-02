import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build as bundle } from "esbuild";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { runConfigurationContentHash } from "../../core/src/application/runConfiguration.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { reserveLocalRetainedRun } from "../../local/src/localRetainedRunAdmission.ts";
import { reserveDeclaredRetainedRun } from "../../cli/src/declaredRetainedRunAdmission.ts";
import { LocalRetainedWorkflowRunnerV1 } from "../../local/src/localRetainedWorkflowRunner.ts";
import type { PreparedRetainedAgentsV1 } from "../../local/src/localRetainedWorkflowRunner.ts";
import { LocalRetainedRunService } from "../../local/src/localRetainedRunService.ts";
import { publishRetainedPerformance } from "../../local/src/localRetainedPerformance.ts";
import { CodedWorkflowRegistry, RunApplicationService, createRunRouter } from "../../apps/packages/run/api/src/index.ts";
import { FileRunCatalogStore } from "../../core/src/infrastructure/storage/fileRunCatalogStore.ts";
import { FilePublishedResultQueryStore } from "../../core/src/infrastructure/storage/filePublishedResultQueryStore.ts";
import { FileRunArtifactQueryStore } from "../../core/src/infrastructure/storage/fileRunArtifactQueryStore.ts";
import { FileRunPerformanceV2Store } from "../../core/src/infrastructure/storage/fileRunPerformanceV2Store.ts";
import { runDetailResponseSchema, runListResponseSchema, runPerformanceResponseSchema } from "../../apps/packages/run/contract/src/schemas.ts";
import fixtures from "../fixtures/public-workflow-contract/fixtures.json";

let workerBytes: Buffer;
const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
const services: LocalRetainedRunService[] = [];
beforeAll(async () => {
  const result = await bundle({ entryPoints: [fileURLToPath(new URL("../../local/src/retainedAttemptWorker.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
  workerBytes = Buffer.from(result.outputFiles[0].contents);
});
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const validCode = `
export const input = { parse: value => { if (!Number.isInteger(value.count)) throw new Error("PRIVATE_INPUT"); return { count: value.count + 1 }; } };
export const output = { parse: value => value };
export function defineWorkflow() { return { workflow: { kind: "weather-advisor", version: 1 }, workflowContractVersion: "1",
  resultKind: "weather-advisor.result", input, output, execute: async (_context, value) => value }; }
export function construct() { return { workflow: defineWorkflow(), agentPrompts: { author: "Original prompt" } }; }
`;
async function setup(code = validCode) {
  const root = await mkdtemp(path.join(tmpdir(), "retained-admission-unit-")); roots.push(root);
  const workerPath = path.join(root, "worker.mjs"); await writeFile(workerPath, workerBytes);
  let clockOffset = 0;
  const store = await FileRetainedExecutionStoreV1.open(path.join(root, "storage"), { now: () => new Date(Date.now() + clockOffset) }); stores.push(store);
  const build = await store.publishBuild({ inputSha256: hashJson(code), entryPoint: "entry.mjs", files: {
    "entry.mjs": Buffer.from(code), "construction.json": Buffer.from(JSON.stringify({ schemaVersion: 1, export: "construct" })),
  }, hostRequirements: { node: "22" } });
  const ref = { executionId: "new-run" }, workflow = { kind: "weather-advisor", version: 1 };
  const configuration = { configurationId: "test-v1", workflow, agents: { author: {} } };
  const invocation = { schemaVersion: 1, runRef: ref, workflow, workflowContractVersion: "1", resultKind: "weather-advisor.result",
    input: { count: 1 }, runConfiguration: { configurationId: "test-v1", contentHash: runConfigurationContentHash(configuration) }, createdAt: new Date().toISOString() };
  const binding = { id: "binding-1", buildSha256: build.buildSha256, workflow, invocation, runConfiguration: configuration,
    executionProfile: { maxScratchBytes: 1048576 }, nonSecretEnvironment: { SETTING: "original" }, credentialReferences: ["connection-1"], hostRequirements: { node: "22" } };
  const options = { runRef: ref, binding, agentSlotIds: ["author"], workerPath };
  return { root, workerPath, store, ref, binding, options, advanceTime: (ms: number) => { clockOffset += ms; } };
}

async function apiFixture(wait = false, code?: string, invoke?: PreparedRetainedAgentsV1["invoke"]) {
  const waitCode = validCode.replace('execute: async (_context, value) => value', `execute: async (context, value) => {
    const answer = await context.steps.waitForInput({ id: "ask", title: "Your city", expiresAfter: "366d", form: {
      descriptor: { schemaVersion: 1, id: "city-form", version: "v1", fields: [{ id: "city", label: "City", type: "text", required: true, maxLength: 50 }] }, output,
    } }); return { value, answer: answer.output };
  }`);
  const f = await setup(code ?? (wait ? waitCode : validCode));
  const actor = { userId: "developer", roleId: "runner" }, invocation = f.binding.invocation;
  const binding = { ...f.binding, executionProfile: { ...f.binding.executionProfile,
    computeLimits: { totalMs: 60000, attemptMs: 30000, finalizationReserveMs: 1000 } },
    runManifest: { schemaVersion: 3 as const, runRef: f.ref, workflow: f.binding.workflow, actor,
      createdAt: invocation.createdAt, runConfiguration: invocation.runConfiguration } };
  let preparations = 0;
  const runner = new LocalRetainedWorkflowRunnerV1({ store: f.store, projectRoot: f.root, workerPath: f.workerPath,
    prepareAgents: async () => { preparations++; return { bindings: { author: { providerId: "fixture", authProviderId: "connection-1", configurationSha256: "a".repeat(64) } },
      invoke: invoke ?? (async () => { throw new Error("This fixture must not call a model."); }), close: async () => {} }; } });
  const retained = new LocalRetainedRunService({ projectRoot: f.root, store: f.store, runner, workerPath: f.workerPath, hostRequirements: binding.hostRequirements });
  services.push(retained);
  const registration = retained.registration({ workflow: binding.workflow, agentSlots: [{ slotId: "author", title: "Author" }],
    prepareBinding: async request => ({ ...binding, invocation: { ...invocation, input: inputWaitJsonSnapshot(request.input) } }) });
  const workflows = new CodedWorkflowRegistry([registration]);
  const runsRoot = path.join(f.root, ".arkimux/local/runs"), runRoot = path.join(runsRoot, f.ref.executionId);
  const catalog = new FileRunCatalogStore(runsRoot);
  const resolved = { configuration: binding.runConfiguration, contentHash: invocation.runConfiguration.contentHash };
  const queued: Parameters<typeof workflows.execute>[0][] = [];
  const api = new RunApplicationService({ catalog, workflows, inputRequests: retained.inputRequests,
    artifacts: { open: async ref => new FileRunArtifactQueryStore(path.join(runsRoot, ref.executionId)) },
    results: { open: async ref => new FilePublishedResultQueryStore({ root: path.join(runsRoot, ref.executionId), runRef: ref }) },
    performance: { open: async ref => new FileRunPerformanceV2Store(path.join(runsRoot, ref.executionId, "state"), ref) },
    runConfigurations: { publish: async () => resolved, resolve: async () => resolved,
      lifecycleStatus: async () => "active", archive: async () => {}, restore: async () => {}, list: async () => ({ items: [resolved] }) },
    dispatcher: { dispatch: async command => { queued.push(command); } },
  });
  const permissions = ["runs:read-own", "runs:archive-own", "runs:respond-own", "workflow:weather-advisor:start"];
  const router = createRunRouter({ service: api, authenticate: async request => ({
    user: { schemaVersion: 1, userId: request.headers.get("x-user") ?? actor.userId, status: "active",
      identity: { providerId: "fixture", subjectId: "developer" }, registeredAt: invocation.createdAt },
    roles: [{ schemaVersion: 1, roleId: "runner", permissions }], permissions,
  }) });
  const submit = (input: unknown = invocation.input, extra: Record<string, string> = {}) => router.request("/api/v1/runs", {
    method: "POST", headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify({ workflow: binding.workflow, roleId: "runner", runConfigurationId: resolved.configuration.configurationId,
      requestedExecutionId: f.ref.executionId, input }),
  });
  return { ...f, binding, retained, runner, registration, workflows, router, submit, queued, catalog, runRoot, permissions, preparations: () => preparations };
}

describe("retained Runs through the existing Run API", () => {
  async function waitingApi(code?: string) {
    const f = await apiFixture(true, code);
    expect((await f.submit()).status).toBe(202);
    await f.workflows.execute(f.queued[0]);
    const listUrl = `/api/v1/runs/${f.ref.executionId}/input-requests`;
    const response = await f.router.request(listUrl);
    expect(response.status).toBe(200);
    const request = (await response.json()).items[0];
    const url = `${listUrl}/${request.definition.requestId}/response`;
    const body = { submissionId: "answer", expectedRevision: request.revision,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } };
    const answer = (value: unknown = body, headers = {}) => f.router.request(url, { method: "POST",
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
    return { ...f, request, listUrl, url, body, answer };
  }

  it("accepts an HTTP answer, resumes the same Run, and returns the original receipt on retry", async () => {
    const f = await waitingApi();
    expect(f.request).toMatchObject({ status: "pending", revision: 1 });
    expect(f.request).not.toHaveProperty("optionsSha256");
    const accepted = await f.answer(); expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    expect(receipt).toMatchObject({ runRef: f.ref, receipt: { responderId: "developer", submissionId: "answer" } });
    await vi.waitFor(async () => expect((await f.catalog.get(f.ref))?.status?.status).toBe("complete"));
    expect(await (await f.answer()).json()).toEqual(receipt);
    const item = (await (await f.router.request(f.listUrl)).json()).items[0];
    expect(item).toMatchObject({ status: "submitted", revision: 2, response: f.body.response, receipt: receipt.receipt });
    expect(await f.store.listRuns()).toHaveLength(1);
  });

  it("requires Run read access and separate response permission on every attempt", async () => {
    const f = await waitingApi();
    expect((await f.router.request(f.listUrl, { headers: { "x-user": "other" } })).status).toBe(403);
    expect((await f.answer(f.body, { "x-user": "other" })).status).toBe(403);
    f.permissions.splice(f.permissions.indexOf("runs:respond-own"), 1);
    expect((await f.router.request(f.listUrl)).status).toBe(200);
    expect((await f.answer()).status).toBe(403);
    f.permissions.push("runs:respond-all");
    expect((await f.answer(f.body, { "x-user": "other" })).status).toBe(403);
    f.permissions.push("runs:read-all");
    expect((await f.answer(f.body, { "x-user": "other" })).status).toBe(202);
    f.permissions.splice(f.permissions.indexOf("runs:respond-all"), 1);
    expect((await f.answer()).status).toBe(403);
  });

  it("rejects malformed envelopes and reports invalid answer fields without accepting them", async () => {
    const f = await waitingApi();
    expect((await f.answer({ ...f.body, responderId: "forged" })).status).toBe(400);
    expect((await f.answer({ ...f.body, submissionId: "constructor" })).status).toBe(400);
    for (const fields of [{}, { city: 42 }, { city: "x".repeat(51) }]) {
      const rejected = await f.answer({ ...f.body, response: { ...f.body.response, fields } });
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ error: { code: "invalid-response", details: { fieldErrors: [{ field: "city" }] } } });
    }
    expect((await f.answer({ ...f.body, response: { ...f.body.response, files: { fake: [] } } })).status).toBe(422);
    expect((await f.store.read(f.ref))!.receipts).toEqual({});
  });

  it("returns stable conflicts and exactly one acceptance for competing answers", async () => {
    const f = await waitingApi();
    const stale = await f.answer({ ...f.body, expectedRevision: 2 }); expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { details: { reason: "stale-revision" } } });
    const results = await Promise.all([f.answer(), f.answer({ ...f.body, submissionId: "other-answer" })]);
    expect(results.map(result => result.status).sort()).toEqual([202, 409]);
    expect(Object.keys((await f.store.read(f.ref))!.receipts)).toHaveLength(1);
    const winner = Object.keys((await f.store.read(f.ref))!.receipts)[0];
    const reused = await f.answer({ ...f.body, submissionId: winner, response: { ...f.body.response, fields: { city: "Paris" } } });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ error: { details: { reason: "submission-reused" } } });
  });

  it("returns not-found for unknown input requests", async () => {
    const f = await waitingApi();
    const response = await f.router.request(f.url.replace(f.request.definition.requestId, "missing"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.body) });
    expect(response.status).toBe(404);
  });

  it("returns the same receipt for concurrent identical submissions", async () => {
    const f = await waitingApi();
    const responses = await Promise.all([f.answer(), f.answer()]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(Object.keys((await f.store.read(f.ref))!.commands)).toHaveLength(1);
  });

  it("rejects answers after the fixed deadline or cancellation", async () => {
    const f = await waitingApi(); f.advanceTime(366 * 24 * 60 * 60 * 1000);
    const expired = await f.answer(); expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ error: { details: { reason: "request-closed" } } });
    const g = await waitingApi(); await g.store.cancel(g.ref);
    const cancelled = await g.answer(); expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: { details: { reason: "run-closed" } } });
    expect((await f.store.read(f.ref))!.receipts).toEqual({});
    expect((await g.store.read(g.ref))!.receipts).toEqual({});
  });

  it("uses the retained custom validator once and redacts its rejection", async () => {
    const code = validCode.replace('execute: async (_context, value) => value', `execute: async (context, value) => {
      const answer = await context.steps.waitForInput({ id: "ask", title: "City", expiresAfter: "366d", form: {
        descriptor: { schemaVersion: 1, id: "city-form", version: "v1", fields: [{ id: "city", label: "City", type: "text", required: true, maxLength: 50 }] },
        output: { parse: response => { if (response.fields.city === "reject") throw new Error("PRIVATE_VALIDATOR");
          return { ...response, fields: { city: response.fields.city + "!" } }; } },
      } }); return answer.output;
    }`);
    const f = await waitingApi(code);
    const rejected = await f.answer({ ...f.body, response: { ...f.body.response, fields: { city: "reject" } } });
    expect(rejected.status).toBe(422);
    expect(await rejected.text()).not.toContain("PRIVATE_VALIDATOR");
    expect((await f.answer()).status).toBe(202);
    await vi.waitFor(async () => expect((await f.store.read(f.ref))?.status).toBe("complete"));
    expect((await f.store.read(f.ref))!.output).toEqual({ ...f.body.response, fields: { city: "Istanbul!" } });
  });

  it("does not report storage failures as invalid answers", async () => {
    const f = await waitingApi();
    const spy = vi.spyOn(f.store, "submit").mockRejectedValueOnce(new Error("PRIVATE_DISK_FAILURE"));
    const rejected = await f.answer(); expect(rejected.status).toBe(503);
    expect(await rejected.text()).not.toContain("PRIVATE_DISK_FAILURE"); spy.mockRestore();
    expect((await f.answer()).status).toBe(202);
  });

  it("leaves the answer pending when retained validation is unavailable", async () => {
    const f = await waitingApi();
    await writeFile(f.workerPath, 'process.on("message", () => process.exit(1));');
    const rejected = await f.answer(); expect(rejected.status).toBe(503);
    expect((await f.store.read(f.ref))!.status).toBe("waiting_for_input");
    expect((await f.store.read(f.ref))!.receipts).toEqual({});
  });

  it("cancels and reaps a blocked validation worker before service shutdown returns", async () => {
    const f = await waitingApi();
    const pidFile = path.join(f.root, "validation.pid");
    await writeFile(f.workerPath, `import { writeFileSync } from "node:fs";
      process.on("message", () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); });`);
    const response = f.answer();
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(pidFile, "utf8")); expect(pid).toBeGreaterThan(0); });
    await f.retained.close();
    expect((await response).status).toBe(503);
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await f.store.read(f.ref))!.receipts).toEqual({});
  });

  it("keeps a durable receipt after failed dispatch and resumes on restart", async () => {
    const f = await waitingApi();
    const dispatch = vi.spyOn(f.retained.application, "execute").mockRejectedValue(new Error("fixture dispatch unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const accepted = await f.answer(); expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect((await f.catalog.get(f.ref))?.status?.status).toBe("resume_queued");
    await f.retained.close(); dispatch.mockRestore(); log.mockRestore();
    await f.store.close();
    const store = await FileRetainedExecutionStoreV1.open(path.join(f.root, "storage")); stores.push(store);
    const restarted = new LocalRetainedRunService({ ...f.retained.options, store,
      runner: new LocalRetainedWorkflowRunnerV1({ ...f.runner.options, store }) }); services.push(restarted);
    await restarted.recover();
    expect((await store.read(f.ref))!.status).toBe("complete");
    expect(await restarted.inputRequests.submit(f.ref, f.request.definition.requestId, f.body, "developer")).toEqual(receipt);
  });
  const metrics = { providerId: "fixture", model: "fixture-model", status: "complete" as const, elapsedMs: 12, attempt: 1,
    artifacts: { eventsPath: "events", stderrPath: "stderr", lastMessagePath: "message", heartbeatPath: "heartbeat" },
    nativeToolCalls: 0, toolCallUnit: "native-tool-call" as const, usage: { inputTokens: 3, outputTokens: 2 } };
  const agentCode = validCode.replace('execute: async (_context, value) => value', `execute: async (context, value) => {
    const step = { schemaVersion: 1, id: "author-step", definitionVersion: "v1", input: output, output,
      execute: async ctx => {
        for (const operationId of ["first", "second"]) await ctx.agents.invoke({ schemaVersion: 1, operationId, slotId: "author", output }, value);
        return value;
      } };
    await context.steps.run(step, value);
    await context.steps.waitForInput({ id: "ask", title: "City", expiresAfter: "366d", form: {
      descriptor: { schemaVersion: 1, id: "city-form", version: "v1", fields: [{ id: "city", label: "City", type: "text", required: true, maxLength: 50 }] }, output,
    } });
    return value;
  }`);

  it("validates past saved agent checkpoints without repeating provider calls", async () => {
    let calls = 0;
    const f = await apiFixture(false, agentCode, async request => { calls++; return { output: request.operation.output.parse({}), metrics }; });
    expect((await f.submit()).status).toBe(202); await f.workflows.execute(f.queued[0]);
    const request = Object.values((await f.store.read(f.ref))!.requests)[0];
    const response = await f.router.request(`/api/v1/runs/${f.ref.executionId}/input-requests/${request.definition.requestId}/response`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ submissionId: "answer", expectedRevision: request.revision,
        response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }) });
    expect(response.status).toBe(202);
    await vi.waitFor(async () => expect((await f.store.read(f.ref))?.status).toBe("complete"));
    expect(calls).toBe(2);
  });

  it("does not run a callback to replace a missing checkpoint during validation", async () => {
    let calls = 0;
    const f = await apiFixture(false, agentCode, async request => { calls++; return { output: request.operation.output.parse({}), metrics }; });
    expect((await f.submit()).status).toBe(202); await f.workflows.execute(f.queued[0]);
    await rm(path.join(f.runRoot, "durable/steps/author-step.json"));
    const request = Object.values((await f.store.read(f.ref))!.requests)[0];
    await expect(f.retained.inputRequests.submit(f.ref, request.definition.requestId, { submissionId: "missing-checkpoint", expectedRevision: 1,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "developer")).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(2); expect((await f.store.read(f.ref))!.receipts).toEqual({});
  });

  it("validates a second input using the first accepted input checkpoint", async () => {
    const code = agentCode.replace('return value;\n  }', `await context.steps.waitForInput({ id: "second", title: "Confirmation", expiresAfter: "366d", form: {
      descriptor: { schemaVersion: 1, id: "confirm", version: "v1", fields: [{ id: "yes", label: "Yes", type: "boolean", required: true }] }, output,
    } }); return value;\n  }`);
    let calls = 0;
    const f = await apiFixture(false, code, async request => { calls++; return { output: request.operation.output.parse({}), metrics }; });
    expect((await f.submit()).status).toBe(202); await f.workflows.execute(f.queued[0]);
    const answers: Record<string, string | boolean>[] = [{ city: "Istanbul" }, { yes: true }];
    for (const [index, fields] of answers.entries()) {
      await vi.waitFor(async () => expect(Object.values((await f.store.read(f.ref))!.requests).filter(r => r.status === "pending")).toHaveLength(1));
      const request = Object.values((await f.store.read(f.ref))!.requests).find(r => r.status === "pending")!;
      const result = await f.retained.inputRequests.submit(f.ref, request.definition.requestId, { submissionId: `answer-${index}`, expectedRevision: request.revision,
        response: { schemaVersion: 1, fields, files: {} } }, "developer");
      if (!("receipt" in result)) throw new Error("Expected workflow input receipt.");
      expect(result.receipt.submissionId).toBe(`answer-${index}`);
    }
    await vi.waitFor(async () => expect((await f.store.read(f.ref))?.status).toBe("complete"));
    expect(calls).toBe(2);
  });

  it("dispatches an answer accepted after the old attempt made its final resume check", async () => {
    const f = await apiFixture(true);
    expect((await f.submit()).status).toBe(202);
    const originalRead = f.store.read.bind(f.store);
    let release!: () => void, reached!: () => void, block = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const originalRefresh = f.retained.application.refresh.bind(f.retained.application);
    const spy = vi.spyOn(f.retained.application, "refresh").mockImplementation(async ref => {
      const control = await originalRead(ref);
      if (!block && control?.status === "waiting_for_input" && !control.owner) { block = true; reached(); await held; }
      await originalRefresh(ref);
    });
    const old = f.workflows.execute(f.queued[0]); await ready;
    const request = Object.values((await originalRead(f.ref))!.requests)[0];
    const receipt = await f.retained.inputRequests.submit(f.ref, request.definition.requestId, { submissionId: "race-answer", expectedRevision: 1,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "developer");
    if (!("receipt" in receipt)) throw new Error("Expected workflow input receipt.");
    expect(receipt.receipt.submissionId).toBe("race-answer"); release(); await old; spy.mockRestore();
    await vi.waitFor(async () => expect((await originalRead(f.ref))?.status).toBe("complete"));
  });

  it("keeps both same-slot calls across replay and rebuilds performance after restart", async () => {
    let calls = 0;
    const f = await apiFixture(false, agentCode, async request => { calls++; return { output: request.operation.output.parse({}), metrics }; });
    expect((await f.submit()).status).toBe(202);
    await f.workflows.execute(f.queued[0]); expect(calls).toBe(2);
    const request = Object.values((await f.store.read(f.ref))!.requests)[0];
    await f.store.submit(f.ref, request.definition.requestId, { submissionId: "answer", expectedRevision: request.revision,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "developer", async (_r, response) => response);
    await f.retained.close(); await f.store.close();
    const reopened = await FileRetainedExecutionStoreV1.open(path.join(f.root, "storage")); stores.push(reopened);
    const restarted = new LocalRetainedRunService({ ...f.retained.options, store: reopened,
      runner: new LocalRetainedWorkflowRunnerV1({ ...f.runner.options, store: reopened }) }); services.push(restarted);
    await restarted.recover(); expect(calls).toBe(2);
    const performanceStore = new FileRunPerformanceV2Store(path.join(f.runRoot, "state"), f.ref);
    const performance = (await performanceStore.get(f.ref))!;
    expect(runPerformanceResponseSchema.parse(await (await f.router.request(`/api/v1/runs/${f.ref.executionId}/performance`)).json()).performance).toEqual(performance);
    expect(performance.stages).toEqual([{ stageId: "author-step", status: "complete", elapsedMs: expect.any(Number) }]);
    expect(performance.agentAttempts.map(item => [item.logicalAgentId, item.metrics.attempt, item.metrics.model])).toEqual([
      ["author", 1, "fixture-model"], ["author", 2, "fixture-model"],
    ]);
    expect(performance.usage).toEqual({ inputTokens: 6, outputTokens: 4 });
    await rm(path.join(f.runRoot, "state/performance.json"));
    await restarted.recover(); expect(await performanceStore.get(f.ref)).toEqual(performance); expect(calls).toBe(2);
  });

  it("preserves failure metrics without copying the raw provider error into performance", async () => {
    const f = await apiFixture(false, agentCode, async () => { throw Object.assign(new Error("PRIVATE_PROVIDER_ERROR"), {
      metrics: { ...metrics, status: "failed" },
    }); });
    expect((await f.submit()).status).toBe(202); await f.workflows.execute(f.queued[0]);
    const performance = await new FileRunPerformanceV2Store(path.join(f.runRoot, "state"), f.ref).get(f.ref);
    expect(performance?.agentAttempts).toEqual([expect.objectContaining({ metrics: expect.objectContaining({ status: "failed" }) })]);
    expect(performance?.stages).toEqual([{ stageId: "author-step", status: "failed", elapsedMs: expect.any(Number) }]);
    expect(JSON.stringify(performance)).not.toContain("PRIVATE_PROVIDER_ERROR");
    expect(await f.catalog.get(f.ref)).toMatchObject({ status: { status: "failed" } });
  });

  it("does not publish while owned and keeps uncertain compute and fixed expiry distinct", async () => {
    const f = await apiFixture(true);
    expect((await f.submit()).status).toBe(202); await f.workflows.execute(f.queued[0]);
    const control = (await f.store.read(f.ref))!, request = Object.values(control.requests)[0];
    const terminal = { ...control, status: "failed" as const, compute: { ...control.compute!, certainty: "uncertain" as const },
      updatedAt: new Date(Date.parse(request.definition.expiresAt) + 86400000).toISOString(),
      requests: { [request.definition.requestId]: { ...request, status: "expired" as const,
        updatedAt: new Date(Date.parse(request.definition.expiresAt) + 86400000).toISOString() } } };
    await publishRetainedPerformance(f.root, { ...terminal, owner: { attemptId: "live", fence: 1, pid: process.pid } });
    const performanceStore = new FileRunPerformanceV2Store(path.join(f.runRoot, "state"), f.ref);
    expect(await performanceStore.get(f.ref)).toBeUndefined();
    await publishRetainedPerformance(f.root, terminal);
    const timing = JSON.parse(await readFile(path.join(f.runRoot, "artifacts/retained-timing.json"), "utf8"));
    expect(timing.activeCompute).toEqual({ spentMs: control.compute!.spentMs, certainty: "uncertain" });
    expect(timing.inputWaits[0]).toMatchObject({ endedAt: request.definition.expiresAt,
      humanWaitMs: Date.parse(request.definition.expiresAt) - Date.parse(request.definition.createdAt) });
    expect((await performanceStore.get(f.ref))?.usage).toBeUndefined();
  });

  it("submits, dispatches and publishes through existing routes, without a compatibility API", async () => {
    const f = await apiFixture();
    expect((await f.submit()).status).toBe(202);
    expect(f.queued).toHaveLength(1); expect(f.preparations()).toBe(0);
    expect(await f.catalog.get(f.ref)).toMatchObject({ status: { status: "running" } });
    await Promise.all([f.workflows.execute(f.queued[0]), f.workflows.execute(f.queued[0])]);
    const detail = await f.router.request(`/api/v1/runs/${f.ref.executionId}`);
    expect(detail.status).toBe(200);
    expect(runDetailResponseSchema.parse(await detail.json()).run.status?.status).toBe("complete");
    const result = await f.router.request(`/api/v1/runs/${f.ref.executionId}/results/weather-advisor.result.json`);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ payload: { count: 2 } });
    const performance = runPerformanceResponseSchema.parse(await (await f.router.request(`/api/v1/runs/${f.ref.executionId}/performance`)).json()).performance!;
    expect(performance).toMatchObject({ agentAttempts: [], stages: [], startedAt: f.binding.runManifest.createdAt });
    expect(performance.totalElapsedMs).toBe(Date.parse(performance.completedAt) - Date.parse(performance.startedAt));
    await f.retained.recover(); expect(f.preparations()).toBe(1);
  });

  it("shows waiting and queued states, excludes them from archiving, and resumes from retained code", async () => {
    const f = await apiFixture(true);
    expect((await f.submit()).status).toBe(202);
    await f.workflows.execute(f.queued[0]);
    const detail = await f.router.request(`/api/v1/runs/${f.ref.executionId}`);
    const waiting = runDetailResponseSchema.parse(await detail.json()).run.status!;
    expect(waiting).toMatchObject({ status: "waiting_for_input", activeComputeMs: expect.any(Number) });
    const list = await f.router.request("/api/v1/runs?status=waiting_for_input");
    expect(list.status).toBe(200); expect(runListResponseSchema.parse(await list.json()).items).toHaveLength(1);
    expect((await f.router.request(`/api/v1/runs/${f.ref.executionId}/archive`, { method: "POST" })).status).toBe(409);
    expect(await (await f.router.request(`/api/v1/runs/${f.ref.executionId}/results`)).json()).toMatchObject({ items: [] });
    expect((await f.router.request(`/api/v1/runs/${f.ref.executionId}`, { headers: { "x-user": "other" } })).status).toBe(403);
    const request = Object.values((await f.store.read(f.ref))!.requests)[0];
    expect(runPerformanceResponseSchema.parse(await (await f.router.request(`/api/v1/runs/${f.ref.executionId}/performance`)).json()).performance).toBeNull();
    await f.store.submit(f.ref, request.definition.requestId, { submissionId: "answer", expectedRevision: request.revision,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "developer", async (_r, response) => response);
    await f.retained.refresh(f.ref);
    expect(await f.catalog.get(f.ref)).toMatchObject({ status: { status: "resume_queued" } });
    // Recovery has no registration/constructor callback. Only pinned code is used.
    await f.retained.recover();
    expect(await f.catalog.get(f.ref)).toMatchObject({ status: { status: "complete" } });
    expect((await f.store.read(f.ref))!.output).toMatchObject({ value: { count: 2 }, answer: { fields: { city: "Istanbul" } } });
    expect(f.preparations()).toBe(2);
    const timing = JSON.parse(await readFile(path.join(f.runRoot, "artifacts/retained-timing.json"), "utf8"));
    const control = (await f.store.read(f.ref))!;
    expect(timing.activeCompute).toEqual({ spentMs: control.compute!.spentMs, certainty: "known" });
    expect(timing.inputWaits).toEqual([expect.objectContaining({ stepId: "ask", humanWaitMs:
      Date.parse(control.receipts.answer.acceptedAt) - Date.parse(request.definition.createdAt),
      tokens: { availability: "unavailable", reason: "not_applicable" } })]);
    expect((await new FileRunPerformanceV2Store(path.join(f.runRoot, "state"), f.ref).get(f.ref))?.stages).toEqual([]);
  });

  it("repairs a crash between durable completion and publication without executing again", async () => {
    const f = await apiFixture(); expect((await f.submit()).status).toBe(202);
    await f.runner.execute(f.ref, f.binding.executionProfile.computeLimits, f.binding.hostRequirements);
    expect((await f.store.read(f.ref))!.output).toEqual({ count: 2 });
    expect(await f.catalog.get(f.ref)).toMatchObject({ status: { status: "running" } });
    await f.retained.close(); await f.store.close();
    const reopened = await FileRetainedExecutionStoreV1.open(path.join(f.root, "storage")); stores.push(reopened);
    const restarted = new LocalRetainedRunService({ ...f.retained.options, store: reopened,
      runner: new LocalRetainedWorkflowRunnerV1({ ...f.runner.options, store: reopened }) });
    services.push(restarted);
    await restarted.recover();
    expect(await f.catalog.get(f.ref)).toMatchObject({ status: { status: "complete" } });
    expect(f.preparations()).toBe(1);
    // A mismatching existing result must not be silently accepted on repair.
    await writeFile(path.join(f.runRoot, "weather-advisor.result.json"), JSON.stringify({ wrong: true }));
    await expect(restarted.recover()).rejects.toThrow("Published output differs");
  });

  it("rejects changed dispatch identity and duplicate Run IDs before running a provider", async () => {
    const f = await apiFixture(); expect((await f.submit()).status).toBe(202);
    expect((await f.submit()).status).toBe(409);
    await expect(f.registration.execute({ ...f.queued[0], actor: { userId: "intruder", roleId: "runner" } })).rejects.toThrow("Dispatch does not match");
    expect(f.preparations()).toBe(0);
  });
  it("rejects invalid input before the shared Run ID is reserved", async () => {
    const f = await apiFixture();
    const invalid = await f.submit({ count: 1.5 });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("PRIVATE_INPUT");
    expect(await f.store.read(f.ref)).toBeUndefined();
    expect((await f.submit()).status).toBe(202);
  });
  it("waits for in-progress admission to cancel before closing", async () => {
    const f = await apiFixture();
    let finish!: () => void;
    const preparing = new Promise<void>(resolve => { finish = resolve; });
    const registration = f.retained.registration({ workflow: f.binding.workflow, agentSlots: [{ slotId: "author", title: "Author" }],
      prepareBinding: async () => { await preparing; return f.binding; } });
    const pending = registration.reserve({ workflow: f.binding.workflow, actor: f.binding.runManifest.actor, input: f.binding.invocation.input,
      resolvedConfiguration: { configuration: f.binding.runConfiguration, contentHash: f.binding.invocation.runConfiguration.contentHash } });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    const closing = f.retained.close(); finish();
    await rejected; await closing;
    expect(await f.store.read(f.ref)).toBeUndefined();
  });
  it("cannot commit public completion without its result", async () => {
    const f = await apiFixture(); expect((await f.submit()).status).toBe(202);
    const owner = await f.store.claim(f.ref, "attempt-test", f.binding.hostRequirements, f.binding.executionProfile.computeLimits);
    await expect(f.store.settleAttempt(f.ref, owner, { elapsedMs: 1, outcome: "completed" })).rejects.toThrow("requires its completed output");
    expect(await f.catalog.get(f.ref)).toMatchObject({ status: { status: "running" } });
    await f.store.settleAttempt(f.ref, owner, { elapsedMs: 1, outcome: "failed" });
  });
});

describe("retained Run reservation", () => {
  it("validates before reservation and preserves raw input for one transformation per attempt", async () => {
    const f = await setup();
    const state = await reserveLocalRetainedRun(f.store, f.options);
    expect(state.status).toBe("running"); expect(state.owner).toBeNull();
    expect(state.binding.invocation).toMatchObject({ input: { count: 1 } });
    let prepared = 0;
    const runner = new LocalRetainedWorkflowRunnerV1({ store: f.store, projectRoot: f.root, workerPath: f.workerPath,
      prepareAgents: async () => { prepared++; return { bindings: { author: { providerId: "test", authProviderId: "connection-1", model: "fixed", configurationSha256: "a".repeat(64) } },
        invoke: async () => { throw new Error("No provider should run"); }, close: async () => {} }; } });
    expect(prepared).toBe(0);
    const result = await runner.execute(f.ref, { totalMs: 30000, attemptMs: 20000, finalizationReserveMs: 1000 }, f.binding.hostRequirements);
    expect(result).toMatchObject({ status: "completed", output: { count: 2 } }); expect(prepared).toBe(1);
  });
  it.each([
    ["invalid-construction", validCode.replace("workflow: defineWorkflow()", "workflow: {}")],
    ["invalid-construction", validCode.replace('version: 1', 'version: 2')],
    ["invalid-construction", validCode.replace('export function construct() {', 'export function construct() { throw new Error("PRIVATE_CONSTRUCTION");')],
    ["slot-mismatch", validCode.replace('author: "Original prompt"', 'unknown: "Original prompt"')],
    ["invalid-input", validCode.replace('return { count: value.count + 1 };', 'return undefined;')],
  ])("rejects %s without saving a Run or exposing source errors", async (code, source) => {
    const f = await setup(source);
    await expect(reserveLocalRetainedRun(f.store, f.options)).rejects.toMatchObject({ code });
    expect(await f.store.read(f.ref)).toBeUndefined();
  });
  it("rejects invalid user input without exposing the input or validator exception", async () => {
    const f = await setup(); f.binding.invocation.input.count = 1.5;
    await expect(reserveLocalRetainedRun(f.store, f.options)).rejects.toMatchObject({ code: "invalid-input", message: "The retained workflow rejected the input. No Run was reserved." });
    expect(await f.store.read(f.ref)).toBeUndefined();
  });
  it.each(["ref", "workflow", "config-id", "config-hash", "profile", "host", "slots", "duplicate-slots"])("rejects mismatched %s before reservation", async field => {
    const f = await setup();
    if (field === "ref") f.options.runRef = { executionId: "other" };
    if (field === "workflow") f.binding.workflow = { kind: "other", version: 1 };
    if (field === "config-id") f.binding.invocation.runConfiguration.configurationId = "other-v1";
    if (field === "config-hash") f.binding.invocation.runConfiguration.contentHash = "b".repeat(64);
    if (field === "profile") f.binding.executionProfile.maxScratchBytes = -1;
    if (field === "host") f.binding.hostRequirements.node = "20";
    if (field === "slots") f.options.agentSlotIds = [];
    if (field === "duplicate-slots") f.options.agentSlotIds.push("author");
    await expect(reserveLocalRetainedRun(f.store, f.options)).rejects.toMatchObject({ code: field === "slots" ? "slot-mismatch" : "invalid-binding" });
    expect(await f.store.read(f.ref)).toBeUndefined();
  });
  it("snapshots caller settings before asynchronous validation", async () => {
    const f = await setup(); const pending = reserveLocalRetainedRun(f.store, f.options);
    f.binding.nonSecretEnvironment.SETTING = "edited"; f.binding.invocation.input.count = 9; f.options.agentSlotIds.length = 0;
    const state = await pending;
    expect(state.binding.nonSecretEnvironment).toEqual({ SETTING: "original" });
    expect(state.binding.invocation).toMatchObject({ input: { count: 1 } });
  });
  it("kills a blocked constructor at the validation deadline", async () => {
    const f = await setup(validCode.replace('export function construct() {', 'export function construct() { while (true) {}'));
    await expect(reserveLocalRetainedRun(f.store, { ...f.options, validationTimeoutMs: 200 })).rejects.toMatchObject({ code: "validation-timeout" });
    expect(await f.store.read(f.ref)).toBeUndefined();
  });
  it.each([true, false])("cancels validation without reserving a Run (already aborted: %s)", async already => {
    const f = await setup(validCode.replace('export function construct() {', 'export function construct() { while (true) {}'));
    const controller = new AbortController(); if (already) controller.abort();
    const pending = reserveLocalRetainedRun(f.store, { ...f.options, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 150);
    try { await expect(pending).rejects.toMatchObject({ code: "validation-cancelled" }); } finally { clearTimeout(timer); }
    expect(await f.store.read(f.ref)).toBeUndefined();
  });
  it("rejects a missing worker without leaving a Run or hanging", async () => {
    const f = await setup();
    await expect(reserveLocalRetainedRun(f.store, { ...f.options, workerPath: path.join(f.root, "missing.mjs") })).rejects.toMatchObject({ code: "worker-unavailable" });
    expect(await f.store.read(f.ref)).toBeUndefined();
  });
  it("rejects a worker protocol error instead of treating it as successful validation", async () => {
    const f = await setup(); await writeFile(f.workerPath, 'process.on("message", () => process.send({ kind: "call", method: "agent.invoke" }));');
    await expect(reserveLocalRetainedRun(f.store, f.options)).rejects.toMatchObject({ code: "worker-unavailable" });
    expect(await f.store.read(f.ref)).toBeUndefined();
  });
  it("never runs the workflow during validation and omits inherited secrets and storage authority", async () => {
    const f = await setup(validCode.replace('export function construct() {', `export function construct() {
      if (process.env.HOME || process.env.ANTHROPIC_API_KEY || process.env.NODE_OPTIONS) throw new Error("Inherited credentials");
    `).replace('execute: async (_context, value) => value', 'execute: async () => { throw new Error("Executed during admission"); }'));
    expect((await reserveLocalRetainedRun(f.store, f.options)).owner).toBeNull();
  });
  it("connects checked registry build preparation to isolated reservation without loading the registry", async () => {
    const f = await setup(); await mkdir(path.join(f.root, "src"));
    await writeFile(path.join(f.root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    await writeFile(path.join(f.root, "src/workflow.ts"), validCode);
    await writeFile(path.join(f.root, "src/manifest.json"), JSON.stringify(fixtures.weather));
    await writeFile(path.join(f.root, "src/environment.json"), JSON.stringify({ schemaVersion: 1, variables: [] }));
    const reference = (name: string) => ({ file: "src/workflow.ts", export: name });
    await writeFile(path.join(f.root, "src/arkimux.workflows.ts"), `export const workflowDeclarations = ${JSON.stringify([{
      manifest: "src/manifest.json", environment: "src/environment.json", definition: reference("defineWorkflow"), inputValidator: reference("input"), resultValidator: reference("output"),
      result: { kind: "weather-advisor.result", schemaVersion: 1 }, agentSlots: ["author"], effects: [], construction: { ...reference("construct"), assets: [] },
    }])}; export function loadProjectWorkflows() { throw new Error("Do not load registry"); }`);
    const result = await reserveDeclaredRetainedRun(f.store, { projectRoot: f.root, binding: f.binding, workerPath: f.workerPath });
    expect(result.binding.buildSha256).not.toBe(f.binding.buildSha256);
    expect(result.binding.invocation).toEqual(f.binding.invocation);
    const retained = await f.store.readBuild(result.binding.buildSha256);
    expect(retained.manifest.preparation?.inputFiles).toHaveProperty("src/arkimux.workflows.ts");
    const before = await readFile(path.join(f.root, "src/workflow.ts"), "utf8");
    await writeFile(path.join(f.root, "src/workflow.ts"), before.replace('resultKind: "weather-advisor.result"', 'resultKind: "wrong"'));
    const next = { ...f.binding, invocation: { ...f.binding.invocation, runRef: { executionId: "invalid-next-run" } } };
    await expect(reserveDeclaredRetainedRun(f.store, { projectRoot: f.root, binding: next, workerPath: f.workerPath })).rejects.toMatchObject({ code: "invalid-construction" });
    expect(await f.store.read(next.invocation.runRef)).toBeUndefined();
    // Declaring a validator is insufficient if the constructed workflow uses another.
    for (const key of ["input", "output"]) {
      await writeFile(path.join(f.root, "src/workflow.ts"), before.replace('resultKind: "weather-advisor.result", input, output,',
        `resultKind: "weather-advisor.result", input, output, ${key}: { parse: value => value },`));
      await expect(reserveDeclaredRetainedRun(f.store, { projectRoot: f.root, binding: next, workerPath: f.workerPath })).rejects.toMatchObject({ code: "invalid-construction" });
      expect(await f.store.read(next.invocation.runRef)).toBeUndefined();
    }
  });
  it("resumes a checked, admitted Run after restart with current registry and source removed", async () => {
    const f = await setup(); await mkdir(path.join(f.root, "src"));
    const source = await readFile(fileURLToPath(new URL("../core/fixtures/input-workflow.mjs", import.meta.url)), "utf8");
    await writeFile(path.join(f.root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    await writeFile(path.join(f.root, "src/workflow.ts"), `${source.replace("return { before: before.output", "return { schemaVersion: 1, before: before.output")}\nexport { json as input, json as output, defineInputWorkflow };`);
    await writeFile(path.join(f.root, "src/prompt.md"), "Pinned prompt");
    await writeFile(path.join(f.root, "src/manifest.json"), JSON.stringify({ ...fixtures.weather, workflowId: "input-demo", workflowContractVersion: "input-demo-v1" }));
    await writeFile(path.join(f.root, "src/environment.json"), JSON.stringify({ schemaVersion: 1, variables: [] }));
    const reference = (name: string) => ({ file: "src/workflow.ts", export: name });
    await writeFile(path.join(f.root, "src/arkimux.workflows.ts"), `export const workflowDeclarations = ${JSON.stringify([{
      manifest: "src/manifest.json", environment: "src/environment.json", definition: reference("defineInputWorkflow"), inputValidator: reference("input"), resultValidator: reference("output"),
      result: { kind: "input-demo-result-v1", schemaVersion: 1 }, agentSlots: ["author"], effects: [], construction: { ...reference("createInputWorkflow"), assets: ["src/prompt.md"] },
    }])}; export function loadProjectWorkflows() { throw new Error("Do not load registry"); }`);
    const workflow = { kind: "input-demo", version: 1 };
    const configuration = { ...f.binding.runConfiguration, workflow, marker: "original-config" };
    const invocation = { ...f.binding.invocation, workflow, workflowContractVersion: "input-demo-v1", resultKind: "input-demo-result-v1",
      runConfiguration: { configurationId: "test-v1", contentHash: runConfigurationContentHash(configuration) } };
    await reserveDeclaredRetainedRun(f.store, { projectRoot: f.root, workerPath: f.workerPath,
      binding: { ...f.binding, workflow, invocation, runConfiguration: configuration } });
    let calls = 0;
    const runner = (store: FileRetainedExecutionStoreV1) => new LocalRetainedWorkflowRunnerV1({ store, projectRoot: f.root, workerPath: f.workerPath,
      prepareAgents: async (pinned, _signal, prompts) => {
        expect(pinned.runConfiguration).toMatchObject({ marker: "original-config" }); expect(prompts).toEqual({ author: "Pinned prompt" });
        return { bindings: { author: { providerId: "test", authProviderId: "connection-1", model: "fixed", configurationSha256: "a".repeat(64) } },
          invoke: async request => ({ output: request.operation.output.parse({ call: ++calls }) }), close: async () => {} };
      } });
    const limits = { totalMs: 60000, attemptMs: 30000, finalizationReserveMs: 1000 };
    expect((await runner(f.store).execute(f.ref, limits, f.binding.hostRequirements)).status).toBe("suspended");
    expect(calls).toBe(1);
    const request = Object.values((await f.store.read(f.ref))!.requests)[0].definition;
    await rm(path.join(f.root, "src"), { recursive: true });
    await f.store.close();
    const restarted = await FileRetainedExecutionStoreV1.open(path.join(f.root, "storage")); stores.push(restarted);
    await restarted.submit(f.ref, request.requestId, { submissionId: "answer", expectedRevision: 1,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "developer", async (_request, response) => response);
    expect(await runner(restarted).execute(f.ref, limits, f.binding.hostRequirements)).toMatchObject({ status: "completed", output: {
      before: { call: 1 }, after: { call: 2 }, originalInput: { count: 1 },
      construction: { config: "original-config", prompt: "Pinned prompt" },
    } });
    expect(calls).toBe(2);
  });
});
