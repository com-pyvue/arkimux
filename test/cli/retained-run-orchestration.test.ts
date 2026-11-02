import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build as bundle } from "esbuild";
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from "node:fs/promises";
import { Server as HttpServer } from "node:http";
import { Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalRetainedRuntime } from "../../local/src/localRetainedRuntime.ts";
import { LocalRetainedRunService } from "../../local/src/localRetainedRunService.ts";
import { RetainedInputError } from "../../local/src/localRetainedRunOrchestrator.ts";
import { InputFileUploadValidationError } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { InputControlConflict } from "../../core/src/application/retainedExecution.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { runConfigurationContentHash } from "../../core/src/application/runConfiguration.ts";
import type { FrameworkErrorObserver } from "../../core/src/application/frameworkErrors.ts";
import { LocalFrameworkDiagnostics } from "../../local/src/localFrameworkDiagnostics.ts";
import { createLocalFrameworkErrorReporter } from "../../local/src/localFrameworkErrorReporter.ts";

const roots: string[] = [], runtimes: Awaited<ReturnType<typeof createLocalRetainedRuntime>>[] = [];
let workerBytes: Uint8Array;
beforeAll(async () => {
  workerBytes = (await bundle({ entryPoints: ["local/src/retainedAttemptWorker.ts"],
    bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" })).outputFiles[0].contents;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(options: { execute?: string; onFrameworkError?: FrameworkErrorObserver } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "retained-orchestration-unit-")); roots.push(root);
  await mkdir(path.join(root, "config"));
  await copyFile("core/config/agent-providers.default.json", path.join(root, "config/agent-providers.default.json"));
  const workerPath = path.join(root, "worker.mjs"); await writeFile(workerPath, workerBytes);
  const runtime = await createLocalRetainedRuntime({ projectRoot: root, workerPath, onFrameworkError: options.onFrameworkError }); runtimes.push(runtime);
  const code = `
export const input = { parse(v) { if (!Number.isInteger(v.count)) throw new Error("invalid"); return {count: v.count + 1}; } };
export function construct() { return { agentPrompts: {}, workflow: {
  workflow: {kind: "counter", version: 1}, workflowContractVersion: "1", resultKind: "counter.result",
  input, output: {parse: v => v}, execute: ${options.execute ?? "async (_c, value) => ({schemaVersion: 1, count: value.count})"}
} }; }
`;
  const build = await runtime.store.publishBuild({ inputSha256: hashJson(code), entryPoint: "entry.mjs",
    files: { "entry.mjs": Buffer.from(code), "construction.json": Buffer.from(JSON.stringify({ schemaVersion: 1, export: "construct" })) },
    hostRequirements: runtime.hostRequirements });
  const runRef = { executionId: "counter-run" }, workflow = { kind: "counter", version: 1 };
  const configuration = { schemaVersion: 1, configurationId: "counter-v1", workflow, agents: {} };
  const runConfiguration = { configurationId: configuration.configurationId, contentHash: runConfigurationContentHash(configuration) };
  const actor = { userId: "developer", roleId: "runner" }, createdAt = new Date().toISOString();
  const invocation = { schemaVersion: 1, runRef, workflow, workflowContractVersion: "1", resultKind: "counter.result",
    input: { count: 10 }, runConfiguration, createdAt };
  const binding = { id: "counter-binding", buildSha256: build.buildSha256, workflow, invocation,
    runConfiguration: configuration, nonSecretEnvironment: {}, credentialReferences: [], hostRequirements: runtime.hostRequirements,
    executionProfile: { maxScratchBytes: 1048576, computeLimits: { totalMs: 60000, attemptMs: 30000, finalizationReserveMs: 1000 } },
    runManifest: { schemaVersion: 3 as const, runRef, workflow, actor, createdAt, runConfiguration } };
  const request = { actor, workflow, input: invocation.input, requestedExecutionId: runRef.executionId,
    resolvedConfiguration: { configuration, contentHash: runConfiguration.contentHash } };
  const admission = { workflow, agentSlotIds: [], prepareBinding: async () => binding };
  return { root, runtime, runRef, binding, request, admission, workerPath };
}

describe("transport-independent retained Run orchestration", () => {
  it("has no transitive API, server or UI dependency", async () => {
    const result = await bundle({ entryPoints: ["local/src/localRetainedRuntime.ts"], bundle: true,
      platform: "node", format: "esm", write: false, metafile: true, logLevel: "silent" });
    const files = Object.keys(result.metafile.inputs);
    expect(files).toContain("local/src/localRetainedExecutionHost.ts");
    expect(files).toContain("local/src/localRetainedWorkflowRunner.ts");
    expect(files.filter(file => file.startsWith("apps/") || file.startsWith("ui/")
      || /(?:developmentServer|localRetainedServerRuntime|localRetainedRunService)\.ts$/.test(file)
      || file.includes("node_modules/hono/") || file.includes("node_modules/@hono/"))).toEqual([]);
  });

  it("admits, dispatches and publishes through the shared runtime without an HTTP listener", async () => {
    const http = vi.spyOn(HttpServer.prototype, "listen").mockImplementation(() => { throw new Error("HTTP forbidden"); });
    const https = vi.spyOn(HttpsServer.prototype, "listen").mockImplementation(() => { throw new Error("HTTPS forbidden"); });
    const f = await setup();
    expect(await f.runtime.runs.reserve(f.request, f.admission)).toEqual(f.runRef);
    await f.runtime.runs.dispatch({ runRef: f.runRef, actor: f.request.actor, workflow: f.request.workflow,
      input: f.request.input, runConfiguration: f.binding.runManifest.runConfiguration });
    expect((await f.runtime.store.read(f.runRef))?.status).toBe("complete");
    const result = JSON.parse(await readFile(path.join(f.root, ".arkimux/local/runs/counter-run/counter.result.json"), "utf8"));
    expect(result).toEqual({ envelopeSchemaVersion: 1, resultKind: "counter.result", runRef: f.runRef,
      payload: { schemaVersion: 1, count: 11 } });
    expect(await f.runtime.runs.listInputRequests(f.runRef)).toEqual([]);
    expect(await f.runtime.retainedRunIds()).toEqual(new Set(["counter-run"]));
    await f.runtime.close();
    expect(http).not.toHaveBeenCalled(); expect(https).not.toHaveBeenCalled();
  });

  it.each(["new Error('workflow detail', { cause: new Error('original cause') })", "'primitive workflow detail'"])("retains the original worker rejection once: %s", async thrown => {
    const root = await mkdtemp(path.join(tmpdir(), "retained-worker-diagnostic-")); roots.push(root);
    const diagnostics = new LocalFrameworkDiagnostics({ projectRoot: root });
    const reporter = createLocalFrameworkErrorReporter({ diagnostics, version: "0.1.0" });
    const f = await setup({ execute: `async () => { throw ${thrown}; }`, onFrameworkError: reporter.report });
    await f.runtime.runs.reserve(f.request, f.admission);
    await f.runtime.runs.dispatch({ runRef: f.runRef, actor: f.request.actor, workflow: f.request.workflow,
      input: f.request.input, runConfiguration: f.binding.runManifest.runConfiguration });
    const records = await diagnostics.list();
    expect(records).toHaveLength(1);
    const record = await diagnostics.get(records[0]!.diagnosticId);
    expect(record?.error.message).toContain("workflow detail");
    if (thrown.startsWith("new Error")) expect(record?.error.cause?.message).toBe("original cause");
  });

  it("keeps lifecycle ownership in ArkiMux and releases storage on idempotent close", async () => {
    const f = await setup();
    const firstRecovery = f.runtime.recover(); expect(f.runtime.recover()).toBe(firstRecovery); await firstRecovery;
    const closing = f.runtime.close(); expect(f.runtime.close()).toBe(closing); await closing;
    await expect(f.runtime.recover()).rejects.toThrow("closing");
    await expect(f.runtime.runs.reserve(f.request, f.admission)).rejects.toThrow("closed");
    const reopened = await createLocalRetainedRuntime({ projectRoot: f.root, workerPath: f.workerPath }); runtimes.push(reopened);
    expect(await reopened.retainedRunIds()).toEqual(new Set());
  });

  it("rejects a mismatched request or dispatch without changing the admitted Run", async () => {
    const f = await setup();
    await expect(f.runtime.runs.reserve({ ...f.request, actor: { ...f.request.actor, userId: "other" } }, f.admission)).rejects.toThrow("authorized Run request");
    expect(await f.runtime.store.read(f.runRef)).toBeUndefined();
    await f.runtime.runs.reserve(f.request, f.admission);
    await expect(f.runtime.runs.dispatch({ runRef: f.runRef, actor: f.request.actor, workflow: f.request.workflow,
      input: { count: 99 }, runConfiguration: f.binding.runManifest.runConfiguration })).rejects.toThrow("admitted Run");
    expect((await f.runtime.store.read(f.runRef))?.owner).toBeNull();
  });

  it("returns domain errors headlessly and maps them only in the API adapter", async () => {
    const f = await setup(), app = f.runtime.runs;
    const api = new LocalRetainedRunService(app.options, app);
    expect(api.application).toBe(app);
    const body = { submissionId: "answer", expectedRevision: 1, response: { schemaVersion: 1, fields: {}, files: {} } };
    await expect(app.submitInput(f.runRef, "missing", body, "developer")).rejects.toBeInstanceOf(InputControlConflict);
    await expect(api.inputRequests.submit(f.runRef, "missing", body, "developer")).rejects.toMatchObject({ status: 404, code: "not-found" });
    const submit = vi.spyOn(app, "submitInput");
    for (const [code, status] of [["invalid-response", 422], ["validation-unavailable", 503], ["input-unavailable", 503]] as const) {
      submit.mockRejectedValue(new RetainedInputError(code, "Safe message", code === "invalid-response" ? [{ field: "city", message: "Required" }] : undefined));
      await expect(api.inputRequests.submit(f.runRef, "missing", body, "developer")).rejects.toMatchObject({ status, code, message: "Safe message" });
    }
    submit.mockRejectedValue(new InputControlConflict("stale-revision"));
    await expect(api.inputRequests.submit(f.runRef, "missing", body, "developer")).rejects.toMatchObject({ status: 409, code: "conflict" });
    submit.mockResolvedValue({} as never);
    await expect(api.inputRequests.submit(f.runRef, "missing", body, "developer")).rejects.toMatchObject({ status: 503, code: "input-unavailable" });
    const upload = vi.spyOn(app, "uploadInputFile"), uploadBody = { fieldId: "documents", uploadId: "upload-1",
      filename: "note.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) };
    upload.mockRejectedValue(new InputFileUploadValidationError("unsupported-media-type", "documents", "Unsupported"));
    await expect(api.inputRequests.upload(f.runRef, "missing", uploadBody)).rejects.toMatchObject({ status: 415, code: "unsupported-media-type" });
    upload.mockRejectedValue(new InputControlConflict("upload-reused"));
    await expect(api.inputRequests.upload(f.runRef, "missing", uploadBody)).rejects.toMatchObject({ status: 409, details: { reason: "upload-reused" } });
    expect(await api.inputRequests.list(f.runRef)).toEqual({ schemaVersion: 1, runRef: f.runRef, items: [] });
  });
});
