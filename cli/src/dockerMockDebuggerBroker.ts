import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { headlessDebuggerErrorCodes, HeadlessDebuggerError } from "../../local/src/headlessDebuggerContracts.ts";
import { createHeadlessWorkerDebugger } from "../../local/src/headlessWorkerDebugger.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { inputFormDigestV1, inputWaitJsonSnapshot, parseInputWaitDurationV1,
  validateInputFormDescriptorV1, validateInputResponseShapeV1 } from "../../core/src/application/inputWait.ts";
import {
  dockerMockDebuggerAssetByteLimit,
  dockerMockDebuggerBootstrapByteLimit,
  dockerMockDebuggerBridgeMessageByteLimit,
  dockerMockDebuggerRetainedCodeByteLimit,
  parseDockerMockDebuggerBootstrap,
  parseDockerMockDebuggerBridgeRequest,
  type DockerMockDebuggerBridgeParams,
  type DockerMockDebuggerJson as Json,
} from "./dockerMockDebuggerBridgeContracts.ts";
import { dockerMockDebuggerCaseResult, type DockerMockDebuggerCaseResult,
  type DockerMockDebuggerWorkerOutcome } from "./dockerMockDebuggerTerminal.ts";
import mockWorkerExecArgv from "./dockerMockDebuggerWorkerSecurity.json" with { type: "json" };

const inputRoot = "/work/input";
const scratchRoot = "/work/scratch";
// Mock debugging has no workflow or session deadline. This distant date only
// satisfies the shared engine's required deadline-shaped context; Docker
// resource limits and bounded control acknowledgements remain enforced.
const mockDebugDeadlineAt = "9999-12-31T23:59:59.999Z";
const workerPath = "/opt/arkimux/retained-attempt-worker.mjs";
const publicErrorCodes = new Set<string>(headlessDebuggerErrorCodes);

async function boundedFile(name: "bootstrap.json" | "entry.mjs", limit: number): Promise<string> {
  const file = path.join(inputRoot, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw new Error("Mock debug retained input is invalid.");
  return await readFile(file, "utf8");
}

async function retainedAssets(definition: ReturnType<typeof parseDockerMockDebuggerBootstrap>): Promise<Record<string, Uint8Array>> {
  const assets: Record<string, Uint8Array> = {};
  for (const descriptor of definition.assets) {
    const file = path.join(inputRoot, "assets", descriptor.path);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== descriptor.byteLength
      || info.size > dockerMockDebuggerAssetByteLimit) throw new Error("Mock debug retained asset is invalid.");
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
      throw new Error("Mock debug retained asset digest does not match.");
    }
    assets[descriptor.path] = bytes;
  }
  return assets;
}

const delay = async (milliseconds = 0) => {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 60_000) throw new Error("Mock delay is invalid.");
  if (milliseconds > 0) await new Promise(resolve => setTimeout(resolve, milliseconds));
};

function sendReply(child: ChildProcess, id: unknown, ok: boolean, value?: unknown) {
  if (!child.connected || typeof id !== "number") return;
  child.send(ok ? { kind: "reply", id, ok: true, value } : { kind: "reply", id, ok: false }, () => {});
}

function sendMockFailure(child: ChildProcess, id: unknown, operationId: string,
  failure?: { code: string; message: string }) {
  if (!child.connected || typeof id !== "number") return;
  const error = failure ?? { code: "unsupported_mock_dependency",
    message: `No declared mock exists for operation ${operationId}.` };
  child.send({ kind: "reply", id, ok: false, retryability: "not-retryable",
    externalDiagnostic: { origin: "external", provider: "arkimux-mock", code: error.code, message: error.message } }, () => {});
}

async function writeBridgeMessage(value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > dockerMockDebuggerBridgeMessageByteLimit) throw new Error("Mock debug bridge response is too large.");
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(encoded + "\n", error => error ? reject(error) : resolve());
  });
}

type MockBridgeRuntime = {
  controller(): Awaited<ReturnType<typeof createHeadlessWorkerDebugger>>;
  inspect(): Record<string, unknown>;
  respond(params: DockerMockDebuggerBridgeParams<"case.respond">): Promise<unknown>;
  close(): Promise<void>;
};

async function serveBridge(
  runtime: MockBridgeRuntime,
  ready: Record<string, unknown>,
): Promise<void> {
  await writeBridgeMessage({ schemaVersion: 1, event: "bridge.ready", sessionId: ready.caseId, result: ready });
  await new Promise<void>((resolve, reject) => {
    let partial = Buffer.alloc(0), settled = false;
    let requests = Promise.resolve();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      void requests.finally(() => error ? reject(error) : resolve());
    };
    const reply = async (id: string | null, ok: boolean, result?: unknown, error?: { code: string; message: string; retry: string }) => {
      await writeBridgeMessage(ok
        ? { schemaVersion: 1, id, ok: true, result }
        : { schemaVersion: 1, id, ok: false, error: error ?? {
          code: "invalid_request", message: "The mock debug bridge request is invalid.", retry: "never",
        } });
    };
    const processLine = (line: Buffer) => {
      requests = requests.then(async () => {
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
        catch { await reply(null, false); return; }
        let request;
        try { request = parseDockerMockDebuggerBridgeRequest(value); }
        catch {
          const id = value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).id === "string"
            ? String((value as Record<string, unknown>).id).slice(0, 200) : null;
          await reply(id, false); return;
        }
        try {
          if (request.method === "session.inspect" || request.method === "debug.inspect") {
            await reply(request.id, true, runtime.inspect()); return;
          }
          if (request.method === "case.respond") {
            await reply(request.id, true, await runtime.respond(request.params)); return;
          }
          if (request.method === "debug.sources") {
            const controller = runtime.controller();
            await reply(request.id, true, controller.sources.list(request.params.offset, request.params.limit)); return;
          }
          if (request.method === "debug.source.read") {
            const controller = runtime.controller();
            await reply(request.id, true, controller.sources.read(request.params.sourceId, request.params.offset, request.params.limit)); return;
          }
          if (request.method === "debug.breakpoints.set") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.replaceBreakpoints(request.params.breakpoints)); return;
          }
          if (request.method === "debug.pause") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.pause(request.params.attemptId)); return;
          }
          if (request.method === "debug.continue") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.continue(request.params.pauseId)); return;
          }
          if (request.method === "debug.step") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.step(request.params.pauseId, request.params.kind)); return;
          }
          if (request.method === "debug.stack") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.stack(request.params.pauseId, request.params.offset, request.params.limit)); return;
          }
          if (request.method === "debug.scopes") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.scopes(request.params.pauseId, request.params.frameId)); return;
          }
          if (request.method === "debug.properties") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.properties(request.params.pauseId, request.params.objectId,
              request.params.offset, request.params.limit)); return;
          }
          if (request.method === "debug.evaluate") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.evaluate(request.params.pauseId, request.params.frameId,
              request.params.evaluationId, request.params.expression)); return;
          }
          if (request.method === "debug.variable.set") {
            const controller = runtime.controller();
            await reply(request.id, true, await controller.setVariable(request.params.pauseId, request.params.frameId,
              request.params.controlId, request.params.name, request.params.expression)); return;
          }
          await runtime.close(); await reply(request.id, true, { closed: true });
          finish();
        } catch (error) {
          const item = error && typeof error === "object" ? error as Record<string, unknown> : {};
          const safe = typeof item.code === "string" && publicErrorCodes.has(item.code)
            && typeof item.message === "string" && Buffer.byteLength(item.message) <= 4096
            && typeof item.retry === "string" && ["never", "after_action", "same_identity"].includes(item.retry)
            ? { code: item.code, message: item.message, retry: item.retry }
            : { code: "debugger_unavailable", message: "The mock workflow debugger is unavailable.", retry: "after_action" };
          await reply(request.id, false, undefined, safe);
        }
      }).catch(error => finish(error instanceof Error ? error : new Error("Mock debug bridge failed.")));
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length && !settled) {
        const newline = bytes.indexOf(10, offset);
        const end = newline === -1 ? bytes.length : newline;
        if (partial.length + end - offset > dockerMockDebuggerBridgeMessageByteLimit) {
          void reply(null, false).finally(() => finish()); return;
        }
        partial = Buffer.concat([partial, bytes.subarray(offset, end)]);
        if (newline === -1) return;
        processLine(partial); partial = Buffer.alloc(0); offset = newline + 1;
      }
    };
    const onEnd = () => { if (partial.length > 0) processLine(partial); finish(); };
    const onError = () => finish(new Error("Mock debug bridge input failed."));
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
    if (process.stdin.readableEnded) onEnd();
  });
}

async function main() {
  const definition = parseDockerMockDebuggerBootstrap(JSON.parse(await boundedFile("bootstrap.json", dockerMockDebuggerBootstrapByteLimit)));
  const retainedCode = await boundedFile("entry.mjs", dockerMockDebuggerRetainedCodeByteLimit);
  const assets = await retainedAssets(definition);
  const attemptId = `mock-${definition.caseId}`;
  const runRef = definition.invocation.runRef as Record<string, Json>;
  const now = new Date();
  const mockControl: any = {
    schemaVersion: 1,
    runRef,
    binding: {
      id: `binding-${definition.caseId}`,
      buildSha256: definition.buildSha256,
      workflow: definition.invocation.workflow,
      invocation: definition.invocation,
      runConfiguration: definition.runConfiguration,
      executionProfile: { maxScratchBytes: 32 * 1024 * 1024 },
      nonSecretEnvironment: {},
      credentialReferences: [],
      hostRequirements: { node: "24" },
    },
    revision: 1,
    fence: 1,
    status: "running",
    owner: null,
    requests: {},
    receipts: {},
    commands: {},
    updatedAt: now.toISOString(),
    retainedDataDeleted: false,
  };
  let child: ChildProcess | undefined;
  let stopped: Promise<void> | undefined;
  let workerOutcome: DockerMockDebuggerWorkerOutcome | null = null;
  let lastWorkerCall = "none";
  let controller: Awaited<ReturnType<typeof createHeadlessWorkerDebugger>> | undefined;
  const currentSuspension = () => {
    if (workerOutcome?.kind !== "result" || !workerOutcome.result || typeof workerOutcome.result !== "object"
      || Array.isArray(workerOutcome.result) || (workerOutcome.result as Record<string, unknown>).status !== "suspended") return null;
    const request = (workerOutcome.result as Record<string, unknown>).request;
    return request && typeof request === "object" && !Array.isArray(request) ? request as Record<string, unknown> : null;
  };
  const stopWorker = async () => {
    const activeChild = child, activeController = controller, activeStopped = stopped;
    child = undefined; controller = undefined; stopped = undefined;
    activeChild?.kill("SIGKILL"); await activeStopped; await activeController?.close();
  };
  const prepareGraphInput = async () => {
    if (!definition.graph) return undefined;
    const request = definition.graph.request && typeof definition.graph.request === "object" && !Array.isArray(definition.graph.request)
      && (definition.graph.request as Record<string, unknown>).schemaVersion === 1
      && ["supplied", "deferred"].includes(String((definition.graph.request as Record<string, unknown>).acquisition))
      ? definition.graph.request
      : { schemaVersion: 1, acquisition: "supplied", entry: { kind: "default" }, values: { entry: definition.graph.request } };
    const validator = fork(workerPath, [], { execArgv: mockWorkerExecArgv, stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced", env: { LANG: "C.UTF-8", TZ: "UTC" } });
    const exited = new Promise<void>(resolve => validator.once("close", () => resolve()));
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Mock graph input preparation timed out.")), 10_000);
        const fail = () => { clearTimeout(timer); reject(new Error("Mock graph input could not be prepared.")); };
        validator.once("error", fail);
        validator.on("message", message => {
          const item = message as Record<string, unknown>;
          if (item.kind === "graph-invocation-valid") { clearTimeout(timer); resolve(item.graphInput); }
          else if (item.kind === "construction-invalid") fail();
        });
        validator.send({ kind: "prepare-graph-invocation", code: retainedCode, construction: definition.construction,
          runConfiguration: definition.runConfiguration, assets, request, identity: definition.graph!.identity,
          agentSlotIds: definition.graph!.agentSlotIds }, error => { if (error) fail(); });
      });
    } finally { validator.kill("SIGKILL"); await exited; }
  };
  const validateResponse = async (requestId: string, response: DockerMockDebuggerBridgeParams<"case.respond">["response"]) => {
    const directory = path.join(scratchRoot, "storage", "steps");
    let files: string[] = [];
    try { files = (await readdir(directory)).filter(file => file.endsWith(".json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (files.length > 1000) {
      throw new HeadlessDebuggerError("state_uncertain", "Mock checkpoint validation could not be confirmed.", "after_action");
    }
    const checkpoints: unknown[] = [];
    for (const file of files) {
      const checkpointFile = path.join(directory, file), info = await lstat(checkpointFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024 * 1024) {
        throw new HeadlessDebuggerError("state_uncertain", "Mock checkpoint validation could not be confirmed.", "after_action");
      }
      let record: any;
      try { record = JSON.parse(await readFile(checkpointFile, "utf8")); }
      catch {
        throw new HeadlessDebuggerError("state_uncertain", "Mock checkpoint validation could not be confirmed.", "after_action");
      }
      if (record?.state === "COMPLETED" && record.completed) checkpoints.push(record.completed);
    }
    const validator = fork(workerPath, [], { execArgv: mockWorkerExecArgv, stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced", env: { LANG: "C.UTF-8", TZ: "UTC" } });
    const exited = new Promise<void>(resolve => validator.once("close", () => resolve()));
    try {
      return await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new HeadlessDebuggerError("state_uncertain", "Mock input validation timed out.", "after_action")), 5_000);
        validator.once("error", () => { clearTimeout(timer); reject(new HeadlessDebuggerError("state_uncertain", "Mock input validation could not start.", "after_action")); });
        validator.on("message", message => {
          const item = message as Record<string, unknown>;
          if (item.kind === "response-valid") { clearTimeout(timer); resolve(item.response); }
          else if (item.kind === "response-invalid") { clearTimeout(timer); reject(new HeadlessDebuggerError(
            item.code === "invalid-response" ? "invalid_response" : "state_uncertain",
            item.code === "invalid-response" ? "The mock input form rejected this answer." : "Mock input validation could not be confirmed.",
            item.code === "invalid-response" ? "same_identity" : "after_action")); }
        });
        validator.send({ kind: "validate-response", code: retainedCode, construction: definition.construction,
          environment: {}, runConfiguration: definition.runConfiguration, assets, invocation: definition.invocation,
          requests: mockControl.requests, buildSha256: definition.buildSha256, checkpoints, requestId, response,
          validationDeadlineAt: new Date(Date.now() + 5_000).toISOString(), finalizationReserveMs: 1_000 }, error => {
            if (error) { clearTimeout(timer); reject(new HeadlessDebuggerError("state_uncertain", "Mock input validation could not start.", "after_action")); }
          });
      });
    } finally { validator.kill("SIGKILL"); await exited; }
  };
  const openRequest = (options: any) => {
    const form = validateInputFormDescriptorV1(options.form), duration = parseInputWaitDurationV1(options.expiresAfter);
    const fixed = { ...options, form }, optionsSha256 = hashJson(inputWaitJsonSnapshot(fixed));
    const requestId = `request-${hashJson({ runRef, stepId: fixed.stepId })}`;
    const existing = mockControl.requests[requestId];
    if (existing) {
      if (existing.optionsSha256 !== optionsSha256) throw new Error("Mock input request changed during replay.");
      return existing.definition;
    }
    if (Object.values(mockControl.requests).some((item: any) => item.status === "pending")) throw new Error("Another mock input request is pending.");
    const createdAt = new Date().toISOString();
    const request = { schemaVersion: 1, requestId, stepId: fixed.stepId, title: fixed.title, form,
      formSha256: inputFormDigestV1(form), executableBindingId: mockControl.binding.id, createdAt,
      expiresAt: new Date(Date.parse(createdAt) + duration).toISOString() };
    mockControl.requests[requestId] = { definition: request, optionsSha256, status: "pending", revision: 1, updatedAt: createdAt };
    mockControl.status = "waiting_for_input"; mockControl.revision++; mockControl.updatedAt = createdAt;
    return request;
  };
  const completeInput = (requestId: string) => {
    const request = mockControl.requests[requestId];
    if (request?.status !== "submitted") throw new Error("Mock input request is not submitted.");
    const receipt = mockControl.receipts[request.submissionId], command = mockControl.commands[receipt.resumeCommandId];
    if (!command || command.state !== "claimed") throw new Error("Mock resume command is not owned.");
    command.state = "done"; delete command.owner; mockControl.revision++; mockControl.updatedAt = new Date().toISOString();
    return request.response;
  };
  const launchWorker = async () => {
    workerOutcome = null; lastWorkerCall = "none";
    const currentChild = fork(workerPath, [], { execArgv: mockWorkerExecArgv, stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced", env: { LANG: "C.UTF-8", TZ: "UTC" } });
    child = currentChild; stopped = new Promise<void>(resolve => currentChild.once("close", () => resolve()));
    const owner = { attemptId, fence: 1, pid: currentChild.pid! };
    mockControl.owner = owner;
    for (const command of Object.values(mockControl.commands) as any[]) if (command.state !== "done") { command.state = "claimed"; command.owner = owner; }
    currentChild.on("message", message => {
      const event = message as Record<string, unknown>;
      if (event.kind === "result") workerOutcome = { kind: "result", result: event.result };
      else if (event.kind === "error") workerOutcome = { kind: "error", externalDiagnostic: event.externalDiagnostic };
    });
    currentChild.once("exit", () => { workerOutcome ??= { kind: "exit" }; });
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Mock worker Inspector did not start.")), 5_000);
      const onMessage = (message: unknown) => {
        const event = message as Record<string, unknown>;
        if (event.kind === "debug-endpoint" && typeof event.endpoint === "string") {
          clearTimeout(timer); currentChild.off("message", onMessage); resolve(event.endpoint);
        }
      };
      currentChild.on("message", onMessage);
      currentChild.once("exit", () => { clearTimeout(timer); reject(new Error("Mock worker exited before Inspector setup.")); });
      currentChild.send({ kind: "debug-connect" }, error => { if (error) { clearTimeout(timer); reject(new Error("Mock worker Inspector handshake failed.")); } });
    });
    const currentController = await createHeadlessWorkerDebugger({
      endpoint,
      workerScriptUrl: pathToFileURL(workerPath).href,
      retainedCode,
      buildSha256: definition.buildSha256,
      attemptId,
      stopOnEntry: true,
      onDisconnect: () => currentChild.kill("SIGKILL"),
    });
    controller = currentController;
    currentChild.on("message", message => {
      const event = message as Record<string, unknown>;
      if (event.kind !== "call") return;
      if (typeof event.method === "string") lastWorkerCall = event.method;
      if (event.method === "input.read") sendReply(currentChild, event.id, true, mockControl);
      else if (event.method === "input.open") {
        try { sendReply(currentChild, event.id, true, openRequest(Array.isArray(event.args) ? event.args[0] : undefined)); }
        catch { sendReply(currentChild, event.id, false); }
      } else if (event.method === "input.complete") {
        try { sendReply(currentChild, event.id, true, completeInput(String(Array.isArray(event.args) ? event.args[0] : ""))); }
        catch { sendReply(currentChild, event.id, false); }
      }
      else if (event.method === "agents.prepare") {
        const prompts = Array.isArray(event.args) ? event.args[0] : undefined;
        const bindings = prompts && typeof prompts === "object" && !Array.isArray(prompts)
          ? Object.fromEntries(Object.keys(prompts).map(slotId => [slotId, { providerId: "mock", authProviderId: "mock", model: "mock", configurationSha256: "0".repeat(64) }]))
          : {};
        sendReply(currentChild, event.id, true, bindings);
      } else if (event.method === "heartbeat") sendReply(currentChild, event.id, true, null);
      else if (event.method === "agent.invoke") {
        const request = Array.isArray(event.args) ? event.args[0] as Record<string, unknown> : undefined;
        const operation = request?.operation && typeof request.operation === "object" && !Array.isArray(request.operation)
          ? request.operation as Record<string, unknown> : undefined;
        const operationId = typeof operation?.operationId === "string" ? operation.operationId : "";
        const fixture = Object.hasOwn(definition.mocks, operationId) ? definition.mocks[operationId] : undefined;
        void (async () => {
          if (!fixture) { sendMockFailure(currentChild, event.id, operationId); return; }
          await delay(fixture.delayMs);
          if (fixture.kind === "error") sendMockFailure(currentChild, event.id, operationId, fixture.error);
          else sendReply(currentChild, event.id, true, { output: fixture.value });
        })();
      } else if (event.method === "effect.invoke") {
        const request = Array.isArray(event.args) ? event.args[0] as Record<string, unknown> : undefined;
        const operationId = typeof request?.operationId === "string" ? request.operationId : "";
        const fixture = Object.hasOwn(definition.mocks, operationId) ? definition.mocks[operationId] : undefined;
        void (async () => {
          if (!fixture) { sendMockFailure(currentChild, event.id, operationId); return; }
          await delay(fixture.delayMs);
          if (fixture.kind === "error") sendMockFailure(currentChild, event.id, operationId, fixture.error);
          else sendReply(currentChild, event.id, true, request?.phase === "reconcile"
            ? { outcome: "completed", output: fixture.value }
            : fixture.value);
        })();
      } else sendReply(currentChild, event.id, false);
    });
    currentChild.send({
      kind: "start",
      ...(graphInput ? { executionKind: "graph", graphInput } : { executionKind: "workflow", invocation: definition.invocation }),
      code: `${retainedCode}\n//# sourceURL=arkimux-retained://${definition.buildSha256}/entry.mjs\n`,
      storageRoot: path.join(scratchRoot, "storage"),
      owner,
      construction: definition.construction,
      runConfiguration: definition.runConfiguration,
      assets,
      debug: { mock: true, activityPath: path.join(scratchRoot, "activity.json") },
      host: {
        schemaVersion: 1,
        runRef,
        attemptId,
        fence: 1,
        deadlineAt: mockDebugDeadlineAt,
        finalizationReserveMs: 0,
        scratchDirectory: path.join(scratchRoot, "workflow"),
        limits: { maxDurationMs: Number.MAX_SAFE_INTEGER, maxScratchBytes: 32 * 1024 * 1024 },
      },
    });
    return await new Promise<ReturnType<typeof currentController.inspect>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Mock workflow did not pause at entry.")), 10_000);
      const check = () => {
        const state = currentController.inspect();
        if (state.state === "paused") { clearTimeout(timeout); resolve(state); return; }
        if (workerOutcome) { clearTimeout(timeout); reject(new Error(`Mock worker ended before entry pause (${workerOutcome.kind}; last internal call: ${lastWorkerCall}).`)); return; }
        if (["action_required", "terminated"].includes(state.state)) { clearTimeout(timeout); reject(new Error("Mock workflow debugger became unavailable.")); return; }
        setTimeout(check, 10);
      };
      check();
    });
  };
  const graphInput = await prepareGraphInput();
  if (graphInput && typeof graphInput === "object" && !Array.isArray(graphInput)) {
    mockControl.graphInput = graphInput;
    mockControl.binding.invocation = (graphInput as Record<string, unknown>).invocation;
  }
  try {
    const inspected = await launchWorker();
    const initialController = controller;
    if (!initialController) throw new Error("Mock workflow debugger did not attach.");
    const sources = initialController.sources.list(0, 100);
    const evidence = {
      schemaVersion: 1,
      kind: "arkimux-mock-debugger-retained-bridge",
      ok: true,
      simulated: true,
      caseId: definition.caseId,
      buildSha256: definition.buildSha256,
      retainedCodeSha256: createHash("sha256").update(retainedCode).digest("hex"),
      pause: inspected.pause,
      sources,
    };
    const runtime: MockBridgeRuntime = {
      controller: () => controller ?? (() => { throw new HeadlessDebuggerError("not_running", "The mock workflow worker is not running.", "after_action"); })(),
      inspect: () => ({ state: controller?.inspect() ?? { attemptId, state: "terminated", pause: null, breakpoints: [], logs: { items: [], dropped: 0, truncated: false } },
        sources: controller?.sources.list(0, 100) ?? sources, suspension: currentSuspension(),
        terminal: workerOutcome && !currentSuspension()
          ? dockerMockDebuggerCaseResult(definition.caseId, definition.expectations, workerOutcome) : null }),
      respond: async params => {
        if (params.caseId !== definition.caseId) throw new HeadlessDebuggerError("not_found", "This response belongs to another mock case.", "never");
        const bodySha256 = hashJson(inputWaitJsonSnapshot({ requestId: params.requestId,
          expectedRevision: params.expectedRevision, response: params.response }));
        const previous = mockControl.receipts[params.submissionId];
        if (previous) {
          if (previous.requestId !== params.requestId || previous.acceptedBodySha256 !== bodySha256) {
            throw new HeadlessDebuggerError("input_already_answered", "This submission ID was already used for another mock answer.", "never");
          }
          if (!controller) { await stopWorker(); return { receipt: previous, state: await launchWorker() }; }
          return { receipt: previous, state: controller.inspect() };
        }
        const suspension = currentSuspension(), request = mockControl.requests[params.requestId];
        if (!suspension || suspension.requestId !== params.requestId || !request) throw new HeadlessDebuggerError("not_found", "The mock input request is not pending.", "never");
        if (request.status !== "pending") throw new HeadlessDebuggerError("input_already_answered", "The mock input request already has an answer.", "never");
        if (request.revision !== params.expectedRevision) throw new HeadlessDebuggerError("stale_revision", "The mock input request changed. Inspect it and retry.", "after_action");
        if (Date.now() >= Date.parse(request.definition.expiresAt)) throw new HeadlessDebuggerError("input_expired", "This mock input request expired before the answer was accepted.", "never");
        if (Object.values(params.response.files).some(files => files.length > 0)) throw new HeadlessDebuggerError("unsupported_operation", "Mock debug input does not accept file uploads.", "never");
        let response;
        try {
          validateInputResponseShapeV1(request.definition.form, params.response);
          response = await validateResponse(params.requestId, params.response);
        } catch (error) {
          if (error instanceof HeadlessDebuggerError) throw error;
          throw new HeadlessDebuggerError("invalid_response", "The mock input form rejected this answer.", "same_identity");
        }
        const acceptedAt = new Date().toISOString(), resumeCommandId = `resume-${hashJson({ runRef, requestId: params.requestId })}`;
        const receipt = { schemaVersion: 1, submissionId: params.submissionId, requestId: params.requestId, acceptedAt,
          acceptedBodySha256: bodySha256, resumeCommandId, responderId: "mock-debugger" };
        request.status = "submitted"; request.revision++; request.updatedAt = acceptedAt; request.response = response; request.submissionId = params.submissionId;
        mockControl.receipts[params.submissionId] = receipt;
        mockControl.commands[resumeCommandId] = { id: resumeCommandId, requestId: params.requestId, state: "pending" };
        mockControl.status = "resume_queued"; mockControl.revision++; mockControl.updatedAt = acceptedAt;
        await stopWorker();
        const state = await launchWorker();
        return { receipt, state };
      },
      close: stopWorker,
    };
    await serveBridge(runtime, evidence);
  } finally {
    await stopWorker();
  }
}

main().catch(error => {
  void error;
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: "arkimux-mock-debugger-retained-bridge", simulated: true, ok: false,
    error: { code: "bridge_start_failed", message: "The simulated workflow could not reach its entry pause." } }) + "\n");
  process.exitCode = 1;
});
