import { afterEach, beforeAll, expect, it } from "vitest";
import { build as bundle } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalRetainedRuntime } from "../../local/src/localRetainedRuntime.ts";
import { LocalRetainedRunOrchestrator } from "../../local/src/localRetainedRunOrchestrator.ts";
import { resolveLocalExecutionDataPaths, resolveLocalFileStorePaths } from "../../local/src/localStorePaths.ts";
import { resolveLocalDurableExecutionPaths } from "../../local/src/localDurableWorkflowRuntime.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { runConfigurationContentHash } from "../../core/src/application/runConfiguration.ts";
import { FilePlaintextAgentCredentialStore } from "../../core/src/infrastructure/storage/fileAgentCredentialStore.ts";
import { FileAgentAuthProviderStore } from "../../core/src/infrastructure/storage/fileAgentAuthProviderStore.ts";

type Runtime = Awaited<ReturnType<typeof createLocalRetainedRuntime>>;
const roots: string[] = [], runtimes: Runtime[] = [];
let worker: Uint8Array;
beforeAll(async () => {
  worker = (await bundle({ entryPoints: ["local/src/retainedAttemptWorker.ts"], bundle: true,
    platform: "node", format: "esm", write: false, logLevel: "silent" })).outputFiles[0].contents;
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "headless-isolation-unit-")); roots.push(projectRoot);
  const executionDataRoot = path.join(projectRoot, ".arkimux/debug/session-1");
  const workerPath = path.join(projectRoot, "worker.mjs"); await writeFile(workerPath, worker);
  await mkdir(path.join(projectRoot, "config"));
  await copyFile("core/config/agent-providers.default.json", path.join(projectRoot, "config/agent-providers.default.json"));
  const open = async (isolated = true) => {
    const runtime = await createLocalRetainedRuntime({ projectRoot, workerPath, ...(isolated ? { executionDataRoot } : {}) });
    runtimes.push(runtime); return runtime;
  };
  return { projectRoot, executionDataRoot, workerPath, open };
}

async function admit(runtime: Runtime, root: string, input: { count: number; mode: string }, native = false) {
  const code = await readFile(native ? "test/core/fixtures/input-workflow.mjs" : "test/cli/fixtures/headless-workflow.mjs");
  const effectAdapters = native ? undefined : await readFile("test/cli/fixtures/headless-effect-adapter.mjs");
  const build = await runtime.store.publishBuild({ inputSha256: hashJson(code.toString()), entryPoint: "entry.mjs",
    files: { "entry.mjs": code, "assets/proof.txt": Buffer.from("retained asset"),
      "assets/src/prompt.md": Buffer.from("Retained prompt"),
      ...(effectAdapters ? { "effect-adapters.mjs": effectAdapters } : {}),
      "construction.json": Buffer.from(JSON.stringify(native
        ? { schemaVersion: 1, export: "createInputWorkflow" }
        : { schemaVersion: 2, export: "construct", effectAdapterEntryPoint: "effect-adapters.mjs",
            effectAdapters: ["createRecordFixtureAdapter"] })) },
    hostRequirements: runtime.hostRequirements });
  const runRef = { executionId: "shared-run-id" }, workflow = { kind: native ? "input-demo" : "headless-fixture", version: 1 };
  const actor = { userId: "fixture", roleId: "fixture" }, createdAt = new Date().toISOString();
  const configuration = { schemaVersion: 1, configurationId: "fixture-v1", workflow, marker: "original", agents: native ? {
    author: { timeoutMs: 5000, execution: { provider: "claude-code-cli", authProvider: "fixture-auth", parameters: { model: "fixture-model" } } },
  } : {} };
  const runConfiguration = { configurationId: configuration.configurationId, contentHash: runConfigurationContentHash(configuration) };
  const invocation = { schemaVersion: 1, runRef, workflow, workflowContractVersion: native ? "input-demo-v1" : "1",
    resultKind: native ? "input-demo-result-v1" : "headless-fixture.result", input, createdAt, runConfiguration };
  await runtime.runs.reserve({ actor, workflow, input, requestedExecutionId: runRef.executionId,
    resolvedConfiguration: { configuration, contentHash: runConfiguration.contentHash } }, {
    workflow, agentSlotIds: native ? ["author"] : [], prepareBinding: async () => ({
      id: runRef.executionId, buildSha256: build.buildSha256, workflow, invocation, runConfiguration: inputWaitJsonSnapshot(configuration),
      nonSecretEnvironment: { MARKER: "original", SETTING: "original", AUDIT_FILE: path.join(root, "calls.jsonl") },
      credentialReferences: native ? ["fixture-auth"] : [], hostRequirements: runtime.hostRequirements,
      executionProfile: { maxScratchBytes: 1048576, computeLimits: { totalMs: 30000, attemptMs: 15000, finalizationReserveMs: 1000 } },
      runManifest: { schemaVersion: 3, runRef, workflow, actor, createdAt, runConfiguration },
    }),
  });
  return runRef;
}

it("separates same-ID Runs, reservations, checkpoints and publications while the normal runtime stays open", async () => {
  const f = await fixture(), normal = await f.open(false), diagnostic = await f.open();
  const ref = await admit(normal, f.projectRoot, { count: 10, mode: "complete" });
  await admit(diagnostic, f.executionDataRoot, { count: 20, mode: "wait" });
  await normal.runs.execute(ref); await diagnostic.runs.execute(ref);
  expect((await normal.store.read(ref))?.status).toBe("complete");
  expect((await diagnostic.store.read(ref))?.status).toBe("waiting_for_input");
  const normalRoot = path.join(resolveLocalFileStorePaths(f.projectRoot).runs, ref.executionId);
  const diagnosticRoot = path.join(f.executionDataRoot, "runs", ref.executionId);
  expect(JSON.parse(await readFile(path.join(normalRoot, "headless-fixture.result.json"), "utf8")).payload.count).toBe(11);
  expect(await readdir(path.join(diagnosticRoot, "durable/steps"))).toContain("calculate.json");
  expect(await readdir(path.join(diagnosticRoot, "durable/scratch"))).toEqual([]);
  expect(await readFile(path.join(f.executionDataRoot, "calls.jsonl"), "utf8")).toContain('"count":20');
  await diagnostic.close();
  const reopened = await f.open(); await reopened.reconcile();
  const [request] = await reopened.runs.listInputRequests(ref);
  if (!(request && "definition" in request)) throw new Error("Expected workflow input request.");
  await reopened.runs.submitInput(ref, request.definition.requestId, { submissionId: "answer", expectedRevision: request.revision,
    response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "fixture");
  await reopened.runs.execute(ref);
  const result = JSON.parse(await readFile(path.join(diagnosticRoot, "headless-fixture.result.json"), "utf8"));
  expect(result.payload).toMatchObject({ count: 21, city: "ISTANBUL" });
  expect((await readFile(path.join(f.executionDataRoot, "calls.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(normalRoot, "headless-fixture.result.json"), "utf8")).payload.count).toBe(11);
  expect(await readdir(path.join(diagnosticRoot, "state"))).toContain("performance.json");
});

it("executes pure workflows without provider configuration, installed CLIs or credential storage", async () => {
  const f = await fixture(), normal = await f.open(false), diagnostic = await f.open();
  await rm(path.join(f.projectRoot, "config/agent-providers.default.json"));
  const ref = await admit(normal, f.projectRoot, { count: 4, mode: "complete" });
  await admit(diagnostic, f.executionDataRoot, { count: 8, mode: "complete" });
  await normal.runs.execute(ref); await diagnostic.runs.execute(ref);
  expect(await normal.store.read(ref)).toMatchObject({ status: "complete", owner: null, output: { count: 5 } });
  expect(await diagnostic.store.read(ref)).toMatchObject({ status: "complete", owner: null, output: { count: 9 } });
  await expect(readFile(path.join(f.projectRoot, "config/agent-providers.default.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(resolveLocalFileStorePaths(f.projectRoot).credentials)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reconciles pending Runs without executing code and repairs completed publication on reopen", async () => {
  const f = await fixture(), first = await f.open();
  const ref = await admit(first, f.executionDataRoot, { count: 30, mode: "complete" });
  await first.close();
  const second = await f.open(), reconciliation = second.reconcile();
  expect(second.reconcile()).toBe(reconciliation); await reconciliation;
  expect(await second.store.read(ref)).toMatchObject({ status: "running", fence: 0, owner: null });
  await expect(readFile(path.join(f.executionDataRoot, "calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  await second.runs.execute(ref); await second.close();
  const resultPath = path.join(f.executionDataRoot, "runs", ref.executionId, "headless-fixture.result.json");
  await rm(resultPath);
  const third = await f.open(); await third.reconcile();
  expect(JSON.parse(await readFile(resultPath, "utf8")).payload.count).toBe(31);
  expect((await readFile(path.join(f.executionDataRoot, "calls.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  expect(await third.store.read(ref)).toMatchObject({ status: "complete", fence: 1, owner: null });
  await third.close(); await expect(third.reconcile()).rejects.toThrow("closing");
  await expect(third.runs.reconcile()).rejects.toThrow("closed");
});

it("keeps current credentials in the project but provider scratch, artifacts and metrics in the diagnostic root", async () => {
  const f = await fixture(), projectPaths = resolveLocalFileStorePaths(f.projectRoot);
  const command = path.join(f.projectRoot, "fixture-provider.mjs");
  await writeFile(command, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({type:'result',result:JSON.stringify({
  credentialVersion:process.env.ANTHROPIC_API_KEY === 'synthetic-key-two' ? 'two' : 'one', cwd:process.cwd()
})})));`, { mode: 0o700 });
  await writeFile(path.join(f.projectRoot, "config/agent-providers.default.json"), JSON.stringify({ schemaVersion: 1,
    executionProviders: Object.fromEntries(["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"].map(id => [id,
      { command, heartbeatIntervalMs: 100, environmentAllowlist: ["PATH"], requiredVersion: "1.0.0" }])),
    authProviders: { fallback: { kind: "environment", sourceVariable: "SYNTHETIC_UNUSED_KEY", targetVariable: "ANTHROPIC_API_KEY" } } }));
  const credentials = new FilePlaintextAgentCredentialStore(projectPaths.credentials);
  await credentials.create({ schemaVersion: 1, credentialId: "fixture-key", displayName: "Fixture key", kind: "api-key", modelProvider: "anthropic" }, "synthetic-key-one");
  await new FileAgentAuthProviderStore(projectPaths.agentAuthProviders).create({ schemaVersion: 2, authProviderId: "fixture-auth",
    displayName: "Fixture", kind: "stored-credential", executionProviderId: "claude-code-cli", modelProvider: "anthropic",
    credentialId: "fixture-key", targetVariable: "ANTHROPIC_API_KEY" });
  const runtime = await f.open(), ref = await admit(runtime, f.executionDataRoot, { count: 1, mode: "wait" }, true);
  await runtime.runs.execute(ref);
  expect((await runtime.store.read(ref))?.status).toBe("waiting_for_input");
  await runtime.close(); await credentials.putValue("fixture-key", "synthetic-key-two");
  const next = await f.open(); await next.reconcile();
  const [request] = await next.runs.listInputRequests(ref);
  if (!(request && "definition" in request)) throw new Error("Expected workflow input request.");
  await next.runs.submitInput(ref, request.definition.requestId, { submissionId: "answer", expectedRevision: request.revision,
    response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "fixture");
  await next.runs.execute(ref);
  const runRoot = path.join(f.executionDataRoot, "runs", ref.executionId);
  const result = JSON.parse(await readFile(path.join(runRoot, "input-demo-result-v1.json"), "utf8"));
  expect(result.payload.before.credentialVersion).toBe("one"); expect(result.payload.after.credentialVersion).toBe("two");
  expect(result.payload.before.cwd).toContain(path.join(runRoot, "durable/scratch"));
  expect(await readdir(path.join(runRoot, "artifacts/agents/author"))).toHaveLength(2);
  expect(await readdir(path.join(runRoot, "durable/performance-agent-events"))).toHaveLength(2);
  await expect(readdir(projectPaths.runs)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(path.join(f.executionDataRoot, "credentials"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not dispatch a persisted resume intent during reconciliation", async () => {
  const f = await fixture(), first = await f.open();
  const ref = await admit(first, f.executionDataRoot, { count: 40, mode: "wait" });
  await first.runs.execute(ref);
  const [request] = await first.runs.listInputRequests(ref);
  if (!(request && "definition" in request)) throw new Error("Expected workflow input request.");
  await first.store.submit(ref, request.definition.requestId, { submissionId: "saved-answer", expectedRevision: request.revision,
    response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "fixture", async (_request, response) => response);
  await first.close();
  const second = await f.open(); await second.reconcile();
  expect(await second.store.read(ref)).toMatchObject({ status: "resume_queued", fence: 1, owner: null });
  await expect(readFile(path.join(f.executionDataRoot, "runs", ref.executionId, "headless-fixture.result.json")))
    .rejects.toMatchObject({ code: "ENOENT" });
  await second.runs.execute(ref);
  expect((await second.store.read(ref))?.status).toBe("complete");
  expect((await readFile(path.join(f.executionDataRoot, "calls.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});

it("preserves default paths and refuses different execution roots within one composition", async () => {
  const f = await fixture(), runtime = await f.open();
  expect(resolveLocalExecutionDataPaths(f.projectRoot).root).toBe(resolveLocalFileStorePaths(f.projectRoot).root);
  expect(resolveLocalDurableExecutionPaths(f.projectRoot, { executionId: "run" }, f.executionDataRoot).root)
    .toBe(path.join(f.executionDataRoot, "runs/run/durable"));
  expect(() => new LocalRetainedRunOrchestrator({ ...runtime.runs.options, executionDataRoot: path.join(f.projectRoot, "other") }))
    .toThrow("same project, execution data root and store");
  await expect(createLocalRetainedRuntime({ projectRoot: f.projectRoot, executionDataRoot: "relative" })).rejects.toThrow("absolute");
});
