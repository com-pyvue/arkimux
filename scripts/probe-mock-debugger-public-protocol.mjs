import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { docker, repositoryRoot, runIsolationProbe, sha256File, sortableTimestamp } from "./lib/mock-debugger-candidate.mjs";

if (!process.execArgv.includes("--experimental-transform-types")) {
  throw new Error("Run this probe with Node 24 --experimental-transform-types so it imports the checked TypeScript sources without relocating them.");
}

const manifestArgument = process.argv.find(value => value.startsWith("--manifest="))?.slice("--manifest=".length);
const imageReferenceArgument = process.argv.find(value => value.startsWith("--image-reference="))?.slice("--image-reference=".length);
const builtCli = process.argv.includes("--built-cli");
if ([Boolean(manifestArgument), Boolean(imageReferenceArgument), builtCli].filter(Boolean).length !== 1) {
  throw new Error("Usage: node scripts/probe-mock-debugger-public-protocol.mjs (--manifest=/absolute/path/manifest.json | --image-reference=REPOSITORY@sha256:DIGEST | --built-cli)");
}
const pauseProofMs = Number(process.argv.find(value => value.startsWith("--pause-proof-ms="))?.slice("--pause-proof-ms=".length) ?? 0);
if (!Number.isInteger(pauseProofMs) || pauseProofMs < 0 || pauseProofMs > 120_000) {
  throw new Error("--pause-proof-ms must be an integer from 0 through 120000.");
}
const manifestFile = manifestArgument ? path.resolve(manifestArgument) : null;
const manifest = manifestFile ? JSON.parse(await readFile(manifestFile, "utf8")) : null;
if (manifest && (manifest.kind !== "arkimux-mock-debugger-private-candidate" || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId))) {
  throw new Error("Invalid mock-debugger candidate manifest.");
}
if (manifest) {
  const archive = path.join(path.dirname(manifestFile), manifest.archiveFile);
  if (await sha256File(archive) !== manifest.archiveSha256) throw new Error("Candidate archive SHA-256 mismatch.");
  if ((await docker(["image", "inspect", manifest.imageReference, "--format", "{{.Id}}"]))?.stdout !== manifest.imageId) {
    throw new Error("Installed candidate image ID mismatch.");
  }
}
if (imageReferenceArgument && !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(imageReferenceArgument)) {
  throw new Error("The public image reference must use an immutable SHA-256 registry digest.");
}

const outputDirectory = path.join(repositoryRoot, ".codex-temp", "mock-debugger-public-protocol-probes", sortableTimestamp());
const projectRoot = await mkdtemp(path.join(tmpdir(), "arkimux-mock-debug-project-"));
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const sourceRelative = "workflows/protocol-fixture/src/workflow.ts";
const source = `export const input = { parse(value) { if (!value || !Number.isFinite(value.value)) throw new Error("Invalid input"); return value; } };
export const output = { parse(value) { if (value?.schemaVersion !== 1 || !Number.isFinite(value.result)) throw new Error("Invalid output"); return value; } };
export function defineWorkflow() { throw new Error("Definition is not executed during retained construction"); }
const json = { parse(value) { return value; } };
const mockEffect = { schemaVersion: 1, operationId: "fixture.effect", definitionVersion: "1", safety: "read", input: json, output: json,
  async execute() { throw new Error("REAL_EFFECT_MUST_NOT_EXECUTE"); } };
const mockStep = { schemaVersion: 1, id: "mock-effect", definitionVersion: "1", input: json, output: json,
  async execute(context, value) { return context.effects.run(mockEffect, value); } };
export function createMockEffect() { return mockEffect; }
function double(number) {
  const twice = number * 2;
  return twice;
}
export async function constructWorkflow() {
  return { agentPrompts: {}, workflow: {
    workflow: { kind: "protocol-fixture", version: 1 }, workflowContractVersion: "1", resultKind: "protocol-fixture.result",
    input, output,
    async execute(context, supplied) {
      const mocked = supplied.effect ? (await context.steps.run(mockStep, { value: supplied.value })).output : null;
      const before = supplied.value;
      let result = before + 1;
      debugger;
      const marker = result;
      const doubled = double(marker);
      return { schemaVersion: 1, before, marker, result, doubled, mocked, deadlineAt: context.deadlineAt };
    }
  } };
}
`;
const breakpointLine = source.split("\n").findIndex(line => line.includes("const marker")) + 1;
const callLine = source.split("\n").findIndex(line => line.includes("double(marker)")) + 1;
const nestedEntryLine = source.split("\n").findIndex(line => line.includes("const twice")) + 1;

async function writeProject() {
  const workflowRoot = path.join(projectRoot, "workflows/protocol-fixture");
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await mkdir(path.join(workflowRoot, "src"), { recursive: true });
  await mkdir(path.join(workflowRoot, "run-configurations"), { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "mock-debug-protocol-fixture", private: true, type: "module" }) + "\n");
  await writeFile(path.join(projectRoot, "src/arkimux.workflows.ts"), `export const workflowDeclarations = [{
    manifest: "workflows/protocol-fixture/manifest.json", environment: "workflows/protocol-fixture/environment.json",
    definition: { file: ${JSON.stringify(sourceRelative)}, export: "defineWorkflow" },
    inputValidator: { file: ${JSON.stringify(sourceRelative)}, export: "input" },
    resultValidator: { file: ${JSON.stringify(sourceRelative)}, export: "output" },
    result: { kind: "protocol-fixture.result", schemaVersion: 1 },
    effects: [{ file: ${JSON.stringify(sourceRelative)}, export: "createMockEffect" }], agentSlots: [],
    construction: { file: ${JSON.stringify(sourceRelative)}, export: "constructWorkflow", assets: [] }
  }];
  export function loadProjectWorkflows() { throw new Error("The live registry must not run during debug preparation"); }\n`);
  await writeFile(path.join(projectRoot, sourceRelative), source);
  await writeFile(path.join(workflowRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, workflowId: "protocol-fixture",
    workflowMode: "arkimux-portable", workflowContractVersion: "1", requiredCapabilities: ["effect-read@1", "typed-results@1"],
    executionRequirements: { schemaVersion: 1, run: { maxDurationSeconds: 30 }, operations: {} }, sourceBindings: [] }) + "\n");
  await writeFile(path.join(workflowRoot, "environment.json"), JSON.stringify({ schemaVersion: 1, variables: [] }) + "\n");
  await writeFile(path.join(workflowRoot, "run-configurations/mock-v1.json"), JSON.stringify({ schemaVersion: 1,
    configurationId: "protocol-fixture-v1", workflow: { kind: "protocol-fixture", version: 1 }, agents: {} }) + "\n");
}

async function hashTree(root) {
  const records = [];
  const visit = async relative => {
    const directory = path.join(root, relative);
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(relative, name), absolute = path.join(root, child), info = await stat(absolute);
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) records.push([child, createHash("sha256").update(await readFile(absolute)).digest("hex")]);
      else throw new Error("Protocol fixture contains a non-regular path.");
    }
  };
  await visit("");
  return records;
}

let coordinator, transportPromise, inputStream, transportChild;
try {
  await writeProject();
  const projectBefore = await hashTree(projectRoot);
  const { validateProjectSource } = await import(pathToFileURL(path.join(repositoryRoot, "cli/src/projectSourceGuard.ts")).href);
  await validateProjectSource(projectRoot, { includeRenderers: false });
  const containersBefore = (await docker(["ps", "-a", "--filter", "name=arkimux-mock-debug", "--format", "{{.Names}}"])).stdout.split("\n").filter(Boolean).sort();
  const { ensureDebugImage } = await import(pathToFileURL(path.join(repositoryRoot, "cli/src/dockerMockDebugger.ts")).href);
  const packagedImageSource = builtCli
    ? JSON.parse(await readFile(path.join(repositoryRoot, "cli/src/dockerMockDebuggerImageSource.json"), "utf8"))
    : null;
  const imageSource = manifest ? { kind: "candidate-archive", archiveUrl: "https://private.invalid/mock-debugger.tar",
    archiveSha256: manifest.archiveSha256, imageReference: manifest.imageReference, imageId: manifest.imageId }
    : packagedImageSource ?? { kind: "registry", imageReference: imageReferenceArgument };
  const ensuredImage = manifest ? { sourceKind: "candidate-archive", manifestReference: manifest.imageReference,
    runtimeReference: manifest.imageId, imageIdentity: manifest.imageId, dockerServerVersion: "verified-by-probe", acquired: false }
    : await ensureDebugImage(imageSource);
  const isolation = await runIsolationProbe(ensuredImage.runtimeReference, outputDirectory);
  const messages = [], pending = new Map();
  let outputPartial = "", requestSequence = 0;
  const consumeOutput = chunk => {
    outputPartial += Buffer.from(chunk).toString("utf8");
    while (outputPartial.includes("\n")) {
      const index = outputPartial.indexOf("\n"), line = outputPartial.slice(0, index); outputPartial = outputPartial.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line); messages.push(message);
      if (typeof message.id === "string") { pending.get(message.id)?.(message); pending.delete(message.id); }
    }
  };
  const diagnostics = [];
  if (builtCli) {
    const cli = path.join(repositoryRoot, "cli/dist/cli.js");
    await readFile(cli);
    transportChild = spawn(process.execPath, [cli, "debug", "stdio", "--project", projectRoot], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`, LANG: "en_US.UTF-8", TZ: "UTC" },
    });
    inputStream = transportChild.stdin;
    transportChild.stdout.on("data", consumeOutput);
    transportChild.stderr.on("data", chunk => diagnostics.push(Buffer.from(chunk).toString("utf8")));
    transportPromise = new Promise((resolve, reject) => {
      transportChild.once("error", reject);
      transportChild.once("exit", (code, signal) => signal ? reject(new Error(`Built CLI exited from ${signal}.`)) : resolve(code));
    });
  } else {
    const [{ runHeadlessDebuggerTransport }, { createPreparedDockerMockDebuggerCoordinator }] = await Promise.all([
      import(pathToFileURL(path.join(repositoryRoot, "cli/src/headlessDebuggerCommand.ts")).href),
      import(pathToFileURL(path.join(repositoryRoot, "cli/src/dockerMockDebuggerCoordinator.ts")).href),
    ]);
    inputStream = new PassThrough();
    const outputStream = new Writable({ write(chunk, _encoding, callback) { consumeOutput(chunk); callback(); } });
    transportPromise = runHeadlessDebuggerTransport({ input: inputStream, output: outputStream,
      diagnostics: { write: value => { diagnostics.push(String(value)); return true; } },
      async createClient(onChange) {
        coordinator = await createPreparedDockerMockDebuggerCoordinator({ projectRoot, hostRequirements: { node: "24" },
          imageSource,
          ensureImage: async () => ensuredImage, onChange });
        return coordinator;
      },
    });
  }
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = `request-${++requestSequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Protocol response timed out: ${method}`)); }, 15_000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    inputStream.write(JSON.stringify({ schemaVersion: 2, id, method, params }) + "\n");
  });
  const ok = async (method, params) => {
    const response = await request(method, params);
    if (response.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const error = async (method, params, code) => {
    const response = await request(method, params);
    if (response.ok !== false || response.error?.code !== code) throw new Error(`${method} did not return ${code}: ${JSON.stringify(response)}`);
    return response.error;
  };
  const authorization = { executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true, allowSimulatedEvaluation: true };
  const sessionManifest = { schemaVersion: 2, sessionId: "public-protocol", workflowId: "protocol-fixture",
    configurationId: "protocol-fixture-v1", debug: { stopOnEntry: true }, cases: [
      { caseId: "pass", input: { value: 10 }, mocks: {}, expectations: [
        { id: "marker", target: "result", pointer: "/marker", operator: "equals", value: 20 },
        { id: "doubled", target: "result", pointer: "/doubled", operator: "equals", value: 40 },
        { id: "deadline", target: "result", pointer: "/deadlineAt", operator: "equals", value: "9999-12-31T23:59:59.999Z" },
      ] },
      { caseId: "stepping", input: { value: 10 }, mocks: {}, expectations: [
        { id: "marker", target: "result", pointer: "/marker", operator: "equals", value: 11 },
        { id: "doubled", target: "result", pointer: "/doubled", operator: "equals", value: 22 },
      ] },
      { caseId: "declared-effect", input: { value: 10, effect: true },
        mocks: { "fixture.effect": { kind: "result", value: { simulated: true }, delayMs: 0 } }, expectations: [
          { id: "mocked", target: "result", pointer: "/mocked/simulated", operator: "equals", value: true },
        ] },
      { caseId: "undeclared-effect", input: { value: 10, effect: true }, mocks: {}, expectations: [
        { id: "expected-failure", target: "run-status", operator: "equals", value: "failed" },
      ] },
      { caseId: "cancel", input: { value: 20 }, mocks: {}, expectations: [] },
      { caseId: "crash", input: { value: 30 }, mocks: {}, expectations: [] },
      { caseId: "disconnect", input: { value: 40 }, mocks: {}, expectations: [] },
    ] };
  const created = await ok("session.create", { manifest: sessionManifest, authorization });
  const editedSource = "throw new Error('CURRENT PROJECT SOURCE MUST NOT LOAD');\n";
  await writeFile(path.join(projectRoot, sourceRelative), editedSource);
  const run = await ok("case.run", { caseId: "pass" });
  const sources = await ok("debug.sources", { offset: 0, limit: 100 });
  const retainedSource = sources.items.find(item => item.displayPath === sourceRelative);
  if (!retainedSource) throw new Error("The public protocol did not expose retained source.");
  const sourceRead = await ok("debug.source.read", { sourceId: retainedSource.sourceId, offset: 0, limit: 262144 });
  await writeFile(path.join(projectRoot, sourceRelative), source);
  const initial = await ok("debug.inspect", { caseId: "pass" });
  const initialStack = await ok("debug.stack", { caseId: "pass", pauseId: initial.state.pause.pauseId, offset: 0, limit: 100 });
  const initialFrame = initialStack.items.find(item => item.kind === "workflow");
  const initialFrameworkFrame = initialStack.items.find(item => item.kind === "framework");
  if (!initialFrame || !initialFrameworkFrame) throw new Error("The public protocol did not distinguish workflow and framework frames.");
  const initialScopes = await ok("debug.scopes", { caseId: "pass", pauseId: initial.state.pause.pauseId, frameId: initialFrame.frameId });
  const initialLocal = initialScopes.items.find(item => item.type === "local" && item.value?.kind === "object");
  if (!initialLocal) throw new Error("The public protocol did not expose the entry scope.");
  const initialProperties = await ok("debug.properties", { caseId: "pass", pauseId: initial.state.pause.pauseId,
    objectId: initialLocal.value.objectId, offset: 0, limit: 100 });
  const suppliedInput = initialProperties.items.find(item => item.name === "supplied" && item.value?.kind === "object");
  if (!suppliedInput) throw new Error("The public protocol did not expose the starting input.");
  const inputProperties = await ok("debug.properties", { caseId: "pass", pauseId: initial.state.pause.pauseId,
    objectId: suppliedInput.value.objectId, offset: 0, limit: 100 });
  const excludedFrameworkScope = await error("debug.scopes", { caseId: "pass", pauseId: initial.state.pause.pauseId,
    frameId: initialFrameworkFrame.frameId }, "inspection_unavailable");
  const foreignHandle = await error("debug.properties", { caseId: "pass", pauseId: initial.state.pause.pauseId,
    objectId: "foreign-object", offset: 0, limit: 100 }, "stale_handle");
  const pauseProofStartedAt = new Date().toISOString();
  const pauseProofStartedMonotonic = performance.now();
  if (pauseProofMs > 0) await new Promise(resolve => setTimeout(resolve, pauseProofMs));
  const afterPauseProof = await ok("debug.inspect", { caseId: "pass" });
  const pauseProofElapsedMs = Math.floor(performance.now() - pauseProofStartedMonotonic);
  const pauseProofFinishedAt = new Date().toISOString();
  if (pauseProofElapsedMs < pauseProofMs || afterPauseProof.state?.state !== "paused"
    || afterPauseProof.state.pause?.pauseId !== initial.state.pause?.pauseId) {
    throw new Error("The public protocol did not preserve the paused case for the requested proof interval.");
  }
  const breakpoints = await ok("debug.breakpoints.set", { expectedDebuggerRevision: initial.state.debuggerRevision, breakpoints: [
    { breakpointId: "result-ready", sourceId: retainedSource.sourceId, line: breakpointLine, column: 1, condition: "result === 11" },
  ] });
  await ok("debug.continue", { caseId: "pass", pauseId: initial.state.pause.pauseId, controlId: "continue-entry" });
  let paused;
  for (let attempt = 0; attempt < 500; attempt++) {
    const inspected = await ok("debug.inspect", { caseId: "pass" });
    if (inspected.state?.state === "paused" && inspected.state.pause?.reason === "breakpoint") { paused = inspected; break; }
    if (inspected.state?.state === "paused") {
      await ok("debug.continue", { caseId: "pass", pauseId: inspected.state.pause.pauseId, controlId: `continue-intermediate-${attempt}` });
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!paused) throw new Error("The public protocol did not reach the retained breakpoint.");
  const stack = await ok("debug.stack", { caseId: "pass", pauseId: paused.state.pause.pauseId, offset: 0, limit: 100 });
  const frame = stack.items.find(item => item.kind === "workflow");
  if (!frame) throw new Error("The public protocol did not expose a workflow frame.");
  const scopes = await ok("debug.scopes", { caseId: "pass", pauseId: paused.state.pause.pauseId, frameId: frame.frameId });
  const local = scopes.items.find(item => item.type === "local" && item.value?.kind === "object");
  if (!local) throw new Error("The public protocol did not expose local scope.");
  const properties = await ok("debug.properties", { caseId: "pass", pauseId: paused.state.pause.pauseId,
    objectId: local.value.objectId, offset: 0, limit: 100 });
  const evaluation = await ok("debug.evaluate", { caseId: "pass", pauseId: paused.state.pause.pauseId,
    frameId: frame.frameId, evaluationId: "result-plus-one", expression: "result + 1" });
  const mutationParams = { caseId: "pass", pauseId: paused.state.pause.pauseId, frameId: frame.frameId,
    controlId: "set-result", name: "result", expression: "20" };
  const mutation = await ok("debug.variable.set", mutationParams);
  const mutationRetry = await ok("debug.variable.set", mutationParams);
  const updatedEvaluation = await ok("debug.evaluate", { caseId: "pass", pauseId: paused.state.pause.pauseId,
    frameId: frame.frameId, evaluationId: "updated-result", expression: "result" });
  const step = await ok("debug.step", { caseId: "pass", pauseId: paused.state.pause.pauseId, controlId: "step-over", kind: "over" });
  let stepped;
  for (let attempt = 0; attempt < 500; attempt++) {
    const inspected = await ok("debug.inspect", { caseId: "pass" });
    if (inspected.state?.state === "paused" && inspected.state.pause?.pauseId !== paused.state.pause.pauseId) { stepped = inspected; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!stepped) throw new Error("The public protocol did not return a new step pause.");
  const staleHandle = await error("debug.properties", { caseId: "pass", pauseId: stepped.state.pause.pauseId,
    objectId: local.value.objectId, offset: 0, limit: 100 }, "stale_handle");
  await ok("debug.continue", { caseId: "pass", pauseId: stepped.state.pause.pauseId, controlId: "continue-result" });
  let completed;
  for (let attempt = 0; attempt < 500; attempt++) {
    const inspected = await ok("session.inspect", {});
    completed = inspected.cases.find(item => item.caseId === "pass");
    if (completed?.state === "terminal") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (completed?.terminal?.status !== "passed") throw new Error(`The public protocol case did not pass: ${JSON.stringify(completed)}`);
  const terminalEvidence = completed.evidence[0];
  const evidence = await ok("evidence.read", { caseId: "pass", evidenceId: terminalEvidence.evidenceId, offset: 0, limit: 262144 });
  const terminalFromEvidence = JSON.parse(Buffer.from(evidence.data, "base64").toString("utf8"));
  await ok("case.run", { caseId: "stepping" });
  const steppingEntry = await ok("debug.inspect", { caseId: "stepping" });
  const steppingBreakpoints = await ok("debug.breakpoints.set", { expectedDebuggerRevision: steppingEntry.state.debuggerRevision, breakpoints: [
    { breakpointId: "nested-call", sourceId: retainedSource.sourceId, line: callLine, column: 1 },
  ] });
  await ok("debug.continue", { caseId: "stepping", pauseId: steppingEntry.state.pause.pauseId, controlId: "stepping-to-call" });
  let callPause;
  for (let attempt = 0; attempt < 500; attempt++) {
    const inspected = await ok("debug.inspect", { caseId: "stepping" });
    if (inspected.state?.state === "paused" && inspected.state.pause?.reason === "breakpoint") { callPause = inspected; break; }
    if (inspected.state?.state === "paused") {
      await ok("debug.continue", { caseId: "stepping", pauseId: inspected.state.pause.pauseId, controlId: `stepping-intermediate-${attempt}` });
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!callPause) throw new Error("The public protocol did not pause at the nested call.");
  const stepInto = [], stepIntoPauses = [];
  let insidePause, insideStack, previousIntoPause = callPause;
  for (let intoAttempt = 0; intoAttempt < 5; intoAttempt++) {
    stepInto.push(await ok("debug.step", { caseId: "stepping", pauseId: previousIntoPause.state.pause.pauseId,
      controlId: `step-into-${intoAttempt}`, kind: "into" }));
    let nextPause;
    for (let attempt = 0; attempt < 500; attempt++) {
      const inspected = await ok("debug.inspect", { caseId: "stepping" });
      if (inspected.state?.state === "paused" && inspected.state.pause?.pauseId !== previousIntoPause.state.pause.pauseId) { nextPause = inspected; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!nextPause) break;
    const nextStack = await ok("debug.stack", { caseId: "stepping", pauseId: nextPause.state.pause.pauseId, offset: 0, limit: 100 });
    stepIntoPauses.push({ pause: nextPause, stack: nextStack });
    if (nextStack.items.some(item => item.kind === "workflow" && item.functionName.includes("double"))) {
      insidePause = nextPause; insideStack = nextStack; break;
    }
    previousIntoPause = nextPause;
  }
  if (!insidePause || !insideStack) {
    throw new Error(`The public protocol did not expose the nested workflow frame: ${JSON.stringify({ nestedEntryLine, stepIntoPauses })}`);
  }
  const stepOverNested = await ok("debug.step", { caseId: "stepping", pauseId: insidePause.state.pause.pauseId,
    controlId: "step-over-nested", kind: "over" });
  let nestedAssignmentPause;
  for (let attempt = 0; attempt < 500; attempt++) {
    const inspected = await ok("debug.inspect", { caseId: "stepping" });
    if (inspected.state?.state === "paused" && inspected.state.pause?.pauseId !== insidePause.state.pause.pauseId) { nestedAssignmentPause = inspected; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!nestedAssignmentPause) throw new Error("The public protocol did not step over inside the retained helper.");
  const stepOut = await ok("debug.step", { caseId: "stepping", pauseId: nestedAssignmentPause.state.pause.pauseId,
    controlId: "step-out", kind: "out" });
  let callerPause;
  for (let attempt = 0; attempt < 500; attempt++) {
    const inspected = await ok("debug.inspect", { caseId: "stepping" });
    if (inspected.state?.state === "paused" && inspected.state.pause?.pauseId !== nestedAssignmentPause.state.pause.pauseId) { callerPause = inspected; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!callerPause) throw new Error("The public protocol did not step out to the workflow caller.");
  const callerStack = await ok("debug.stack", { caseId: "stepping", pauseId: callerPause.state.pause.pauseId, offset: 0, limit: 100 });
  if (!callerStack.items.some(item => item.kind === "workflow" && item.functionName.includes("execute"))) {
    throw new Error("The public protocol did not return to the workflow caller after step out.");
  }
  await ok("debug.breakpoints.set", { expectedDebuggerRevision: callerPause.state.debuggerRevision, breakpoints: [] });
  await ok("debug.continue", { caseId: "stepping", pauseId: callerPause.state.pause.pauseId, controlId: "stepping-finish" });
  let steppingCompleted;
  for (let attempt = 0; attempt < 500; attempt++) {
    const inspected = await ok("session.inspect", {});
    steppingCompleted = inspected.cases.find(item => item.caseId === "stepping");
    if (steppingCompleted?.state === "terminal") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (steppingCompleted?.terminal?.status !== "passed") throw new Error(`The stepping case did not pass: ${JSON.stringify(steppingCompleted)}`);
  const finishEffectCase = async caseId => {
    await ok("case.run", { caseId });
    for (let attempt = 0; attempt < 500; attempt++) {
      const inspected = await ok("debug.inspect", { caseId });
      if (inspected.state?.state === "paused") {
        await ok("debug.continue", { caseId, pauseId: inspected.state.pause.pauseId, controlId: `${caseId}-continue-${attempt}` });
      }
      const session = await ok("session.inspect", {});
      const item = session.cases.find(value => value.caseId === caseId);
      if (item?.state === "terminal") return item;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`The ${caseId} case did not finish.`);
  };
  const declaredEffect = await finishEffectCase("declared-effect");
  const undeclaredEffect = await finishEffectCase("undeclared-effect");
  if (declaredEffect.terminal?.status !== "passed" || declaredEffect.terminal?.output?.mocked?.simulated !== true) {
    throw new Error(`The declared mock effect did not pass: ${JSON.stringify(declaredEffect)}`);
  }
  if (undeclaredEffect.terminal?.status !== "passed" || undeclaredEffect.terminal?.failure?.code !== "unsupported_mock_dependency") {
    throw new Error(`The undeclared mock effect did not fail as expected: ${JSON.stringify(undeclaredEffect)}`);
  }
  await ok("case.run", { caseId: "cancel" });
  const cancelled = await ok("case.cancel", { caseId: "cancel" });
  await ok("case.run", { caseId: "crash" });
  const containersBeforeCrash = (await docker(["ps", "-a", "--filter", "name=arkimux-mock-debug", "--format", "{{.Names}}"]))
    .stdout.split("\n").filter(Boolean).sort();
  const crashContainers = containersBeforeCrash.filter(name => !containersBefore.includes(name));
  if (crashContainers.length !== 1) throw new Error(`Expected one active crash-test container, found ${JSON.stringify(crashContainers)}.`);
  await docker(["kill", crashContainers[0]]);
  const crashError = await error("debug.inspect", { caseId: "crash" }, "debugger_unavailable");
  const afterCrash = await ok("session.inspect", {});
  const crashed = afterCrash.cases.find(item => item.caseId === "crash");
  if (crashed?.state !== "terminal" || crashed.terminal?.status !== "sandbox_unavailable") {
    throw new Error(`The public protocol did not retain the unexpected-exit result: ${JSON.stringify(crashed)}.`);
  }
  await ok("case.run", { caseId: "disconnect" });
  const disconnectPaused = await ok("debug.inspect", { caseId: "disconnect" });
  if (disconnectPaused.state?.state !== "paused") throw new Error("The disconnect case did not reach a real pause.");
  if (builtCli) inputStream.end();
  else { await ok("session.close", {}); inputStream.end(); }
  const exitCode = await transportPromise;
  const projectAfter = await hashTree(projectRoot);
  const containersAfter = (await docker(["ps", "-a", "--filter", "name=arkimux-mock-debug", "--format", "{{.Names}}"])).stdout.split("\n").filter(Boolean).sort();
  if (exitCode !== 0 || diagnostics.length > 0 || sourceRead.data === undefined
    || Buffer.from(sourceRead.data, "base64").toString("utf8") !== source
    || !breakpoints.some(item => item.breakpointId === "result-ready" && ["bound", "pending"].includes(item.state))
    || !steppingBreakpoints.some(item => item.breakpointId === "nested-call" && ["bound", "pending"].includes(item.state))
    || !initialProperties.items.some(item => item.name === "before" && item.value?.kind === "uninitialized")
    || !initialProperties.items.some(item => item.name === "context" && item.value?.kind === "redacted")
    || !inputProperties.items.some(item => item.name === "value" && item.value?.value === 10)
    || excludedFrameworkScope.code !== "inspection_unavailable" || foreignHandle.code !== "stale_handle"
    || !properties.items.some(item => item.name === "before" && item.value?.value === 10)
    || evaluation.result?.value !== 12 || mutation.status !== "applied"
    || updatedEvaluation.result?.value !== 20
    || JSON.stringify(mutationRetry) !== JSON.stringify(mutation) || step.state !== "running"
    || stepInto.some(item => item.state !== "running") || stepOverNested.state !== "running" || stepOut.state !== "running"
    || steppingCompleted?.terminal?.status !== "passed"
    || declaredEffect?.terminal?.status !== "passed" || undeclaredEffect?.terminal?.failure?.code !== "unsupported_mock_dependency"
    || staleHandle.retry !== "after_action" || terminalFromEvidence.status !== "passed"
    || cancelled.state !== "terminal" || cancelled.terminal?.status !== "cancelled"
    || crashError.code !== "debugger_unavailable" || crashed.terminal?.status !== "sandbox_unavailable"
    || disconnectPaused.state?.state !== "paused"
    || JSON.stringify(projectAfter) !== JSON.stringify(projectBefore)
    || JSON.stringify(containersAfter) !== JSON.stringify(containersBefore)
    || messages.filter(item => item.event === "session.changed").length === 0) {
    throw new Error(`Public protocol probe failed: ${JSON.stringify({ exitCode, diagnostics, breakpoints, steppingBreakpoints,
      initialProperties, inputProperties, excludedFrameworkScope, foreignHandle, properties,
      evaluation, mutation, mutationRetry, step, stepInto, stepOverNested, stepOut, staleHandle,
      completed, steppingCompleted, declaredEffect, undeclaredEffect, terminalFromEvidence, cancelled, crashError, crashed, disconnectPaused,
      projectBefore, projectAfter, containersBefore, containersAfter, messages })}`);
  }
  const report = { schemaVersion: 1, kind: "arkimux-mock-debugger-public-protocol-evidence", checkedAt: new Date().toISOString(),
    client: builtCli ? { kind: "built-cli-subprocess", command: [process.execPath, "cli/dist/cli.js", "debug", "stdio", "--project", projectRoot] }
      : { kind: "in-process-transport" },
    imageSource, ensuredImage, manifestFile, isolation, created, sources, sourceRead,
    retainedEditProbe: { editedCurrentSource: editedSource, retainedSourceRead: source },
    initialStack, initialScopes, initialProperties, inputProperties, excludedFrameworkScope, foreignHandle,
    breakpoints, paused, stack, scopes, properties, evaluation, mutation, mutationRetry, updatedEvaluation, step, stepped, staleHandle,
    stepping: { breakpoints: steppingBreakpoints, callPause, stepInto, stepIntoPauses, insidePause, insideStack, stepOverNested,
      nestedAssignmentPause, stepOut, callerPause, callerStack, completed: steppingCompleted },
    mockEffects: { declared: declaredEffect, undeclared: undeclaredEffect },
    pauseProof: { requestedMs: pauseProofMs, elapsedMs: pauseProofElapsedMs,
      startedAt: pauseProofStartedAt, finishedAt: pauseProofFinishedAt,
      state: afterPauseProof.state },
    completed, terminalFromEvidence, cancelled, crashError, crashed, disconnectPaused, containersBeforeCrash,
    projectBefore, projectAfter, containersBefore, containersAfter,
    sessionChangedEvents: messages.filter(item => item.event === "session.changed") };
  const evidenceFile = path.join(outputDirectory, "public-protocol-evidence.json");
  await writeFile(evidenceFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ evidenceFile, imageIdentity: ensuredImage.imageIdentity,
    client: builtCli ? "built-cli-subprocess" : "in-process-transport", transport: true, entryPause: true,
    breakpoint: true, inspection: true, mutation: true, stepInto: true, stepOver: true, stepOut: true,
    uninitialized: true, redacted: true, excludedFrameworkScope: true, foreignHandle: true, staleHandle: true, terminalEvidence: true,
    declaredMockEffect: true, undeclaredMockRejected: true,
    cancellation: true, disconnectCleanup: builtCli, unexpectedExit: true, noWorkflowDeadline: pauseProofElapsedMs > 30_000, pauseProofMs, pauseProofElapsedMs,
    retainedSourceAfterEdit: true, isolation: true, projectUnchanged: true, containersCleaned: true }, null, 2) + "\n");
} finally {
  inputStream?.end();
  await coordinator?.close().catch(() => {});
  if (transportChild && !transportChild.killed && transportChild.exitCode === null) transportChild.kill("SIGTERM");
  await transportPromise?.catch(() => {});
  await rm(projectRoot, { recursive: true, force: true });
}
