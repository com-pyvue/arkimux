import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { FileWorkflowRunConfigurationStore } from "../../core/src/infrastructure/storage/fileWorkflowRunConfigurationStore.ts";
import { prepareDockerMockDebuggerSession, prepareHeadlessDebuggerSession } from "../../cli/src/prepareHeadlessDebugger.ts";
import { createPreparedDockerMockDebuggerCoordinator } from "../../cli/src/dockerMockDebuggerCoordinator.ts";
import { HeadlessDebuggerError, type HeadlessManifest, type HeadlessManifestV2 } from "../../local/src/headlessDebuggerContracts.ts";

const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const authorization = { executeProjectCode: true, allowProviderCharges: true, allowExternalEffects: true, discloseWorkflowData: true } as const;
const policy = { timeoutMs: 1000, execution: { provider: "codex-cli", authProvider: "codex-native-session", parameters: {} } };
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "headless-preparation-unit-")); roots.push(root);
  const directory = "workflows/fixture", source = `${directory}/workflow.ts`, asset = `${directory}/prompts/system.txt`;
  await mkdir(path.join(root, directory, "run-configurations"), { recursive: true }); await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, directory, "prompts"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  const ref = (name: string) => ({ file: source, export: name });
  const declaration = { manifest: `${directory}/manifest.json`, environment: `${directory}/environment.json`,
    definition: ref("defineWorkflow"), inputValidator: ref("input"), resultValidator: ref("output"),
    result: { kind: "fixture.result", schemaVersion: 1 }, agentSlots: ["author"], effects: [],
    construction: { ...ref("construct"), assets: [asset] } };
  await writeFile(path.join(root, "src/arkimux.workflows.ts"), `export const workflowDeclarations = ${JSON.stringify([declaration])};
    throw new Error("REGISTRY MUST NOT EXECUTE"); export function loadProjectWorkflows() { throw new Error("FACTORY MUST NOT EXECUTE"); }`);
  await writeFile(path.join(root, source), `export const input = { parse: value => value }; export const output = input;
    export function defineWorkflow() { throw new Error("DEFINITION MUST NOT EXECUTE DURING PREPARATION"); }
    export function construct() { throw new Error("CONSTRUCTOR MUST NOT EXECUTE DURING PREPARATION"); }`);
  await writeFile(path.join(root, asset), "Pinned prompt");
  const workflowManifest = { schemaVersion: 1, workflowId: "fixture", workflowMode: "arkimux-portable", workflowContractVersion: "1",
    requiredCapabilities: ["agent-slot-invocation@1", "typed-results@1"],
    executionRequirements: { schemaVersion: 1, run: { maxDurationSeconds: 60 }, operations: {} }, sourceBindings: [] };
  await writeFile(path.join(root, declaration.manifest), JSON.stringify(workflowManifest));
  await writeFile(path.join(root, declaration.environment), JSON.stringify({ schemaVersion: 1,
    variables: [{ name: "CITY", required: true, secret: false, type: "string" }] }));
  await writeFile(path.join(root, ".env"), "CITY=Istanbul\nANTHROPIC_API_KEY=PRIVATE_KEY_SENTINEL\n");
  const configuration = { schemaVersion: 1, configurationId: "fixture-v1", workflow: { kind: "fixture", version: 1 }, agents: { author: policy } };
  const configFile = path.join(root, directory, "run-configurations/codex-native-v1.json");
  await writeFile(configFile, JSON.stringify(configuration));
  const store = await FileRetainedExecutionStoreV1.open(path.join(root, "diagnostic-storage")); stores.push(store);
  const configurationStore = new FileWorkflowRunConfigurationStore(path.join(root, ".arkimux/local/configuration/run-configurations"));
  const manifest: HeadlessManifest = { schemaVersion: 1, sessionId: "check", workflowId: "fixture", configurationId: "fixture-v1",
    cases: [{ caseId: "first", input: { count: 1 }, expectations: [] }] };
  return { root, store, declaration, workflowManifest, configuration, configurationStore, configFile,
    options: { projectRoot: root, store, manifest, authorization, hostRequirements: { node: "22" } } };
}

describe("headless debugger checked session preparation", () => {
  it("verifies the Docker image before retaining source and returns only Docker-safe retained inputs", async () => {
    const f = await setup();
    // Docker cases use declared mocks. They must remain preparable without
    // resolving even required host environment values.
    await rm(path.join(f.root, ".env"));
    const image = { sourceKind: "registry" as const,
      manifestReference: `arkimux/mock-debugger@sha256:${"a".repeat(64)}`,
      runtimeReference: `arkimux/mock-debugger@sha256:${"a".repeat(64)}`,
      imageIdentity: `sha256:${"a".repeat(64)}`, dockerServerVersion: "test", acquired: false };
    const ensureImage = vi.fn(async () => image);
    const manifest: HeadlessManifestV2 = { schemaVersion: 2, sessionId: "docker-check", workflowId: "fixture",
      configurationId: "fixture-v1", debug: { stopOnEntry: true }, cases: [{ caseId: "first", input: { count: 1 }, mocks: {}, expectations: [] }] };
    const prepared = await prepareDockerMockDebuggerSession({ projectRoot: f.root, store: f.store, manifest,
      authorization: { executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true, allowSimulatedEvaluation: true },
      hostRequirements: { node: "24" }, imageSource: { kind: "registry", imageReference: image.manifestReference }, ensureImage });
    expect(ensureImage).toHaveBeenCalledOnce();
    expect(prepared).toMatchObject({ image, workflow: { kind: "fixture", version: 1 },
      configuration: { configurationId: "fixture-v1", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      construction: { schemaVersion: 1, export: "construct" }, retainedAssets: { [f.declaration.construction.assets[0]]: expect.any(Uint8Array) } });
    expect(Buffer.from(prepared.retainedAssets[f.declaration.construction.assets[0]]).toString("utf8")).toBe("Pinned prompt");
    expect(prepared.retainedCode).toContain("construct");
    expect(JSON.stringify(prepared)).not.toContain("CITY");

    const launch = vi.fn(async input => ({ containerName: "mock-case", imageIdentity: input.image.imageIdentity,
      ready: { pause: { pauseId: "entry-pause" } },
      async request(method: string) { return method === "session.inspect"
        ? { state: { state: "paused", pause: { pauseId: "entry-pause" } }, terminal: null } : { applied: true }; },
      async close() {},
    }));
    let preparationDirectory = "";
    const coordinator = await createPreparedDockerMockDebuggerCoordinator({ projectRoot: f.root,
      hostRequirements: { node: "24" }, imageSource: { kind: "registry", imageReference: image.manifestReference },
      ensureImage, launch: launch as any,
      makePreparationDirectory: async () => { preparationDirectory = await mkdtemp(path.join(tmpdir(), "docker-preparation-unit-")); return preparationDirectory; },
      removePreparationDirectory: async directory => { await rm(directory, { recursive: true, force: true }); },
    });
    await coordinator.request("session.create", { manifest, authorization: {
      executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true, allowSimulatedEvaluation: true,
    } }, 2);
    await expect(coordinator.request("case.run", { caseId: "first" }, 2)).resolves.toMatchObject({ state: "paused" });
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0]).toMatchObject({ image, retainedAssets: {
      [f.declaration.construction.assets[0]]: expect.any(Uint8Array),
    }, bootstrap: { assets: [{ path: f.declaration.construction.assets[0] }] } });
    await coordinator.close();
    await expect(readFile(path.join(preparationDirectory, "retained"))).rejects.toMatchObject({ code: "ENOENT" });

    const unavailable = new HeadlessDebuggerError("debugger_unavailable", "Docker unavailable.", "after_action");
    await expect(prepareDockerMockDebuggerSession({ projectRoot: path.join(f.root, "missing"), store: f.store, manifest,
      authorization: { executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true, allowSimulatedEvaluation: true },
      hostRequirements: { node: "24" }, imageSource: { kind: "registry", imageReference: image.manifestReference },
      ensureImage: async () => { throw unavailable; } })).rejects.toBe(unavailable);
  });

  it("pins the exact included configuration, declared variables and default budget without executing code or probing providers", async () => {
    const f = await setup(); vi.stubGlobal("fetch", () => { throw new Error("NO NETWORK"); });
    const prepared = await prepareHeadlessDebuggerSession(f.options);
    expect(prepared).toMatchObject({ workflow: { kind: "fixture", version: 1 }, configuration: f.configuration,
      workflowContractVersion: "1", resultKind: "fixture.result", agentSlotIds: ["author"], nonSecretEnvironment: { CITY: "Istanbul" },
      credentialReferences: ["codex-native-session"], executionProfile: { maxScratchBytes: 16 * 1024 * 1024,
        computeLimits: { totalMs: 60000, attemptMs: 60000, finalizationReserveMs: 5000 } } });
    expect(JSON.stringify(prepared)).not.toContain("PRIVATE_KEY_SENTINEL");
    expect(prepared.buildVersion).toMatch(/^\d{8}T\d{6}\.\d{3}Z-[a-f0-9]{16}$/);
    const again = await prepareHeadlessDebuggerSession(f.options);
    expect(again.buildSha256).toBe(prepared.buildSha256); expect(again.buildVersion).toBe(prepared.buildVersion);
    expect(await f.store.listRuns()).toEqual([]);
    expect(await readFile(path.join(f.root, ".env"), "utf8")).toContain("PRIVATE_KEY_SENTINEL");
  });
  it("requires explicit increase authorization, allows shorter budgets, and keeps the reserve inside the budget", async () => {
    const f = await setup();
    const larger = { ...f.options, manifest: { ...f.options.manifest, executionBudgetMs: 180000 } };
    await expect(prepareHeadlessDebuggerSession(larger)).rejects.toMatchObject({ code: "authorization_required" });
    expect((await prepareHeadlessDebuggerSession({ ...larger, authorization: { ...authorization, increaseExecutionBudget: true } }))
      .executionProfile.computeLimits).toEqual({ totalMs: 180000, attemptMs: 180000, finalizationReserveMs: 5000 });
    expect((await prepareHeadlessDebuggerSession({ ...f.options, manifest: { ...f.options.manifest, executionBudgetMs: 1234 } }))
      .executionProfile.computeLimits).toEqual({ totalMs: 1234, attemptMs: 1234, finalizationReserveMs: 123 });
    expect((await prepareHeadlessDebuggerSession({ ...f.options, manifest: { ...f.options.manifest, executionBudgetMs: 10 } }))
      .executionProfile.computeLimits).toEqual({ totalMs: 10, attemptMs: 10, finalizationReserveMs: 1 });
  });
  it("prefers a published configuration and rejects archive instead of falling back to included defaults", async () => {
    const f = await setup();
    const published = { ...f.configuration, agents: { author: { ...policy, timeoutMs: 2000 } } };
    await f.configurationStore.publish(published);
    expect((await prepareHeadlessDebuggerSession(f.options)).configuration).toEqual(published);
    await f.configurationStore.archive(published.workflow, published.configurationId);
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toMatchObject({ code: "configuration_invalid" });
  });
  it("rejects an ID ambiguous across published workflow versions", async () => {
    const f = await setup();
    await f.configurationStore.publish(f.configuration);
    await f.configurationStore.publish({ ...f.configuration, workflow: { kind: "fixture", version: 2 } });
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toThrow("multiple workflow versions");
  });
  it("does not revive an incomplete archived published configuration from an included default", async () => {
    const f = await setup();
    await f.configurationStore.publish(f.configuration);
    await f.configurationStore.archive(f.configuration.workflow, f.configuration.configurationId);
    await rm(path.join(f.root, ".arkimux/local/configuration/run-configurations/fixture/1/fixture-v1/definition.json"));
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toThrow("published Run Configuration is incomplete");
  });
  it("rejects duplicate included IDs, even when both files contain the same configuration", async () => {
    const f = await setup();
    await writeFile(path.join(path.dirname(f.configFile), "duplicate.json"), JSON.stringify(f.configuration));
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toThrow("Multiple included files");
  });
  it.each(["missing-slot", "extra-slot", "invalid-policy", "wrong-workflow", "wrong-id"])("rejects invalid Run Configuration: %s", async mode => {
    const f = await setup();
    const changed = mode === "missing-slot" ? { ...f.configuration, agents: {} }
      : mode === "extra-slot" ? { ...f.configuration, agents: { ...f.configuration.agents, other: policy } }
      : mode === "invalid-policy" ? { ...f.configuration, agents: { author: { ...policy, timeoutMs: 0 } } }
      : mode === "wrong-workflow" ? { ...f.configuration, workflow: { kind: "other", version: 1 } }
      : { ...f.configuration, configurationId: "other-v1" };
    await writeFile(f.configFile, JSON.stringify(changed));
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(await f.store.listRuns()).toEqual([]);
  });
  it("does not scan other workflows or shell environment for missing configuration and variables", async () => {
    const f = await setup();
    await f.configurationStore.publish({ ...f.configuration, workflow: { kind: "other", version: 1 } });
    await rm(f.configFile);
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toMatchObject({ code: "configuration_invalid" });
    await writeFile(f.configFile, JSON.stringify(f.configuration));
    await writeFile(path.join(f.root, ".env"), ""); vi.stubEnv("CITY", "Shell city");
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toMatchObject({ code: "project_invalid" });
  });
  it.each(["configuration", "environment"])("rejects symlinked %s data", async kind => {
    const f = await setup(), target = path.join(f.root, "outside.json"), file = kind === "configuration" ? f.configFile : path.join(f.root, ".env");
    await writeFile(target, await readFile(file)); await rm(file); await symlink(target, file);
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toMatchObject({ code: kind === "configuration" ? "configuration_invalid" : "project_invalid" });
  });
  it("rejects unsafe IDs, oversized configuration and already-cancelled preparation", async () => {
    const f = await setup();
    await expect(prepareHeadlessDebuggerSession({ ...f.options, manifest: { ...f.options.manifest, workflowId: "../fixture" } }))
      .rejects.toMatchObject({ code: "project_invalid" });
    await expect(prepareHeadlessDebuggerSession({ ...f.options, manifest: { ...f.options.manifest, configurationId: "../fixture-v1" } }))
      .rejects.toMatchObject({ code: "configuration_invalid" });
    await writeFile(f.configFile, " ".repeat(1024 * 1024 + 1));
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(prepareHeadlessDebuggerSession({ ...f.options, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "preparation_incomplete" });
  });
  it("rejects an unsafe millisecond default without changing the workflow manifest", async () => {
    const f = await setup();
    const changed = { ...f.workflowManifest, executionRequirements: { ...f.workflowManifest.executionRequirements,
      run: { maxDurationSeconds: Number.MAX_SAFE_INTEGER } } };
    await writeFile(path.join(f.root, f.declaration.manifest), JSON.stringify(changed));
    await expect(prepareHeadlessDebuggerSession(f.options)).rejects.toThrow("safe integer");
    expect(JSON.parse(await readFile(path.join(f.root, f.declaration.manifest), "utf8"))).toEqual(changed);
  });
});
