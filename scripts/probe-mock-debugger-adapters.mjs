import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { docker, repositoryRoot, sha256File, sortableTimestamp } from "./lib/mock-debugger-candidate.mjs";

const manifestArgument = process.argv.find(value => value.startsWith("--manifest="))?.slice("--manifest=".length);
if (!manifestArgument) throw new Error("Usage: node scripts/probe-mock-debugger-adapters.mjs --manifest=/absolute/path/manifest.json");
const manifestFile = path.resolve(manifestArgument);
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
if (manifest?.kind !== "arkimux-mock-debugger-private-candidate" || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId)) {
  throw new Error("Invalid mock-debugger candidate manifest.");
}
const archive = path.join(path.dirname(manifestFile), manifest.archiveFile);
if (await sha256File(archive) !== manifest.archiveSha256) throw new Error("Candidate archive SHA-256 mismatch.");
if ((await docker(["image", "inspect", manifest.imageReference, "--format", "{{.Id}}"])).stdout !== manifest.imageId) {
  throw new Error("Installed candidate image ID mismatch.");
}

const outputDirectory = path.join(repositoryRoot, ".codex-temp", "mock-debugger-adapter-probes", sortableTimestamp());
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const source = `export async function createMockAdapterFixture() {
  const json = { parse(value) { return value; } };
  const effect = {
    schemaVersion: 1, operationId: "weather.current", definitionVersion: "1", safety: "read",
    input: json, output: json,
    async execute() { throw new Error("REAL_EFFECT_EXECUTED"); },
  };
  const weatherStep = {
    schemaVersion: 1, id: "weather", definitionVersion: "1", input: json, output: json,
    async execute(context, input) { return context.effects.run(effect, input); },
  };
  const agentStep = {
    schemaVersion: 1, id: "recommend", definitionVersion: "1", input: json, output: json,
    async execute(context, input) {
      return context.agents.invoke({ schemaVersion: 1, operationId: "agent.recommend", slotId: "advisor", output: json }, input);
    },
  };
  return {
    agentPrompts: { advisor: "Use only the supplied simulated weather." },
    workflow: {
      workflow: { kind: "mock-adapter-fixture", version: 1 }, workflowContractVersion: "mock-adapter-v1",
      resultKind: "mock-adapter-result-v1", input: json, output: json,
      async execute(context, input) {
        const weather = (await context.steps.run(weatherStep, input)).output;
        const recommendation = (await context.steps.run(agentStep, weather)).output;
        const marker = { weather, recommendation };
        return marker;
      },
    },
  };
}
`;
const compiled = await transform(source, { loader: "ts", format: "esm", target: "node24", sourcemap: "inline",
  sourcefile: "workflows/mock-adapter-fixture/src/workflow.ts" });
const buildSha256 = createHash("sha256").update(compiled.code).digest("hex");
const createdAt = new Date().toISOString();
const caseId = "mock-adapters";
const bootstrap = {
  schemaVersion: 1,
  kind: "arkimux-mock-debugger-bootstrap",
  caseId,
  buildSha256,
  construction: { schemaVersion: 1, export: "createMockAdapterFixture" },
  invocation: {
    schemaVersion: 1,
    runRef: { executionId: `mock-${caseId}` },
    workflow: { kind: "mock-adapter-fixture", version: 1 },
    workflowContractVersion: "mock-adapter-v1",
    runConfiguration: { configurationId: "mock-debug-v1", contentHash: "a".repeat(64) },
    resultKind: "mock-adapter-result-v1",
    input: { city: "Istanbul" },
    createdAt,
  },
  runConfiguration: {},
  assets: [],
  mocks: {
    "weather.current": { kind: "result", value: { temperatureC: 27 }, delayMs: 5 },
    "agent.recommend": { kind: "result", value: { message: "Mock coat" }, delayMs: 5 },
  },
  expectations: [
    { id: "temperature", target: "result", pointer: "/weather/temperatureC", operator: "equals", value: 27 },
    { id: "recommendation", target: "result", pointer: "/recommendation/message", operator: "equals", value: "Mock coat" },
  ],
  stopOnEntry: true,
};
const launcherBundle = path.join(outputDirectory, "launcher.mjs");
await build({ entryPoints: [path.join(repositoryRoot, "cli/src/dockerMockDebuggerLauncher.ts")], outfile: launcherBundle,
  bundle: true, platform: "node", target: "node24", format: "esm", packages: "bundle", sourcemap: false, logLevel: "silent" });
const { launchDockerMockDebugger } = await import(pathToFileURL(launcherBundle).href);
const image = {
  sourceKind: "candidate-archive", manifestReference: manifest.imageReference, runtimeReference: manifest.imageId,
  imageIdentity: manifest.imageId, dockerServerVersion: "verified-by-probe", acquired: false,
};
const markerLine = source.split("\n").findIndex(line => line.includes("const marker")) + 1;
let session;
let evidence;
const waitForPause = async previousPauseId => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await session.request("debug.inspect", {});
    if (snapshot?.state?.state === "action_required") throw new Error(`Debugger became unavailable: ${JSON.stringify(snapshot)}`);
    if (snapshot?.state?.state === "paused" && snapshot.state.pause?.pauseId !== previousPauseId) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the mock adapter breakpoint.");
};
const waitForTerminal = async activeSession => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await activeSession.request("session.inspect", {});
    if (snapshot?.terminal) return snapshot.terminal;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the simulated case result.");
};
try {
  session = await launchDockerMockDebugger({ image, bootstrap, retainedCode: compiled.code });
  const sources = await session.request("debug.sources", { offset: 0, limit: 100 });
  const retainedSource = sources?.items?.find(item => item.displayPath === "workflows/mock-adapter-fixture/src/workflow.ts");
  if (!retainedSource) throw new Error("Mock adapter retained source was not listed.");
  const binding = await session.request("debug.breakpoints.set", { breakpoints: [{
    breakpointId: "after-mocks", sourceId: retainedSource.sourceId, line: markerLine, column: 1,
  }] });
  await session.request("debug.continue", { pauseId: session.ready.pause.pauseId });
  const paused = await waitForPause(session.ready.pause.pauseId);
  const pauseId = paused.state.pause.pauseId;
  const stack = await session.request("debug.stack", { pauseId, offset: 0, limit: 100 });
  const frame = stack?.items?.find(item => item.kind === "workflow" && item.location?.line === markerLine);
  if (!frame) throw new Error("Mock adapter workflow frame was not exposed.");
  const scopes = await session.request("debug.scopes", { pauseId, frameId: frame.frameId });
  const local = scopes?.items?.find(item => item.type === "local" && item.value?.kind === "object");
  if (!local) throw new Error("Mock adapter local scope was not exposed.");
  const locals = await session.request("debug.properties", { pauseId, objectId: local.value.objectId, offset: 0, limit: 100 });
  const weather = locals.items?.find(item => item.name === "weather" && item.value?.kind === "object");
  const recommendation = locals.items?.find(item => item.name === "recommendation" && item.value?.kind === "object");
  if (!weather || !recommendation) throw new Error("Mock adapter outputs were not exposed as local objects.");
  const weatherProperties = await session.request("debug.properties", { pauseId, objectId: weather.value.objectId, offset: 0, limit: 100 });
  const recommendationProperties = await session.request("debug.properties", { pauseId, objectId: recommendation.value.objectId, offset: 0, limit: 100 });
  if (!weatherProperties.items?.some(item => item.name === "temperatureC" && item.value?.value === 27)
    || !recommendationProperties.items?.some(item => item.name === "message" && item.value?.value === "Mock coat")) {
    throw new Error("Declared mock outputs did not reach the retained workflow.");
  }
  await session.request("debug.continue", { pauseId });
  const terminal = await waitForTerminal(session);
  if (terminal.status !== "passed" || terminal.simulated !== true || terminal.comparison?.comparison !== "pass"
    || terminal.output?.weather?.temperatureC !== 27 || terminal.output?.recommendation?.message !== "Mock coat") {
    throw new Error(`Simulated case result did not pass: ${JSON.stringify(terminal)}`);
  }
  evidence = { schemaVersion: 1, kind: "arkimux-mock-debugger-adapter-evidence", checkedAt: new Date().toISOString(),
    manifestFile, imageId: manifest.imageId, archiveSha256: manifest.archiveSha256, caseId, buildSha256,
    mocks: bootstrap.mocks, expectations: bootstrap.expectations, markerLine, binding, paused, stack, scopes, locals,
    weatherProperties, recommendationProperties, terminal,
    realEffectImplementationBypassed: true, declaredEffectMockUsed: true, declaredAgentMockUsed: true };
} finally {
  await session?.close();
}
const runFailureCase = async (failureCaseId, mocks, failureCode) => {
  let failureSession;
  try {
    failureSession = await launchDockerMockDebugger({ image, retainedCode: compiled.code, bootstrap: {
      ...bootstrap,
      caseId: failureCaseId,
      invocation: { ...bootstrap.invocation, runRef: { executionId: `mock-${failureCaseId}` } },
      mocks,
      expectations: [{ id: "failed", target: "run-status", operator: "equals", value: "failed" }],
    } });
    await failureSession.request("debug.continue", { pauseId: failureSession.ready.pause.pauseId });
    const terminal = await waitForTerminal(failureSession);
    if (terminal.status !== "passed" || terminal.comparison?.comparison !== "pass" || terminal.failure?.code !== failureCode) {
      throw new Error(`Simulated failure case did not match: ${JSON.stringify(terminal)}`);
    }
    return terminal;
  } finally {
    await failureSession?.close();
  }
};
const declaredErrorTerminal = await runFailureCase("mock-declared-error", {
  "weather.current": { kind: "error", error: { code: "weather_fixture_failed", message: "Weather fixture failed." } },
  "agent.recommend": bootstrap.mocks["agent.recommend"],
}, "weather_fixture_failed");
const unsupportedTerminal = await runFailureCase("mock-unsupported", {
  "agent.recommend": bootstrap.mocks["agent.recommend"],
}, "unsupported_mock_dependency");
let mismatchSession;
let mismatchTerminal;
try {
  mismatchSession = await launchDockerMockDebugger({ image, retainedCode: compiled.code, bootstrap: {
    ...bootstrap,
    caseId: "mock-mismatch",
    invocation: { ...bootstrap.invocation, runRef: { executionId: "mock-mismatch" } },
    expectations: [{ id: "temperature", target: "result", pointer: "/weather/temperatureC", operator: "equals", value: 99 }],
  } });
  await mismatchSession.request("debug.continue", { pauseId: mismatchSession.ready.pause.pauseId });
  mismatchTerminal = await waitForTerminal(mismatchSession);
  if (mismatchTerminal.status !== "mismatch" || mismatchTerminal.comparison?.comparison !== "mismatch"
    || mismatchTerminal.output?.weather?.temperatureC !== 27) {
    throw new Error(`Simulated mismatch case did not mismatch: ${JSON.stringify(mismatchTerminal)}`);
  }
} finally {
  await mismatchSession?.close();
}
evidence.declaredErrorTerminal = declaredErrorTerminal;
evidence.unsupportedTerminal = unsupportedTerminal;
evidence.mismatchTerminal = mismatchTerminal;
await rm(launcherBundle, { force: true });
const evidenceFile = path.join(outputDirectory, "mock-adapter-evidence.json");
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ evidenceFile, imageId: manifest.imageId, realEffectImplementationBypassed: true,
  declaredEffectMockUsed: true, declaredAgentMockUsed: true, terminalComparison: "pass",
  declaredErrorCompared: true, unsupportedDependencyCompared: true, mismatchCompared: true }, null, 2) + "\n");
