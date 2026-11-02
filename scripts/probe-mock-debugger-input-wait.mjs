import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { docker, repositoryRoot, sha256File, sortableTimestamp } from "./lib/mock-debugger-candidate.mjs";

const argument = process.argv.find(value => value.startsWith("--manifest="))?.slice("--manifest=".length);
if (!argument) throw new Error("Usage: node scripts/probe-mock-debugger-input-wait.mjs --manifest=/absolute/path/manifest.json");
const manifestFile = path.resolve(argument), manifest = JSON.parse(await readFile(manifestFile, "utf8"));
if (manifest?.kind !== "arkimux-mock-debugger-private-candidate" || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId)) throw new Error("Invalid candidate manifest.");
const archive = path.join(path.dirname(manifestFile), manifest.archiveFile);
if (await sha256File(archive) !== manifest.archiveSha256) throw new Error("Candidate archive SHA-256 mismatch.");
if ((await docker(["image", "inspect", manifest.imageReference, "--format", "{{.Id}}"]))?.stdout !== manifest.imageId) throw new Error("Installed image ID mismatch.");

const source = `export async function createFixture() {
  const form = { descriptor: { schemaVersion: 1, id: "confirmation", version: "1", fields: [
    { id: "approved", label: "Approve", required: true, type: "boolean" }
  ] }, output: { parse(value) { if (value?.fields?.approved !== true) throw new Error("Approval required"); return value; } } };
  return { agentPrompts: {}, workflow: {
    workflow: { kind: "input-fixture", version: 1 }, workflowContractVersion: "1", resultKind: "input-fixture.result",
    input: { parse(value) { return value; } }, output: { parse(value) { return value; } },
    async execute(context, input) {
      const answer = await context.steps.waitForInput({ id: "confirm", title: "Confirm", form, expiresAfter: "1h" });
      return { value: input.value, approved: answer.output.fields.approved };
    }
  } };
}`;
const compiled = await transform(source, { loader: "ts", format: "esm", target: "node24", sourcemap: "inline",
  sourcefile: "workflows/input-fixture/src/workflow.ts" });
const buildSha256 = createHash("sha256").update(compiled.code).digest("hex"), caseId = "input-wait";
const bootstrap = { schemaVersion: 1, kind: "arkimux-mock-debugger-bootstrap", caseId, buildSha256,
  construction: { schemaVersion: 1, export: "createFixture" },
  invocation: { schemaVersion: 1, runRef: { executionId: `mock-${caseId}` }, workflow: { kind: "input-fixture", version: 1 },
    workflowContractVersion: "1", runConfiguration: { configurationId: "mock-v1", contentHash: "a".repeat(64) },
    resultKind: "input-fixture.result", input: { value: 10 }, createdAt: new Date().toISOString() },
  runConfiguration: {}, assets: [], mocks: {}, expectations: [
    { id: "approved", target: "result", pointer: "/approved", operator: "equals", value: true },
  ], stopOnEntry: true };
const outputDirectory = path.join(repositoryRoot, ".codex-temp", "mock-debugger-input-wait-probes", sortableTimestamp());
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const bundle = path.join(outputDirectory, "launcher.mjs");
await build({ entryPoints: [path.join(repositoryRoot, "cli/src/dockerMockDebuggerLauncher.ts")], outfile: bundle,
  bundle: true, platform: "node", target: "node24", format: "esm", packages: "bundle", logLevel: "silent" });
const { launchDockerMockDebugger } = await import(pathToFileURL(bundle).href);
let session, suspension, invalidError, responseResult, retryResult, terminal;
try {
  session = await launchDockerMockDebugger({ image: { sourceKind: "candidate-archive", manifestReference: manifest.imageReference,
    runtimeReference: manifest.imageId, imageIdentity: manifest.imageId, dockerServerVersion: "verified-by-probe", acquired: false },
  bootstrap, retainedCode: compiled.code, retainedAssets: {} });
  await session.request("debug.continue", { pauseId: session.ready.pause.pauseId });
  const waitingDeadline = Date.now() + 10_000;
  while (Date.now() < waitingDeadline) {
    const snapshot = await session.request("session.inspect", {});
    if (snapshot?.suspension) { suspension = snapshot.suspension; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!suspension) throw new Error("Mock workflow did not suspend for input.");
  const base = { caseId, requestId: suspension.requestId, expectedRevision: 1, submissionId: "answer-1" };
  try { await session.request("case.respond", { ...base, response: { schemaVersion: 1, fields: { approved: false }, files: {} } }); }
  catch (error) { invalidError = { code: error?.code, message: error?.message }; }
  responseResult = await session.request("case.respond", { ...base, response: { schemaVersion: 1, fields: { approved: true }, files: {} } });
  retryResult = await session.request("case.respond", { ...base, response: { schemaVersion: 1, fields: { approved: true }, files: {} } });
  await session.request("debug.continue", { pauseId: responseResult.state.pause.pauseId });
  const terminalDeadline = Date.now() + 10_000;
  while (Date.now() < terminalDeadline) {
    const snapshot = await session.request("session.inspect", {});
    if (snapshot?.terminal) { terminal = snapshot.terminal; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
} finally { await session?.close(); await rm(bundle, { force: true }); }
if (suspension?.stepId !== "confirm" || suspension?.form?.id !== "confirmation" || invalidError?.code !== "invalid_response"
  || responseResult?.receipt?.submissionId !== "answer-1" || responseResult?.state?.state !== "paused"
  || retryResult?.receipt?.acceptedBodySha256 !== responseResult?.receipt?.acceptedBodySha256
  || terminal?.status !== "passed" || terminal?.output?.approved !== true || terminal?.output?.value !== 10) {
  throw new Error(`Mock input-wait probe failed: ${JSON.stringify({ suspension, invalidError, responseResult, retryResult, terminal })}`);
}
const evidence = { schemaVersion: 1, kind: "arkimux-mock-debugger-input-wait-evidence", checkedAt: new Date().toISOString(),
  manifestFile, imageId: manifest.imageId, suspension, invalidError, responseResult, retryResult, terminal };
const evidenceFile = path.join(outputDirectory, "input-wait-evidence.json");
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ evidenceFile, imageId: manifest.imageId, suspended: true, retainedValidator: true,
  idempotentResponse: true, resumedAtEntry: true, terminalComparison: "pass" }, null, 2) + "\n");
