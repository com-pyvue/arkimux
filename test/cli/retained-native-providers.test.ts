import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { runConfigurationContentHash } from "../../core/src/application/runConfiguration.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { LocalRetainedWorkflowRunnerV1 } from "../../local/src/localRetainedWorkflowRunner.ts";
import { prepareLocalRetainedAgentProviders } from "../../local/src/localRetainedAgentProviders.ts";
import { reserveLocalRetainedRun } from "../../local/src/localRetainedRunAdmission.ts";
import { ClaudeCodeCliAgentRunner } from "../../core/src/infrastructure/agents/claudeCodeCliAgentRunner.ts";
import { AgentProcessCleanupError, AgentResourceCleanupError } from "../../core/src/infrastructure/agents/agentProcessLifetime.ts";
let workerBytes: Uint8Array;
const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
beforeAll(async () => { workerBytes = (await build({ entryPoints: [fileURLToPath(new URL("../../local/src/retainedAttemptWorker.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" })).outputFiles[0].contents; });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const limits = { totalMs: 30000, attemptMs: 15000, finalizationReserveMs: 1000 };
async function fixture(hang = false) {
  const root = await mkdtemp(path.join(tmpdir(), "retained-native-fixture-")); roots.push(root);
  vi.stubEnv("ARKIMUX_TEST_AUTH", "fixture-one"); vi.stubEnv("SETTING", "must-not-leak");
  const command = path.join(root, "claude.mjs"), workerPath = path.join(root, "worker.mjs");
  await writeFile(workerPath, workerBytes);
  await writeFile(command, `#!${process.execPath}
import {appendFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);
process.stdin.on('end',()=>{
 const value={prompt,model:process.argv[process.argv.indexOf('--model')+1],credentialVersion:process.env.ANTHROPIC_API_KEY==='fixture-two'?'two':'one',hasWorkflowSetting:process.env.SETTING!==undefined};
 appendFileSync(${JSON.stringify(path.join(root, "calls.jsonl"))},JSON.stringify(value)+'\\n');
 writeFileSync(${JSON.stringify(path.join(root, "pid"))},String(process.pid));
 ${hang ? "setInterval(()=>{},1000);" : "console.log(JSON.stringify({type:'result',result:JSON.stringify(value)}));"}
});`, { mode: 0o700 });
  await mkdir(path.join(root, "config"));
  await writeFile(path.join(root, "config/agent-providers.default.json"), JSON.stringify({ schemaVersion: 1,
    executionProviders: Object.fromEntries(["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"].map(id => [id, { command, heartbeatIntervalMs: 10, environmentAllowlist: ["PATH", "SETTING"], requiredVersion: "1.0.0" }])),
    authProviders: { "fixture-auth": { kind: "environment", sourceVariable: "ARKIMUX_TEST_AUTH", targetVariable: "ANTHROPIC_API_KEY" } } }));
  const storePath = path.join(root, "retained"), store = await FileRetainedExecutionStoreV1.open(storePath); stores.push(store);
  const code = (await readFile(new URL("../core/fixtures/input-workflow.mjs", import.meta.url), "utf8"));
  const manifest = await store.publishBuild({ inputSha256: hashJson(code), entryPoint: "entry.mjs", hostRequirements: { node: "22" }, files: {
    "entry.mjs": Buffer.from(code), "construction.json": Buffer.from(JSON.stringify({ schemaVersion: 1, export: "createInputWorkflow" })), "assets/src/prompt.md": Buffer.from("Original saved prompt"),
  } });
  const runRef = { executionId: "native-run" }, workflow = { kind: "input-demo", version: 1 };
  const runConfiguration = { schemaVersion: 1, configurationId: "saved-config-v1", workflow, marker: "original", agents: {
    author: { timeoutMs: 10000, execution: { provider: "claude-code-cli", authProvider: "fixture-auth", parameters: { model: "saved-model" } } },
  } };
  const invocation = { schemaVersion: 1, runRef, workflow, workflowContractVersion: "input-demo-v1", resultKind: "input-demo-result-v1", input: { initial: true },
    runConfiguration: { configurationId: runConfiguration.configurationId, contentHash: runConfigurationContentHash(runConfiguration) }, createdAt: new Date().toISOString() };
  const binding = { id: "binding-1", buildSha256: manifest.buildSha256, workflow, invocation, runConfiguration,
    executionProfile: { maxScratchBytes: 1048576, computeLimits: limits }, nonSecretEnvironment: { SETTING: "original" },
    credentialReferences: ["fixture-auth"], hostRequirements: { node: "22" } };
  const runner = (store: FileRetainedExecutionStoreV1) => new LocalRetainedWorkflowRunnerV1({ projectRoot: root, store, workerPath });
  return { root, store, storePath, binding, runRef, workerPath, runner };
}

it("uses the default native provider across suspension and restart without replaying completed calls", async () => {
  const f = await fixture();
  await reserveLocalRetainedRun(f.store, { runRef: f.runRef, binding: f.binding, agentSlotIds: ["author"], workerPath: f.workerPath });
  expect(await f.runner(f.store).execute(f.runRef, limits, f.binding.hostRequirements)).toMatchObject({ status: "suspended" });
  const current = (await f.store.read(f.runRef))!, request = Object.values(current.requests)[0];
  expect(current.owner).toBeNull();
  await f.store.submit(f.runRef, request.definition.requestId, { submissionId: "answer", expectedRevision: request.revision,
    response: { schemaVersion: 1, fields: { city: "London" }, files: {} } }, "developer", async (_request, response) => response);
  await f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  vi.stubEnv("ARKIMUX_TEST_AUTH", "fixture-two");
  await writeFile(path.join(f.root, ".env"), "SETTING=changed\n");
  // No current workflow registry/source is present: both attempts use the build.
  const reopened = await FileRetainedExecutionStoreV1.open(f.storePath); stores.push(reopened);
  expect(await f.runner(reopened).execute(f.runRef, limits, f.binding.hostRequirements)).toMatchObject({ status: "completed", output: {
    before: { model: "saved-model", credentialVersion: "one", hasWorkflowSetting: false },
    after: { model: "saved-model", credentialVersion: "two", hasWorkflowSetting: false },
    construction: { config: "original", prompt: "Original saved prompt" },
  } });
  const calls = (await readFile(path.join(f.root, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.prompt.startsWith("Original saved prompt"))).toBe(true);
  expect((await reopened.read(f.runRef))?.compute?.certainty).toBe("known");
});

it("cancels a real fixture provider before releasing retained attempt ownership", async () => {
  const f = await fixture(true);
  await reserveLocalRetainedRun(f.store, { runRef: f.runRef, binding: f.binding, agentSlotIds: ["author"], workerPath: f.workerPath });
  const controller = new AbortController();
  const execution = f.runner(f.store).execute(f.runRef, limits, f.binding.hostRequirements, controller.signal);
  await vi.waitFor(async () => expect(Number(await readFile(path.join(f.root, "pid"), "utf8"))).toBeGreaterThan(0), { timeout: 5000 });
  controller.abort(); await execution;
  const pid = Number(await readFile(path.join(f.root, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await f.store.read(f.runRef)).toMatchObject({ owner: null, compute: { certainty: "known", active: null } });
});

it("keeps provider metrics when its completed output fails validation", async () => {
  const f = await fixture();
  const scope = await prepareLocalRetainedAgentProviders({ projectRoot: f.root, binding: f.binding, signal: new AbortController().signal,
    prompts: { author: "original" }, owner: { attemptId: "attempt-1", fence: 1, pid: process.pid } });
  try {
    await expect(scope.invoke({ stableOperationId: "test", runRef: f.runRef, stepId: "test",
      operation: { schemaVersion: 1, operationId: "test", slotId: "author", output: { parse: () => { throw new Error("INVALID_OUTPUT"); } } },
      input: {}, deadlineAt: new Date(Date.now() + 5000).toISOString(), cancellation: { aborted: false } }))
      .rejects.toMatchObject({ metrics: { providerId: "claude-code-cli", status: "complete", model: "saved-model", elapsedMs: expect.any(Number) } });
  } finally { await scope.close(); }
});

it.each(["hash", "slots", "connection"])("rejects inconsistent %s before provider execution", async kind => {
  const f = await fixture();
  if (kind === "hash") f.binding.runConfiguration.marker = "changed";
  if (kind === "connection") f.binding.credentialReferences = [];
  await expect(prepareLocalRetainedAgentProviders({ projectRoot: f.root, binding: f.binding, signal: new AbortController().signal,
    prompts: kind === "slots" ? {} : { author: "original" }, owner: { attemptId: "attempt-1", fence: 1, pid: process.pid } })).rejects.toThrow();
  await expect(readFile(path.join(f.root, "calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["process-cleanup", "resource-cleanup", "inference"])("distinguishes %s failure from confirmed cleanup", async kind => {
  const f = await fixture();
  const scope = await prepareLocalRetainedAgentProviders({ projectRoot: f.root, binding: f.binding, signal: new AbortController().signal,
    prompts: { author: "original" }, owner: { attemptId: "attempt-1", fence: 1, pid: process.pid } });
  const failure = kind === "process-cleanup" ? new AgentProcessCleanupError("cleanup")
    : kind === "resource-cleanup" ? new AgentResourceCleanupError([], "cleanup") : new Error("inference");
  vi.spyOn(ClaudeCodeCliAgentRunner.prototype, "run").mockRejectedValueOnce(failure);
  await expect(scope.invoke({ stableOperationId: "test", runRef: f.runRef, stepId: "test",
    operation: { schemaVersion: 1, operationId: "test", slotId: "author", output: { parse: value => value as string } },
    input: {}, deadlineAt: new Date(Date.now() + 5000).toISOString(), cancellation: { aborted: false } })).rejects.toBe(failure);
  if (kind === "inference") await expect(scope.close()).resolves.toBeUndefined();
  else await expect(scope.close()).rejects.toBe(failure);
});
