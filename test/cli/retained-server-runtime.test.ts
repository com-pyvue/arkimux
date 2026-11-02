import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build as bundle } from "esbuild";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalRetainedServerRuntime } from "../../local/src/localRetainedServerRuntime.ts";
import { LocalWorkflowRegistryReload } from "../../local/src/workflowRegistryReload.ts";
import { createLocalPortableWorkflow } from "../../local/src/portableWorkflow.ts";
import { prepareDeclaredRetainedWorkflowBuild } from "../../cli/src/declaredRetainedWorkflowBuild.ts";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { runConfigurationContentHash } from "../../core/src/application/runConfiguration.ts";
import { runKey } from "../../core/src/application/retainedExecution.ts";
import fixtures from "../fixtures/public-workflow-contract/fixtures.json";

const roots: string[] = [], runtimes: Awaited<ReturnType<typeof createLocalRetainedServerRuntime>>[] = [];
let workerBytes: Uint8Array;
beforeAll(async () => {
  workerBytes = (await bundle({ entryPoints: [fileURLToPath(new URL("../../local/src/retainedAttemptWorker.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" })).outputFiles[0].contents;
});
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "retained-server-unit-")); roots.push(root);
  const directory = "workflows/weather-advisor", file = `${directory}/workflow.ts`, effectFile = `${directory}/effect.ts`;
  const ref = (name: string) => ({ file, export: name });
  const declaration = { manifest: `${directory}/manifest.json`, environment: `${directory}/environment.json`,
    definition: ref("defineWeatherAdvisor"), inputValidator: ref("input"), resultValidator: ref("output"),
    result: { kind: "weather-advisor.result", schemaVersion: 1 },
    effects: [{ file: effectFile, export: "createPlaceEffect" }], agentSlots: [],
    construction: { file, export: "construct", assets: [] } };
  await mkdir(path.join(root, directory), { recursive: true }); await mkdir(path.join(root, "src")); await mkdir(path.join(root, "config"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  await writeFile(path.join(root, "src/arkimux.workflows.ts"), `export const workflowDeclarations = ${JSON.stringify([declaration])}; export function loadProjectWorkflows() { throw new Error("Never used for admission"); }`);
  await writeFile(path.join(root, `${directory}/effect-contract.ts`), `
export const placeEffect = { schemaVersion: 1, operationId: "fixture.place", definitionVersion: "1", safety: "read",
  input: { parse: value => value }, output: { parse: value => value } };
`);
  await writeFile(path.join(root, effectFile), `
import { placeEffect } from "./effect-contract.js";
export function createPlaceEffect(context) { return { ...placeEffect, async execute() {
  if (context.credentials.SECRET_VALUE !== "fixture-secret") throw new Error("Effect secret was unavailable.");
  return { place: context.environment.PLACE };
} }; }
`);
  await writeFile(path.join(root, file), `
import { placeEffect } from "./effect-contract.js";
export const input = { parse(value) { if (!Number.isInteger(value.count)) throw new Error("bad input"); return { count: value.count + 1 }; } };
export const output = { parse: value => value };
const readPlace = { schemaVersion: 1, id: "read-place", definitionVersion: "1", input: { parse: value => value }, output: placeEffect.output,
  execute: (context, value) => context.effects.run(placeEffect, value) };
const resolvePlace = async context => (await context.steps.run(readPlace, null)).output.place;
export function defineWeatherAdvisor() { return { workflow: { kind: "weather-advisor", version: 1 }, workflowContractVersion: "1",
  resultKind: "weather-advisor.result", input, output, execute: async (c, value) => ({ schemaVersion: 1, count: value.count, place: await resolvePlace(c) }) }; }
export function construct(context) { if ("environment" in context || "credentials" in context) throw new Error("Workflow construction received host values.");
  return { workflow: defineWeatherAdvisor(), agentPrompts: {} }; }
`);
  const environment = { schemaVersion: 1 as const, variables: [
    { name: "PLACE", required: true, secret: false, type: "string" as const },
    { name: "SECRET_VALUE", required: true, secret: true, type: "string" as const },
  ] };
  await writeFile(path.join(root, declaration.manifest), JSON.stringify(fixtures.weather));
  await writeFile(path.join(root, declaration.environment), JSON.stringify(environment));
  // Registration must not read or require host-only effect secrets.
  await writeFile(path.join(root, ".env"), "PLACE=original\nUNDECLARED=not-retained\n");
  await copyFile(path.resolve("core/config/agent-providers.default.json"), path.join(root, "config/agent-providers.default.json"));
  const workerPath = path.join(root, "worker.mjs"); await writeFile(workerPath, workerBytes);
  const workflow = { kind: "weather-advisor", version: 1 };
  const input = { parse: (value: unknown) => value as { count: number } }, output = { parse: (value: unknown) => value as { schemaVersion: number } };
  const liveExecute = vi.fn(async () => ({ schemaVersion: 1 }));
  const registration = await createLocalPortableWorkflow({ repositoryRoot: root, workflow, title: "Weather", description: "Fixture", inputExample: { count: 1 }, input,
    environment, environmentFile: declaration.environment, manifest: fixtures.weather as never, agentSlots: [],
    maxDurationMs: fixtures.weather.executionRequirements.run.maxDurationSeconds * 1000, finalizationReserveMs: 1000,
    define: () => ({ workflow, workflowContractVersion: "1", resultKind: "weather-advisor.result", input, output, execute: liveExecute }) });
  await writeFile(path.join(root, ".env"), "PLACE=original\nSECRET_VALUE=fixture-secret\nUNDECLARED=not-retained\n");
  const prepareBuild = vi.fn(async (store: FileRetainedExecutionStoreV1, workflowId: string, hostRequirements: Record<string, string>) => {
    const built = await prepareDeclaredRetainedWorkflowBuild(store, { projectRoot: root, workflowId, hostRequirements });
    return { buildSha256: built.manifest.buildSha256, manifest: built.workflow.manifest, declaration: built.workflow.declaration };
  });
  const options = { projectRoot: root, workflows: [registration], workerPath, admission: { workflowIds: [workflow.kind], prepareBuild } };
  const configuration = { schemaVersion: 1, configurationId: "fixture-v1", workflow, agents: {} };
  const request = { actor: { userId: "local-developer", roleId: "developer" }, workflow, requestedExecutionId: "retained-fixture",
    input: { count: 1 }, resolvedConfiguration: { configuration, contentHash: runConfigurationContentHash(configuration) } };
  const stateFile = path.join(root, ".arkimux/local/retained/runs", `${runKey({ executionId: request.requestedExecutionId })}.json`);
  const state = async () => JSON.parse(await readFile(stateFile, "utf8"));
  const start = async (value = options) => { const runtime = await createLocalRetainedServerRuntime(value); runtimes.push(runtime); return runtime; };
  return { root, options, request, state, start, prepareBuild, liveExecute, file, declaration };
}

describe("private retained server composition", () => {
  it("notifies the Local session after the retained Run publishes without exposing its output", async () => {
    const f = await setup(), onRunSettled = vi.fn(async () => undefined);
    const runtime = await createLocalRetainedServerRuntime({ ...f.options, onRunSettled });
    runtimes.push(runtime);
    const candidate = await runtime.prepareCandidate(f.options.workflows, f.options.admission);
    try {
      const ref = await candidate.workflows[0].reserve(f.request);
      await runtime.recover();
      expect(onRunSettled).toHaveBeenCalledWith({ executionId: ref.executionId, status: "complete", elapsedMs: expect.any(Number) });
      expect(JSON.stringify(onRunSettled.mock.calls)).not.toMatch(/fixture-secret|original|schemaVersion/);
      expect((await f.state()).status).toBe("complete");
    } finally { await candidate.release(); }
  });
  it("admits, exposes, answers, and resumes a deferred graph entry through the Local API service", async () => {
    const f = await setup();
    const corePackage = path.join(f.root, "node_modules/@com-pyvue/agent-execution-core");
    await mkdir(path.join(corePackage, "dist"), { recursive: true });
    await copyFile(path.resolve("core/dist/index.js"), path.join(corePackage, "dist/index.js"));
    await writeFile(path.join(corePackage, "package.json"), JSON.stringify({ name: "@com-pyvue/agent-execution-core",
      type: "module", exports: { ".": "./dist/index.js" } }));
    await writeFile(path.join(f.root, f.file), `
import { defineGraphValue, defineStep, defineWorkflow, graphRef, graphStep } from "@com-pyvue/agent-execution-core";
export const input = {
  parse(value) { if (!Number.isInteger(value)) throw new Error("number required"); return value; }
};
const number = defineGraphValue({ version: "1", schema: { type: "number" }, validator: input });
export function defineWeatherAdvisor() { return {}; }
const add = defineStep({ schemaVersion: 1, id: "add", definitionVersion: "1", input, output: input,
  async execute(_context, value) { return value + 1; } });
const twice = defineStep({ schemaVersion: 1, id: "twice", definitionVersion: "1", input, output: input,
  async execute(_context, value) { return value * 2; } });
const calculate = graphStep({ id: "calculate", step: add, input: graphRef.workflowInput(), inputSchema: number.schema, outputSchema: number.schema });
const double = graphStep({ id: "double", step: twice, input: graphRef.output(calculate), inputSchema: number.schema, outputSchema: number.schema });
const graph = defineWorkflow({ workflow: { kind: "weather-advisor", version: 1 }, workflowContractVersion: "1",
  resultKind: "weather-advisor.result", input: number, nodes: [calculate, double], entry: calculate, result: double,
  invocationEntries: [
    { id: "calculate", label: "Calculate", entry: { kind: "default" } },
    { id: "double", label: "Double only", entry: { kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: "double" }] } } },
  ] });
export const output = input;
export function construct() { return { graph, agentPrompts: {} }; }
`);
    const graphRegistration = Object.assign(f.options.workflows[0], { invocationModel: "graph-entry" as const });
    const runtime = await f.start({ ...f.options, workflows: [graphRegistration] });
    await expect(runtime.workflows[0].describeInvocation?.({ actor: f.request.actor, workflow: f.request.workflow,
      resolvedConfiguration: f.request.resolvedConfiguration })).resolves.toMatchObject({ model: "graph-entry", entries: [
      { id: "calculate", label: "Calculate", nodeKind: "step", entry: { kind: "default" },
        requirements: [{ id: "entry", role: "entry-input", schema: { type: "number" } }] },
      { id: "double", label: "Double only", nodeKind: "step", entry: { kind: "selected" },
        requirements: [{ id: "entry", role: "entry-input", schema: { type: "number" } }] },
    ], graph: { schemaVersion: 1, rootScopeId: "root", nodes: expect.arrayContaining([
      expect.objectContaining({ id: "root/node/calculate", kind: "step" }),
      expect.objectContaining({ id: "root/node/double", kind: "step" }),
    ]), edges: expect.arrayContaining([expect.objectContaining({ source: "root/node/calculate", target: "root/node/double", kind: "data" })]) } });
    await expect(runtime.workflows[0].reserve({ ...f.request, requestedExecutionId: "graph-invalid-supplied", input: {
      schemaVersion: 1, acquisition: "supplied", entry: { kind: "default" }, values: { entry: "wrong" },
    } })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    const request = { ...f.request, input: { schemaVersion: 1, acquisition: "deferred",
      entry: { kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: "double" }] } }, wait: { duration: "1d" } } };
    const ref = await runtime.workflows[0].reserve(request);
    await expect(readFile(path.join(f.root, ".arkimux/local/runs", ref.executionId, "artifacts/input.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const listed = await runtime.inputRequests.list(ref), item = listed.items[0];
    if (!(item && "kind" in item && item.kind === "graph-entry")) throw new Error("Expected graph entry request.");
    expect(item).toMatchObject({ status: "pending", revision: 1, requirements: [{ id: "entry", role: "entry-input" }] });
    await expect(runtime.inputRequests.submit(ref, item.requestId, { submissionId: "graph-invalid",
      expectedRevision: item.revision, response: { schemaVersion: 1, planSha256: item.planSha256, values: { entry: "wrong" } } }, "local-developer"))
      .rejects.toMatchObject({ status: 422, code: "invalid-response" });
    expect((await f.state()).status).toBe("waiting_for_input");
    const response = await runtime.inputRequests.submit(ref, item.requestId, { submissionId: "graph-answer",
      expectedRevision: item.revision, response: { schemaVersion: 1, planSha256: item.planSha256, values: { entry: 10 } } }, "local-developer");
    expect(response).toMatchObject({ kind: "graph-entry", accepted: { acceptanceId: "graph-answer", requestId: item.requestId } });
    expect(await runtime.inputRequests.submit(ref, item.requestId, { submissionId: "graph-answer",
      expectedRevision: item.revision, response: { schemaVersion: 1, planSha256: item.planSha256, values: { entry: 10 } } }, "local-developer"))
      .toEqual(response);
    await vi.waitFor(async () => { const state = await f.state();
      if (state.status === "failed") throw new Error(JSON.stringify(state.failure));
      expect(state.status).toBe("complete"); });
    expect((await f.state()).output).toBe(20);
    expect(JSON.parse(await readFile(path.join(f.root, ".arkimux/local/runs", ref.executionId, "artifacts/input.json"), "utf8")))
      .toEqual({ schemaVersion: 1, acquisition: "supplied", entry: {
        kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: "double" }] },
      }, values: { entry: 10 } });

    const suppliedRequest = { ...f.request, requestedExecutionId: "graph-supplied", input: {
      schemaVersion: 1, acquisition: "supplied", entry: { kind: "default" }, values: { entry: 12 },
    } };
    const suppliedRef = await runtime.workflows[0].reserve(suppliedRequest);
    const suppliedFile = path.join(f.root, ".arkimux/local/retained/runs", `${runKey(suppliedRef)}.json`);
    const suppliedState = async () => JSON.parse(await readFile(suppliedFile, "utf8"));
    const admitted = await suppliedState();
    await runtime.workflows[0].execute({ runRef: suppliedRef, workflow: suppliedRequest.workflow, actor: suppliedRequest.actor,
      input: suppliedRequest.input, runConfiguration: admitted.binding.runManifest.runConfiguration });
    expect((await suppliedState()).output).toBe(26);
    expect(JSON.parse(await readFile(path.join(f.root, ".arkimux/local/runs", suppliedRef.executionId, "artifacts/input.json"), "utf8")))
      .toEqual(suppliedRequest.input);
  }, 10_000);

  it.each([false, true])("reloads away a suspended registration and resumes its original Run/build (restart before response: %s)", async restart => {
    const f = await setup();
    const source = await readFile(path.join(f.root, f.file), "utf8");
    await writeFile(path.join(f.root, f.file), source.replace("execute: async (c, value) => ({ schemaVersion: 1, count: value.count, place: await resolvePlace(c) })", `execute: async (c, value) => {
      const answer = await c.steps.waitForInput({ id: "ask", title: "City", expiresAfter: "366d", form: {
        descriptor: { schemaVersion: 1, id: "city", version: "v1", fields: [{ id: "city", label: "City", type: "text", required: true, maxLength: 50 }] },
        output: { parse: v => ({ ...v, fields: { city: v.fields.city.toUpperCase() } }) },
      } }); return { schemaVersion: 1, city: answer.output.fields.city, place: await resolvePlace(c) };
    }`));
    let runtime = await f.start();
    let owner = new LocalWorkflowRegistryReload({ isIdle: runtime.isIdle, reconcile: async () => {} });
    try {
      await owner.activateCandidate(owner.prepareCandidate(await runtime.prepareCandidate(f.options.workflows, f.options.admission)));
      const ref = await owner.withRequest(() => owner.workflows.resolve(f.request.workflow).reserve(f.request));
      await runtime.recover();
      const waiting = await f.state();
      expect(waiting.status).toBe("waiting_for_input"); expect(runtime.isIdle()).toBe(true);
      const noBuild = vi.fn(async () => { throw new Error("Removed workflow must not be reconstructed."); });
      await owner.activateCandidate(owner.prepareCandidate(await runtime.prepareCandidate([], { workflowIds: [], prepareBuild: noBuild })));
      expect(owner.workflows.list()).toEqual([]);
      await rm(path.join(f.root, "src"), { recursive: true });
      await rm(path.join(f.root, "workflows"), { recursive: true });
      if (restart) {
        await runtime.stopComputing();
        await owner.close();
        await runtime.close();
        // Reopen with an empty registry after the suspended workflow was already
        // removed. Recovery must use its existing Run binding, not current files.
        await writeFile(path.join(f.root, ".env"), "PLACE=changed-after-restart\nSECRET_VALUE=fixture-secret\n");
        runtime = await f.start({ ...f.options, workflows: [], admission: { workflowIds: [], prepareBuild: noBuild } });
        owner = new LocalWorkflowRegistryReload({ isIdle: runtime.isIdle, reconcile: async () => {} });
        await owner.activateCandidate(owner.prepareCandidate(await runtime.prepareCandidate([], { workflowIds: [], prepareBuild: noBuild })));
        await runtime.recover();
        expect(owner.workflows.list()).toEqual([]);
        expect((await f.state()).status).toBe("waiting_for_input");
        expect((await f.state()).binding).toEqual(waiting.binding);
      }
      const request = (await runtime.inputRequests.list(ref)).items[0];
      if (!(request && "definition" in request)) throw new Error("Expected workflow input request.");
      const response = await owner.withRequest(() => runtime.inputRequests.submit(ref, request.definition.requestId,
        { submissionId: "after-removal", expectedRevision: request.revision,
          response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "local-developer"));
      expect(response.runRef).toEqual(ref);
      await vi.waitFor(async () => expect((await f.state()).status).toBe("complete"));
      const complete = await f.state();
      expect(complete.binding).toEqual(waiting.binding);
      expect(complete.output).toEqual({ schemaVersion: 1, city: "ISTANBUL", place: "original" });
      expect(noBuild).not.toHaveBeenCalled(); expect(f.prepareBuild).toHaveBeenCalledOnce();
      expect(f.liveExecute).not.toHaveBeenCalled();
    } finally { await runtime.stopComputing(); await owner.close(); }
  });

  it("prepares a last-good generation before any Run and executes it after source becomes invalid", async () => {
    const f = await setup(), runtime = await f.start();
    const candidate = await runtime.prepareCandidate(f.options.workflows, f.options.admission);
    try {
      expect(f.prepareBuild).toHaveBeenCalledOnce();
      await writeFile(path.join(f.root, "src/arkimux.workflows.ts"), "this is invalid source!");
      await writeFile(path.join(f.root, f.file), "this implementation is invalid too!");
      f.prepareBuild.mockRejectedValue(new Error("New source cannot be loaded"));
      const ref = await candidate.workflows[0].reserve(f.request);
      await runtime.recover();
      expect(ref.executionId).toBe(f.request.requestedExecutionId);
      expect((await f.state()).status).toBe("complete");
      expect((await f.state()).output).toEqual({ schemaVersion: 1, count: 2, place: "original" });
      expect(f.prepareBuild).toHaveBeenCalledOnce();
      expect(f.liveExecute).not.toHaveBeenCalled();
    } finally { await candidate.release(); }
  });

  it("rejects a bad prepared candidate without replacing the active generation or leaking holds", async () => {
    const f = await setup(), runtime = await f.start();
    const candidate = await runtime.prepareCandidate(f.options.workflows, f.options.admission);
    const previous = f.prepareBuild.getMockImplementation()!;
    f.prepareBuild.mockImplementation(async (...args) => {
      const build = await previous(...args);
      return { ...build, declaration: { ...build.declaration, result: { kind: "other.result", schemaVersion: 1 } } };
    });
    try {
      await expect(runtime.prepareCandidate(f.options.workflows, f.options.admission)).rejects.toThrow("differs from candidate");
      await candidate.workflows[0].reserve(f.request);
      await runtime.recover();
      expect((await f.state()).status).toBe("complete");
    } finally { await candidate.release(); }
  });

  it("accepts a retained answer after restart with current source and registry removed", async () => {
    const f = await setup();
    const source = await readFile(path.join(f.root, f.file), "utf8");
    await writeFile(path.join(f.root, f.file), source.replace("execute: async (c, value) => ({ schemaVersion: 1, count: value.count, place: await resolvePlace(c) })", `execute: async (c, value) => {
      const answer = await c.steps.waitForInput({ id: "ask", title: "City", expiresAfter: "366d", form: {
        descriptor: { schemaVersion: 1, id: "city", version: "v1", fields: [{ id: "city", label: "City", type: "text", required: true, maxLength: 50 }] },
        output: { parse: v => ({ ...v, fields: { city: v.fields.city.toUpperCase() } }) },
      } }); return { schemaVersion: 1, city: answer.output.fields.city, place: await resolvePlace(c) };
    }`));
    const first = await f.start();
    const ref = await first.workflows[0].reserve(f.request); await first.recover();
    expect((await f.state()).status).toBe("waiting_for_input"); await first.close();
    await rm(path.join(f.root, "src"), { recursive: true });
    await rm(path.join(f.root, "workflows"), { recursive: true });
    const prepareBuild = vi.fn(() => { throw new Error("Never replace the retained build"); });
    const restarted = await f.start({ ...f.options, workflows: [], admission: { workflowIds: [], prepareBuild } });
    await restarted.recover();
    const request = (await restarted.inputRequests.list(ref)).items[0];
    if (!(request && "definition" in request)) throw new Error("Expected workflow input request.");
    const response = await restarted.inputRequests.submit(ref, request.definition.requestId, { submissionId: "after-restart", expectedRevision: request.revision,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "local-developer");
    expect(response.runRef).toEqual(ref);
    await vi.waitFor(async () => expect((await f.state()).status).toBe("complete"));
    expect((await f.state()).output).toEqual({ schemaVersion: 1, city: "ISTANBUL", place: "original" });
    expect(prepareBuild).not.toHaveBeenCalled(); expect(f.liveExecute).not.toHaveBeenCalled();
  });

  it("pins the existing configuration, startup environment and limits, then executes only the retained constructor", async () => {
    const f = await setup(), runtime = await f.start(), registration = runtime.workflows[0];
    await writeFile(path.join(f.root, ".env"), "PLACE=changed\nSECRET_VALUE=fixture-secret\n");
    const ref = await registration.reserve(f.request), saved = await f.state();
    expect(saved.binding.nonSecretEnvironment).toEqual({ PLACE: "original" });
    expect(saved.binding.effectSecretNames).toEqual(["SECRET_VALUE"]);
    expect(JSON.stringify(saved)).not.toContain("fixture-secret");
    expect(saved.binding.credentialReferences).toEqual([]);
    expect(saved.binding.runConfiguration).toEqual(f.request.resolvedConfiguration.configuration);
    expect(saved.binding.executionProfile.computeLimits.totalMs).toBe(fixtures.weather.executionRequirements.run.maxDurationSeconds * 1000);
    await registration.execute({ runRef: ref, workflow: f.request.workflow, actor: f.request.actor,
      input: f.request.input, runConfiguration: saved.binding.runManifest.runConfiguration });
    const complete = await f.state();
    expect(complete.status).toBe("complete");
    expect(complete.output).toEqual({ schemaVersion: 1, count: 2, place: "original" });
    expect(f.liveExecute).not.toHaveBeenCalled();
  });

  it("recovers an admitted Run with no registry or source and releases the writer on close", async () => {
    const f = await setup(), first = await f.start();
    await first.workflows[0].reserve(f.request);
    await first.close();
    await rm(path.join(f.root, "src"), { recursive: true });
    await rm(path.join(f.root, "workflows"), { recursive: true });
    const prepareBuild = vi.fn(() => { throw new Error("Recovery must not prepare a build"); });
    const restarted = await f.start({ ...f.options, workflows: [], admission: { workflowIds: [], prepareBuild } });
    await Promise.all([restarted.recover(), restarted.recover()]);
    expect((await f.state()).status).toBe("complete");
    expect(prepareBuild).not.toHaveBeenCalled();
    await restarted.close();
    const store = await FileRetainedExecutionStoreV1.open(path.join(f.root, ".arkimux/local/retained")); await store.close();
  });

  it("leaves registrations without a construction selection on their existing path", async () => {
    const f = await setup();
    const runtime = await f.start({ ...f.options, admission: { ...f.options.admission, workflowIds: [] } });
    expect(runtime.workflows[0]).toBe(f.options.workflows[0]);
    expect(f.prepareBuild).not.toHaveBeenCalled();
  });

  it("rejects unknown or repeated selections without leaking the store lock", async () => {
    const f = await setup();
    await expect(f.start({ ...f.options, admission: { ...f.options.admission, workflowIds: ["missing"] } })).rejects.toThrow("selection");
    await expect(f.start({ ...f.options, admission: { ...f.options.admission, workflowIds: ["weather-advisor", "weather-advisor"] } })).rejects.toThrow("selection");
    await f.start();
  });

  it("rejects invalid input before creating a retained Run", async () => {
    const f = await setup(), runtime = await f.start();
    await expect(runtime.workflows[0].reserve({ ...f.request, input: { count: "invalid" as never } })).rejects.toMatchObject({ status: 400 });
    await expect(f.state()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports source/build failures as an actionable admission conflict without exposing source data", async () => {
    const f = await setup();
    f.prepareBuild.mockRejectedValue(new Error("PRIVATE_SOURCE_DATA"));
    const runtime = await f.start();
    await expect(runtime.workflows[0].reserve(f.request)).rejects.toMatchObject({ status: 409,
      message: "The retained workflow could not be prepared. Validate the project and restart the Local server before submitting a Run." });
    await expect(f.state()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses changed declaration metadata before reservation", async () => {
    const f = await setup(), original = f.prepareBuild.getMockImplementation()!;
    f.prepareBuild.mockImplementation(async (...args) => {
      const built = await original(...args); return { ...built, declaration: { ...built.declaration, result: { kind: "other.result", schemaVersion: 1 } } };
    });
    const runtime = await f.start();
    await expect(runtime.workflows[0].reserve(f.request)).rejects.toMatchObject({ status: 409 });
    await expect(f.state()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a result with the wrong declared payload version instead of publishing it", async () => {
    const f = await setup();
    const source = await readFile(path.join(f.root, f.file), "utf8");
    await writeFile(path.join(f.root, f.file), source.replace("schemaVersion: 1, count: value.count, place:", "schemaVersion: 2, count: value.count, place:"));
    const runtime = await f.start();
    await runtime.workflows[0].reserve(f.request);
    await runtime.recover();
    expect((await f.state()).status).toBe("failed");
    await expect(readFile(path.join(f.root, ".arkimux/local/runs", f.request.requestedExecutionId, "weather-advisor.result.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels an active retained Run and publishes a distinct cancelled state", async () => {
    const f = await setup();
    const source = await readFile(path.join(f.root, f.file), "utf8");
    await writeFile(path.join(f.root, f.file), source.replace(
      "({ schemaVersion: 1, count: value.count, place: await resolvePlace(c) })",
      "new Promise(() => {})",
    ));
    const runtime = await f.start();
    const registration = runtime.workflows[0];
    const runRef = await registration.reserve(f.request);
    const recovery = runtime.recover().catch(error => error);
    await vi.waitFor(async () => expect((await f.state()).owner).not.toBeNull());

    await registration.cancel!(runRef);
    await recovery;
    expect(await f.state()).toMatchObject({ status: "cancelled", owner: null });
    const publicStatus = JSON.parse(await readFile(path.join(
      f.root, ".arkimux/local/runs", runRef.executionId, "state/run-status.json",
    ), "utf8"));
    expect(publicStatus).toMatchObject({ status: "cancelled" });
    await runtime.close();
  });

  it("waits for a cancelled admission before releasing its store", async () => {
    const f = await setup(), original = f.prepareBuild.getMockImplementation()!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepared = new Promise<void>(resolve => { entered = resolve; });
    f.prepareBuild.mockImplementation(async (...args) => { const built = await original(...args); entered(); await gate; return built; });
    const runtime = await f.start();
    const admission = runtime.workflows[0].reserve(f.request).catch(error => error);
    await prepared;
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    expect(await admission).toBeInstanceOf(Error);
    await closing;
    await expect(f.state()).rejects.toMatchObject({ code: "ENOENT" });
    const store = await FileRetainedExecutionStoreV1.open(path.join(f.root, ".arkimux/local/retained")); await store.close();
  });

  it("cancels and reaps an active recovered worker before closing storage", async () => {
    const f = await setup();
    const source = await readFile(path.join(f.root, f.file), "utf8");
    await writeFile(path.join(f.root, f.file), source.replace("({ schemaVersion: 1, count: value.count, place: await resolvePlace(c) })", "new Promise(() => {})"));
    const runtime = await f.start();
    await runtime.workflows[0].reserve(f.request);
    const recovery = runtime.recover().catch(error => error);
    await vi.waitFor(async () => expect((await f.state()).owner).not.toBeNull());
    await runtime.close();
    await recovery;
    const state = await f.state();
    expect(state.owner).toBeNull();
    expect(state.status).toBe("cancelled");
    expect(state.compute.certainty).toBe("known");
    const store = await FileRetainedExecutionStoreV1.open(path.join(f.root, ".arkimux/local/retained")); await store.close();
  });
});
