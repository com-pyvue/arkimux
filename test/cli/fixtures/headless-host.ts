/** Test-only IPC driver, not an ArkiMux CLI/debugger contract. */
import "./headless-guards.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLocalRetainedRuntime } from "../../../local/src/localRetainedRuntime.ts";
import { hashJson } from "../../../core/src/application/durableWorkflow.ts";
import { runConfigurationContentHash } from "../../../core/src/application/runConfiguration.ts";
import { inputWaitJsonSnapshot } from "../../../core/src/application/inputWait.ts";
import type { ActiveComputeLimitsV1 } from "../../../core/src/application/activeCompute.ts";
import type { StoredInputSubmissionV1 } from "../../../core/src/application/retainedExecution.ts";

const send = (value: unknown) => { if (process.connected) process.send!(value); };
const fork = childProcess.fork;
childProcess.fork = ((...args: Parameters<typeof fork>) => {
  if (args[0] !== workerPath) throw new Error("Only the retained worker may fork in this proof");
  const child = fork(...args);
  send({ event: "worker-started", pid: child.pid });
  child.once("close", () => send({ event: "worker-closed", pid: child.pid }));
  return child;
}) as typeof fork;
syncBuiltinESMExports();
const [root, workerPath] = process.argv.slice(2);
const runtime = await createLocalRetainedRuntime({ projectRoot: root, workerPath });
const defaultLimits = { totalMs: 30000, attemptMs: 15000, finalizationReserveMs: 1000 };
type Message = { id: number; command: string; runId?: string; input?: unknown; limits?: ActiveComputeLimitsV1;
  requestId?: string; body?: StoredInputSubmissionV1 };

async function handle(message: Message): Promise<unknown> {
  const ref = { executionId: message.runId ?? "fixture-run" };
  switch (message.command) {
    case "admit": {
      const code = await readFile(path.join(root, "workflow.mjs"));
      const effectAdapters = await readFile(path.join(root, "effect-adapters.mjs"));
      const asset = await readFile(path.join(root, "proof.txt"));
      const build = await runtime.store.publishBuild({ inputSha256: hashJson({ code: code.toString(),
        effectAdapters: effectAdapters.toString(), asset: asset.toString() }), entryPoint: "entry.mjs",
        files: { "entry.mjs": code, "effect-adapters.mjs": effectAdapters, "assets/proof.txt": asset,
          "construction.json": Buffer.from(JSON.stringify({ schemaVersion: 2, export: "construct",
            effectAdapterEntryPoint: "effect-adapters.mjs", effectAdapters: ["createRecordFixtureAdapter"] })) }, hostRequirements: runtime.hostRequirements });
      const workflow = { kind: "headless-fixture", version: 1 }, actor = { userId: "fixture", roleId: "fixture" };
      const configuration = { schemaVersion: 1, configurationId: "fixture-v1", workflow, marker: "original", agents: {} };
      const runConfiguration = { configurationId: configuration.configurationId, contentHash: runConfigurationContentHash(configuration) };
      const createdAt = new Date().toISOString();
      const invocation = { schemaVersion: 1, runRef: ref, workflow, workflowContractVersion: "1", resultKind: "headless-fixture.result",
        input: inputWaitJsonSnapshot(message.input), runConfiguration, createdAt };
      return runtime.runs.reserve({ actor, workflow, input: message.input, requestedExecutionId: ref.executionId,
        resolvedConfiguration: { configuration, contentHash: runConfiguration.contentHash } }, {
        workflow, agentSlotIds: [], prepareBinding: async () => ({ id: ref.executionId, buildSha256: build.buildSha256, workflow, invocation,
          runConfiguration: configuration, credentialReferences: [], hostRequirements: runtime.hostRequirements,
          nonSecretEnvironment: { MARKER: "original", AUDIT_FILE: path.join(root, "calls.jsonl") },
          executionProfile: { maxScratchBytes: 1048576, computeLimits: message.limits ?? defaultLimits },
          runManifest: { schemaVersion: 3, runRef: ref, workflow, actor, createdAt, runConfiguration } }),
      });
    }
    case "execute": await runtime.runs.execute(ref); return runtime.store.read(ref);
    case "recover": await runtime.recover(); return true;
    case "read": return await runtime.store.read(ref) ?? null;
    case "requests": return runtime.runs.listInputRequests(ref);
    case "submit": return runtime.runs.submitInput(ref, message.requestId!, message.body!, "fixture");
    case "cancel": await runtime.store.cancel(ref); await runtime.runs.execute(ref); return runtime.store.read(ref);
    case "close": await runtime.close(); return true;
    default: throw new Error("Unknown test command");
  }
}
process.on("message", (message: Message) => {
  void handle(message).then(value => {
    send({ id: message.id, value });
    if (message.command === "close") process.disconnect();
  }, error => send({ id: message.id, error: { code: error.code, message: error.message, stack: error.stack } }));
});
process.on("disconnect", () => { void runtime.close(); });
send({ event: "ready", pid: process.pid });
