import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { docker, repositoryRoot, sha256File, sortableTimestamp } from "./lib/mock-debugger-candidate.mjs";

const manifestArgument = process.argv.find(value => value.startsWith("--manifest="))?.slice("--manifest=".length);
if (!manifestArgument) throw new Error("Usage: node scripts/probe-mock-debugger-retained-bridge.mjs --manifest=/absolute/path/manifest.json");
const manifestFile = path.resolve(manifestArgument);
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
if (manifest?.kind !== "arkimux-mock-debugger-private-candidate" || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId)) {
  throw new Error("Invalid mock-debugger candidate manifest.");
}
const archive = path.join(path.dirname(manifestFile), manifest.archiveFile);
if (await sha256File(archive) !== manifest.archiveSha256) throw new Error("Candidate archive SHA-256 mismatch.");
const installedId = (await docker(["image", "inspect", manifest.imageReference, "--format", "{{.Id}}"])).stdout;
if (installedId !== manifest.imageId) throw new Error("Installed candidate image ID mismatch.");

const outputDirectory = path.join(repositoryRoot, ".codex-temp", "mock-debugger-bridge-probes", sortableTimestamp());
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const assetPath = "workflows/debug-fixture/prompts/system.txt";
const retainedAssets = { [assetPath]: Buffer.from("Pinned prompt") };
const source = `export async function createDebugFixture(context) { const prompt = new TextDecoder().decode(context.readAsset(${JSON.stringify(assetPath)}));
  return {
    agentPrompts: {},
    workflow: {
      workflow: { kind: "debug-fixture", version: 1 },
      workflowContractVersion: "debug-fixture-v1",
      resultKind: "debug-fixture-result-v1",
      input: { parse(value) { return value; } },
      output: { parse(value) { return value; } },
      async execute(_context, input) {
        const before = input.value;
        let result = before + 1;
        debugger;
        const doubled = result * 2;
        return { result, doubled, prompt };
      },
    },
  };
}
`;
const compiled = await transform(source, {
  loader: "ts",
  format: "esm",
  target: "node24",
  sourcemap: "inline",
  sourcefile: "workflows/debug-fixture/src/workflow.ts",
});
const buildSha256 = createHash("sha256").update(compiled.code).digest("hex");
const createdAt = new Date().toISOString();
const caseId = "retained-bridge";
const invocation = {
  schemaVersion: 1,
  runRef: { executionId: `mock-${caseId}` },
  workflow: { kind: "debug-fixture", version: 1 },
  workflowContractVersion: "debug-fixture-v1",
  runConfiguration: { configurationId: "mock-debug-v1", contentHash: "a".repeat(64) },
  resultKind: "debug-fixture-result-v1",
  input: { value: 10 },
  createdAt,
};
const bootstrap = {
  schemaVersion: 1,
  kind: "arkimux-mock-debugger-bootstrap",
  caseId,
  buildSha256,
  construction: { schemaVersion: 1, export: "createDebugFixture" },
  invocation,
  runConfiguration: {},
  assets: [{ path: assetPath, byteLength: retainedAssets[assetPath].byteLength,
    sha256: createHash("sha256").update(retainedAssets[assetPath]).digest("hex") }],
  mocks: {},
  expectations: [
    { id: "result", target: "result", pointer: "/result", operator: "equals", value: 20 },
    { id: "asset", target: "result", pointer: "/prompt", operator: "equals", value: "Pinned prompt" },
  ],
  stopOnEntry: true,
};
const launcherBundle = path.join(outputDirectory, "launcher.mjs");
await build({
  entryPoints: [path.join(repositoryRoot, "cli/src/dockerMockDebuggerLauncher.ts")],
  outfile: launcherBundle,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "bundle",
  sourcemap: false,
  logLevel: "silent",
});
const { launchDockerMockDebugger } = await import(pathToFileURL(launcherBundle).href);
let session;
let report;
let inspection;
let sources;
let sourceRead;
let breakpointBindings;
let continued;
let breakpointPause;
let stack;
let scopes;
let localProperties;
let evaluation;
let mutation;
let updatedEvaluation;
let updatedLocalProperties;
let stepped;
let stepPause;
let stalePauseError;
let stalePropertyError;
let staleHandleError;
let terminal;
const waitForPause = async previousPauseId => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await session.request("debug.inspect", {});
    if (snapshot?.state?.state === "action_required") throw new Error(`Debugger became unavailable: ${JSON.stringify(snapshot)}`);
    if (snapshot?.state?.state === "paused" && snapshot.state.pause?.pauseId !== previousPauseId) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a new mock debugger pause.");
};
try {
  session = await launchDockerMockDebugger({
    image: {
      sourceKind: "candidate-archive",
      manifestReference: manifest.imageReference,
      runtimeReference: manifest.imageId,
      imageIdentity: manifest.imageId,
      dockerServerVersion: "verified-by-probe",
      acquired: false,
    },
    bootstrap,
    retainedCode: compiled.code,
    retainedAssets,
  });
  report = session.ready;
  inspection = await session.request("session.inspect", {});
  sources = await session.request("debug.sources", { offset: 0, limit: 100 });
  const retainedSource = sources?.items?.find(item => item.displayPath === "workflows/debug-fixture/src/workflow.ts");
  if (!retainedSource) throw new Error("Retained source was not listed by the container bridge.");
  sourceRead = await session.request("debug.source.read", { sourceId: retainedSource.sourceId, offset: 0, limit: 262144 });
  if (Buffer.from(sourceRead.data, "base64").toString("utf8") !== source) throw new Error("Retained source bytes did not match the compiled input.");
  breakpointBindings = await session.request("debug.breakpoints.set", { breakpoints: [{
    breakpointId: "at-result", sourceId: retainedSource.sourceId, line: 13, column: 1,
  }] });
  continued = await session.request("debug.continue", { pauseId: report.pause.pauseId });
  breakpointPause = await waitForPause(report.pause.pauseId);
  const breakpointPauseId = breakpointPause.state.pause.pauseId;
  stack = await session.request("debug.stack", { pauseId: breakpointPauseId, offset: 0, limit: 100 });
  const workflowFrame = stack?.items?.find(frame => frame.kind === "workflow");
  if (!workflowFrame) throw new Error("Mapped workflow frame was not exposed at the retained breakpoint.");
  scopes = await session.request("debug.scopes", { pauseId: breakpointPauseId, frameId: workflowFrame.frameId });
  const localScope = scopes?.items?.find(scope => scope.type === "local" && scope.value?.kind === "object");
  if (!localScope) throw new Error("Local workflow scope was not exposed at the retained breakpoint.");
  localProperties = await session.request("debug.properties", {
    pauseId: breakpointPauseId, objectId: localScope.value.objectId, offset: 0, limit: 100,
  });
  evaluation = await session.request("debug.evaluate", {
    pauseId: breakpointPauseId, frameId: workflowFrame.frameId, evaluationId: "result-plus-one", expression: "result + 1",
  });
  mutation = await session.request("debug.variable.set", {
    pauseId: breakpointPauseId, frameId: workflowFrame.frameId, controlId: "set-result", name: "result", expression: "20",
  });
  updatedEvaluation = await session.request("debug.evaluate", {
    pauseId: breakpointPauseId, frameId: workflowFrame.frameId, evaluationId: "updated-result", expression: "result",
  });
  updatedLocalProperties = await session.request("debug.properties", {
    pauseId: breakpointPauseId, objectId: localScope.value.objectId, offset: 0, limit: 100,
  });
  stepped = await session.request("debug.step", { pauseId: breakpointPause.state.pause.pauseId, kind: "over" });
  stepPause = await waitForPause(breakpointPause.state.pause.pauseId);
  try {
    await session.request("debug.properties", {
      pauseId: breakpointPauseId, objectId: localScope.value.objectId, offset: 0, limit: 100,
    });
  } catch (error) {
    stalePropertyError = { code: error?.code, message: error?.message, retry: error?.retry };
  }
  try {
    await session.request("debug.properties", {
      pauseId: stepPause.state.pause.pauseId, objectId: localScope.value.objectId, offset: 0, limit: 100,
    });
  } catch (error) {
    staleHandleError = { code: error?.code, message: error?.message, retry: error?.retry };
  }
  try {
    await session.request("debug.continue", { pauseId: breakpointPause.state.pause.pauseId });
  } catch (error) {
    stalePauseError = { code: error?.code, message: error?.message, retry: error?.retry };
  }
  await session.request("debug.continue", { pauseId: stepPause.state.pause.pauseId });
  const terminalDeadline = Date.now() + 10_000;
  while (Date.now() < terminalDeadline) {
    const snapshot = await session.request("session.inspect", {});
    if (snapshot?.terminal) { terminal = snapshot.terminal; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
} finally {
  await session?.close();
  await rm(launcherBundle, { force: true });
}
if (report?.kind !== "arkimux-mock-debugger-retained-bridge" || report?.ok !== true || report?.simulated !== true
  || report?.caseId !== caseId || report?.buildSha256 !== buildSha256
  || report?.pause?.reason !== "entry" || !report?.pause?.sourceId
  || report?.sources?.items?.[0]?.displayPath !== "workflows/debug-fixture/src/workflow.ts"
  || inspection?.state?.state !== "paused" || inspection?.state?.pause?.pauseId !== report.pause.pauseId
  || sources?.total !== 1 || sourceRead?.displayPath !== "workflows/debug-fixture/src/workflow.ts"
  || breakpointBindings?.[0]?.breakpointId !== "at-result" || !["bound", "pending"].includes(breakpointBindings?.[0]?.state)
  || continued?.state !== "running" || breakpointPause?.state?.pause?.reason !== "breakpoint"
  || breakpointPause?.state?.pause?.line !== 13 || !breakpointPause?.state?.pause?.breakpointIds?.includes("at-result")
  || !stack?.items?.some(frame => frame.kind === "workflow" && frame.location?.line === 13)
  || !scopes?.items?.some(scope => scope.type === "local" && scope.value?.kind === "object")
  || !localProperties?.items?.some(item => item.name === "before" && item.value?.kind === "scalar" && item.value?.value === 10)
  || evaluation?.status !== "completed" || evaluation?.changedSimulatedState !== "unknown" || evaluation?.result?.value !== 12
  || mutation?.status !== "applied" || mutation?.changedSimulatedState !== true || mutation?.result?.value !== 20
  || updatedEvaluation?.status !== "completed" || updatedEvaluation?.result?.value !== 20
  || !updatedLocalProperties?.items?.some(item => item.name === "result" && item.value?.kind === "scalar" && item.value?.value === 20)
  || stepped?.state !== "running" || stepPause?.state?.pause?.reason !== "step"
  || stepPause?.state?.pause?.sourceId !== breakpointPause?.state?.pause?.sourceId
  || stepPause?.state?.pause?.line === breakpointPause?.state?.pause?.line
    && stepPause?.state?.pause?.column === breakpointPause?.state?.pause?.column
  || stalePauseError?.code !== "stale_pause" || stalePropertyError?.code !== "stale_pause"
  || staleHandleError?.code !== "stale_handle"
  || terminal?.status !== "passed" || terminal?.simulated !== true || terminal?.comparison?.comparison !== "pass"
  || terminal?.output?.result !== 20 || terminal?.output?.doubled !== 40 || terminal?.output?.prompt !== "Pinned prompt") {
  throw new Error(`Retained bridge control probe failed: ${JSON.stringify({ report, inspection, sources, sourceRead,
    breakpointBindings, continued, breakpointPause, stack, scopes, localProperties, evaluation, mutation,
    updatedEvaluation, updatedLocalProperties, stepped, stepPause,
    stalePauseError, stalePropertyError, staleHandleError, terminal })}`);
}
const evidence = {
  schemaVersion: 1,
  kind: "arkimux-mock-debugger-retained-bridge-evidence",
  checkedAt: new Date().toISOString(),
  manifestFile,
  imageId: manifest.imageId,
  archiveSha256: manifest.archiveSha256,
  report,
  inspection,
  sources,
  sourceRead,
  breakpointBindings,
  continued,
  breakpointPause,
  stack,
  scopes,
  localProperties,
  evaluation,
  mutation,
  updatedEvaluation,
  updatedLocalProperties,
  stepped,
  stepPause,
  stalePauseError,
  stalePropertyError,
  staleHandleError,
  terminal,
};
const evidenceFile = path.join(outputDirectory, "retained-bridge-evidence.json");
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ evidenceFile, imageId: manifest.imageId, pausedAtEntry: true, sourceRead: true,
  breakpoint: true, stack: true, scopes: true, properties: true, evaluation: true, variableMutation: true,
  stepOver: true, stalePauseRejected: true,
  stalePropertyRejected: true, staleHandleRejected: true, retainedAssetRead: true,
  terminalComparison: "pass", transport: true }, null, 2) + "\n");
