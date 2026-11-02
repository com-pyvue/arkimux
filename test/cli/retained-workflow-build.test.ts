import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { prepareRetainedWorkflowBuild } from "../../cli/src/retainedWorkflowBuild.ts";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { loadRetainedWorkflowSource } from "../../local/src/retainedWorkflowSource.ts";
import { LocalRetainedWorkflowRunnerV1 } from "../../local/src/localRetainedWorkflowRunner.ts";

const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
async function project(source = 'import { message } from "./helper.js"; export const result = message;') {
  const root = await mkdtemp(path.join(tmpdir(), "retained-build-")); roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  await writeFile(path.join(root, "src/entry.ts"), source);
  await writeFile(path.join(root, "src/helper.ts"), 'export const message: string = "original";');
  await writeFile(path.join(root, "src/prompt.md"), "A declared prompt.");
  await writeFile(path.join(root, ".env"), "SECRET_SHOULD_NOT_APPEAR=private-fixture-value");
  await writeFile(path.join(root, "vite.config.js"), 'throw new Error("Project config must not execute");');
  const store = await FileRetainedExecutionStoreV1.open(path.join(root, "private-store")); stores.push(store);
  const options = { projectRoot: root, entryPoint: "src/entry.ts", assets: ["src/prompt.md"], hostRequirements: { node: "22.19.0" } };
  return { root, store, options };
}
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("retained workflow build preparation", () => {
  it("retains full TypeScript mappings without changing regex/template literal behavior", async () => {
    const source = 'export function workflow(input: number) {\n const before = input;\n const result = before + 1;\n return { result, pattern: /[/*]/.test("/"), text: `// untouched ${input}` };\n}\n';
    const f = await project(source), built = await prepareRetainedWorkflowBuild(f.store, f.options);
    const retained = await f.store.readBuild(built.manifest.buildSha256), code = Buffer.from(retained.files["entry.mjs"]).toString();
    const map = JSON.parse(Buffer.from(/sourceMappingURL=data:application\/json;base64,([^\s]+)/.exec(code)![1], "base64").toString());
    expect(map.sources).toContain("arkimux-source:///src/entry.ts");
    expect(map.sourcesContent).toContain(source);
    expect(map.mappings.length).toBeGreaterThan(0);
    expect(JSON.stringify(map)).not.toContain(f.root);
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    expect(module.workflow(2)).toEqual({ result: 3, pattern: true, text: "// untouched 2" });
  });
  it("constructs initial and resumed attempts from the same bundled factory, dependencies, assets and settings", async () => {
    const source = await readFile(fileURLToPath(new URL("../core/fixtures/input-workflow.mjs", import.meta.url)), "utf8");
    const f = await project(`import { message } from "./helper.js";\n${source.replace('marker: "original"', 'marker: message')}`);
    const options = { ...f.options, constructionExport: "createInputWorkflow" };
    const original = await prepareRetainedWorkflowBuild(f.store, options);
    const ref = { executionId: "constructed-run" }, limits = { totalMs: 120000, attemptMs: 60000, finalizationReserveMs: 1000 };
    const invocation = { schemaVersion: 1, runRef: ref, workflow: { kind: "input-demo", version: 1 }, workflowContractVersion: "input-demo-v1",
      resultKind: "input-demo-result-v1", runConfiguration: { configurationId: "config-v1", contentHash: "a".repeat(64) },
      input: { city: "original" }, createdAt: new Date().toISOString() };
    const binding = { id: "original-binding", buildSha256: original.manifest.buildSha256, workflow: invocation.workflow, invocation,
      runConfiguration: { marker: "original-config" }, nonSecretEnvironment: { SETTING: "original-env" },
      executionProfile: { maxScratchBytes: 1048576 }, credentialReferences: ["credential-ref"], hostRequirements: f.options.hostRequirements };
    await f.store.createRun(ref, binding);
    const workerPath = path.join(f.root, "private-worker.mjs");
    await bundle({ entryPoints: [fileURLToPath(new URL("../../local/src/retainedAttemptWorker.ts", import.meta.url))], outfile: workerPath,
      bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const prompts: unknown[] = []; let calls = 0, closed = 0;
    const runner = (store: FileRetainedExecutionStoreV1) => new LocalRetainedWorkflowRunnerV1({ store, projectRoot: f.root, workerPath,
      prepareAgents: async (pinned, _signal, constructedPrompts) => {
        prompts.push(constructedPrompts); expect(pinned.runConfiguration).toEqual({ marker: "original-config" });
        return { bindings: { author: { providerId: "fixture", authProviderId: "credential-ref", model: "fixed", configurationSha256: "a".repeat(64) } },
          invoke: async request => { calls++; return { output: request.operation.output.parse({ call: calls }) }; },
          close: async () => { closed++; } };
      } });
    expect((await runner(f.store).execute(ref, limits, f.options.hostRequirements)).status).toBe("suspended");
    expect(calls).toBe(1); expect(closed).toBe(1);
    const request = Object.values((await f.store.read(ref))!.requests)[0].definition;
    await writeFile(path.join(f.root, "src/helper.ts"), 'export const message = "edited-code";');
    await writeFile(path.join(f.root, "src/prompt.md"), "Edited prompt");
    const edited = await prepareRetainedWorkflowBuild(f.store, options);
    expect(edited.manifest.buildSha256).not.toBe(original.manifest.buildSha256);
    // Run data is immutable even if the caller's old configuration object changes.
    binding.runConfiguration.marker = "edited-config"; binding.nonSecretEnvironment.SETTING = "edited-env";
    await rm(path.join(f.root, "src"), { recursive: true });
    await f.store.close();
    const restarted = await FileRetainedExecutionStoreV1.open(path.join(f.root, "private-store")); stores.push(restarted);
    await restarted.submit(ref, request.requestId, { submissionId: "answer", expectedRevision: 1,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } }, "developer", async (_request, response) => response);
    const result = await runner(restarted).execute(ref, limits, f.options.hostRequirements);
    expect(result.status).toBe("completed"); expect(calls).toBe(2); expect(closed).toBe(2);
    expect(prompts).toEqual([{ author: "A declared prompt." }, { author: "A declared prompt." }]);
    if (result.status === "completed") expect(result.output).toMatchObject({ before: { call: 1 }, after: { call: 2 }, marker: "original",
      originalInput: { city: "original" }, construction: { config: "original-config", prompt: "A declared prompt." } });
  });
  it("pins the selected construction export and rejects missing exports before publication", async () => {
    const f = await project('export function first() { return {}; } export function second() { return {}; }');
    await expect(prepareRetainedWorkflowBuild(f.store, { ...f.options, constructionExport: "missing" })).rejects.toThrow("construction export");
    expect((await f.store.previewBuildCleanup()).builds).toHaveLength(0);
    const first = await prepareRetainedWorkflowBuild(f.store, { ...f.options, constructionExport: "first" });
    const again = await prepareRetainedWorkflowBuild(f.store, { ...f.options, constructionExport: "first" });
    const second = await prepareRetainedWorkflowBuild(f.store, { ...f.options, constructionExport: "second" });
    expect(again.reused).toBe(true); expect(again.manifest.buildSha256).toBe(first.manifest.buildSha256);
    expect(second.manifest.buildSha256).not.toBe(first.manifest.buildSha256);
    const retained = await f.store.readBuild(first.manifest.buildSha256);
    expect(JSON.parse(Buffer.from(retained.files["construction.json"]).toString())).toEqual({ schemaVersion: 1, export: "first" });
  });
  it("retains a real Core defineStep import without a monorepo fallback", async () => {
    const f = await project('import { defineStep } from "@com-pyvue/agent-execution-core"; export const step = defineStep({ schemaVersion: 1, id: "compute", definitionVersion: "v1", input: { parse: value => value }, output: { parse: value => value }, execute: async (_context, value) => value });');
    const directory = path.join(f.root, "node_modules/@com-pyvue/agent-execution-core"); await mkdir(directory, { recursive: true });
    // Match core/build.mjs in a private fixture, not a potentially stale checkout dist.
    await bundle({ entryPoints: [fileURLToPath(new URL("../../core/src/index.ts", import.meta.url))],
      outfile: path.join(directory, "index.js"), bundle: true, platform: "node", target: "node20",
      format: "esm", sourcemap: false, packages: "bundle", logLevel: "silent" });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@com-pyvue/agent-execution-core", type: "module", exports: "./index.js" }));
    const result = await prepareRetainedWorkflowBuild(f.store, f.options);
    expect(Object.keys(result.manifest.preparation!.inputFiles)).toContain("node_modules/@com-pyvue/agent-execution-core/index.js");
    const retained = await f.store.readBuild(result.manifest.buildSha256);
    expect(Buffer.from(retained.files["entry.mjs"]).toString()).not.toContain("agent-execution-platform");
    const module = await import(`data:text/javascript;base64,${Buffer.from(retained.files["entry.mjs"]).toString("base64")}`);
    expect(await module.step.execute({}, { city: "London" })).toEqual({ city: "London" });
  });
  it("builds once, reuses unchanged content and does not read environment or project build config", async () => {
    const f = await project();
    const first = await prepareRetainedWorkflowBuild(f.store, f.options);
    const second = await prepareRetainedWorkflowBuild(f.store, f.options);
    expect(first.reused).toBe(false); expect(second.reused).toBe(true); expect(second.manifest).toEqual(first.manifest);
    const build = await f.store.readBuild(first.manifest.buildSha256);
    expect(Object.keys(build.files).sort()).toEqual(["assets/src/prompt.md", "entry.mjs"]);
    expect(Buffer.from(build.files["entry.mjs"]).toString()).not.toContain("private-fixture-value");
    const module = await import(`data:text/javascript;base64,${Buffer.from(build.files["entry.mjs"]).toString("base64")}`);
    expect(module.result).toBe("original");
    const ref = { executionId: "saved-run" };
    await f.store.createRun(ref, { id: "binding", buildSha256: first.manifest.buildSha256, workflow: {}, invocation: {}, runConfiguration: {}, executionProfile: {}, nonSecretEnvironment: {}, credentialReferences: [], hostRequirements: f.options.hostRequirements });
    const owner = await f.store.claim(ref, "attempt-1", f.options.hostRequirements);
    await writeFile(path.join(f.root, "src/helper.ts"), 'throw new Error("Current source must not be loaded");');
    const saved = await loadRetainedWorkflowSource(f.store, ref, owner);
    expect(saved.module.result).toBe("original");
    expect(Buffer.from(saved.readAsset("src/prompt.md")).toString()).toBe("A declared prompt.");
    expect(() => saved.readAsset("../../.env")).toThrow("not declared");
    await f.store.cancel(ref);
    await expect(loadRetainedWorkflowSource(f.store, ref, owner)).rejects.toThrow("current live Run owner");
  });
  it("retains old executable bytes after source and dependency changes", async () => {
    const f = await project('import { message } from "fixture-dependency"; export const result = message;');
    const directory = path.join(f.root, "node_modules/fixture-dependency"); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
    await writeFile(path.join(directory, "index.js"), 'export const message = "first-dependency";');
    const first = await prepareRetainedWorkflowBuild(f.store, f.options);
    await writeFile(path.join(directory, "index.js"), 'export const message = "second-dependency";');
    const second = await prepareRetainedWorkflowBuild(f.store, f.options);
    expect(second.reused).toBe(false); expect(second.manifest.buildSha256).not.toBe(first.manifest.buildSha256);
    await rm(path.join(f.root, "node_modules"), { recursive: true });
    const saved = await f.store.readBuild(first.manifest.buildSha256);
    const module = await import(`data:text/javascript;base64,${Buffer.from(saved.files["entry.mjs"]).toString("base64")}`);
    expect(module.result).toBe("first-dependency");
  });
  it("invalidates resolution cache when a new higher-priority source file appears", async () => {
    const f = await project('import { message } from "./helper"; export const result = message;');
    const first = await prepareRetainedWorkflowBuild(f.store, f.options);
    await writeFile(path.join(f.root, "src/helper.js"), 'export const message = "new-resolution";');
    const second = await prepareRetainedWorkflowBuild(f.store, f.options);
    expect(second.reused).toBe(false); expect(second.manifest.inputSha256).not.toBe(first.manifest.inputSha256);
  });
  it("rebuilds when a declared asset changes, but never copies unrelated files", async () => {
    const f = await project(), first = await prepareRetainedWorkflowBuild(f.store, f.options);
    await writeFile(path.join(f.root, "src/prompt.md"), "Changed declared prompt.");
    await writeFile(path.join(f.root, "src/ignored.txt"), "Unrelated content");
    const second = await prepareRetainedWorkflowBuild(f.store, f.options);
    expect(second.manifest.buildSha256).not.toBe(first.manifest.buildSha256);
    expect(Object.keys((await f.store.readBuild(second.manifest.buildSha256)).files)).not.toContain("src/ignored.txt");
  });
  it.each([
    'const name = "./helper.js"; export const result = import(name);',
    'import fs from "node:fs"; export const result = fs.readFileSync(".env", "utf8");',
    'export const result = import("node:fs").then(fs => fs.readFileSync(".env", "utf8"));',
    'export const result = process.env.SECRET;',
    'export const result = import.meta.env.VITE_SECRET;',
    'export const result = new Function("return 1")();',
    'import native from "./addon.node"; export const result = native;',
  ])("rejects unsupported runtime dependencies: %s", async source => {
    const f = await project(source);
    await writeFile(path.join(f.root, "src/addon.node"), "not a native binary");
    await expect(prepareRetainedWorkflowBuild(f.store, f.options)).rejects.toThrow();
    expect((await f.store.previewBuildCleanup()).builds).toHaveLength(0);
  });
  it("rejects secret assets and source symlinks escaping the project", async () => {
    const f = await project();
    await expect(prepareRetainedWorkflowBuild(f.store, { ...f.options, assets: [".env"] })).rejects.toThrow();
    const outside = await mkdtemp(path.join(tmpdir(), "retained-outside-")); roots.push(outside);
    await writeFile(path.join(outside, "secret.ts"), "export const message = 1;");
    await rm(path.join(f.root, "src/helper.ts"));
    await symlink(path.join(outside, "secret.ts"), path.join(f.root, "src/helper.ts"));
    await expect(prepareRetainedWorkflowBuild(f.store, f.options)).rejects.toThrow();
  });
});
