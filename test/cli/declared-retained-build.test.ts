import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { prepareDeclaredRetainedWorkflowBuild } from "../../cli/src/declaredRetainedWorkflowBuild.ts";
import { prepareRetainedWorkflowBuild } from "../../cli/src/retainedWorkflowBuild.ts";
import { validateProjectSource } from "../../cli/src/projectSourceGuard.ts";
import { workflowDeclarationV1Schema } from "../../core/src/application/workflowManifest.ts";
import { workflowDeclarationWithConstructionSchema } from "../../core/src/application/retainedWorkflowDeclaration.ts";
import fixtures from "../fixtures/public-workflow-contract/fixtures.json";

const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "retained-declaration-unit-")); roots.push(root);
  const directory = "workflows/weather-advisor";
  await mkdir(path.join(root, directory), { recursive: true }); await mkdir(path.join(root, "src"));
  const ref = (name: string) => ({ file: `${directory}/workflow.ts`, export: name });
  const declaration = { manifest: `${directory}/manifest.json`, environment: `${directory}/environment.json`,
    definition: ref("defineWeatherAdvisor"), inputValidator: ref("input"), resultValidator: ref("output"),
    result: { kind: "weather-advisor.result", schemaVersion: 1 }, agentSlots: ["recommendation"],
    effects: [{ file: `${directory}/effect.ts`, export: "createWeatherEffect" }],
    construction: { file: `${directory}/construction.ts`, export: "createWeather", assets: [`${directory}/prompt.md`] } };
  async function registry(value: unknown = declaration) {
    await writeFile(path.join(root, "src/arkimux.workflows.ts"), `export const workflowDeclarations = ${JSON.stringify([value])};\nexport function loadProjectWorkflows() { throw new Error("Registry must not execute"); }`);
  }
  await registry();
  await writeFile(path.join(root, declaration.manifest), JSON.stringify(fixtures.weather));
  await writeFile(path.join(root, declaration.environment), JSON.stringify({ schemaVersion: 1, variables: [] }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  await writeFile(path.join(root, ref("input").file), 'export const input = { parse: x => x }; export const output = input; export function defineWeatherAdvisor(effect) { return { effect }; }');
  await writeFile(path.join(root, `${directory}/effect-contract.ts`), 'export const weatherContract = { schemaVersion: 1, operationId: "weather.current", definitionVersion: "1", safety: "read", input: { parse: x => x }, output: { parse: x => x } };');
  await writeFile(path.join(root, declaration.effects[0].file), 'import { weatherContract } from "./effect-contract.js"; export function createWeatherEffect(context) { return { ...weatherContract, execute: async () => ({ url: context.environment.URL, secret: context.credentials.SECRET }) }; }');
  await writeFile(path.join(root, declaration.construction.file), 'import { defineWeatherAdvisor } from "./workflow.js"; import { weatherContract } from "./effect-contract.js"; export function createWeather(context) { return { workflow: defineWeatherAdvisor(weatherContract), agentPrompts: { recommendation: new TextDecoder().decode(context.readAsset("workflows/weather-advisor/prompt.md")) } }; }');
  await writeFile(path.join(root, declaration.construction.assets[0]), "Original prompt");
  const store = await FileRetainedExecutionStoreV1.open(path.join(root, "storage")); stores.push(store);
  const options = { projectRoot: root, workflowId: "weather-advisor", hostRequirements: { node: "22" } };
  return { root, store, options, declaration, registry };
}

describe("checked registry to retained build", () => {
  it("adds constructor metadata without altering the frozen V1 declaration", async () => {
    const f = await setup(); const { construction, ...legacy } = f.declaration;
    expect(workflowDeclarationV1Schema.parse(legacy)).toEqual(legacy);
    expect(() => workflowDeclarationV1Schema.parse(f.declaration)).toThrow();
    expect(workflowDeclarationWithConstructionSchema.parse(f.declaration).construction).toEqual(construction);
  });
  it("selects and retains the declared factory and assets without executing the registry or constructor", async () => {
    const f = await setup();
    const first = await prepareDeclaredRetainedWorkflowBuild(f.store, f.options);
    const again = await prepareDeclaredRetainedWorkflowBuild(f.store, f.options);
    expect(again.reused).toBe(true); expect(again.manifest.buildSha256).toBe(first.manifest.buildSha256);
    const build = await f.store.readBuild(first.manifest.buildSha256);
    expect(JSON.parse(Buffer.from(build.files["construction.json"]).toString())).toEqual({ schemaVersion: 2, export: "createWeather",
      effectAdapterEntryPoint: "effect-adapters.mjs", effectAdapters: ["__arkimuxEffectAdapter0"] });
    const workflowCode = Buffer.from(build.files[build.manifest.entryPoint]).toString();
    const adapterCode = Buffer.from(build.files["effect-adapters.mjs"]).toString();
    expect(workflowCode).not.toContain("__arkimuxEffectAdapter0");
    expect(workflowCode).not.toContain("context.credentials.SECRET");
    expect(adapterCode).toContain("__arkimuxEffectAdapter0");
    expect(adapterCode).toContain("context.credentials.SECRET");
    expect(Buffer.from(build.files[`assets/${f.declaration.construction.assets[0]}`]).toString()).toBe("Original prompt");
    expect(first.manifest.preparation!.inputFiles).toHaveProperty("src/arkimux.workflows.ts");
    expect(Object.keys(build.files)).not.toContain("src/arkimux.workflows.ts");
    await writeFile(path.join(f.root, f.declaration.construction.assets[0]), "Edited prompt");
    expect((await prepareDeclaredRetainedWorkflowBuild(f.store, f.options)).manifest.buildSha256).not.toBe(first.manifest.buildSha256);
  });
  it("refuses a live factory fallback and unknown workflow IDs before publishing a build", async () => {
    const f = await setup(); const { construction: _construction, ...legacy } = f.declaration;
    await f.registry(legacy);
    await expect(prepareDeclaredRetainedWorkflowBuild(f.store, f.options)).rejects.toThrow("requires a retained construction declaration");
    await expect(prepareDeclaredRetainedWorkflowBuild(f.store, { ...f.options, workflowId: "missing" })).rejects.toThrow("not declared");
    expect((await f.store.previewBuildCleanup()).builds).toHaveLength(0);
  });
  it.each(["missing-export", "private-import", "undeclared-network"])("rejects invalid construction: %s", async mode => {
    const f = await setup();
    const source = mode === "missing-export" ? "export const wrong = 1;"
      : mode === "private-import" ? 'import { FileRunArtifactStore } from "@com-pyvue/agent-execution-core"; export function createWeather() {}'
      : 'export function createWeather() { return fetch("https://example.invalid"); }';
    await writeFile(path.join(f.root, f.declaration.construction.file), source);
    await expect(prepareDeclaredRetainedWorkflowBuild(f.store, f.options)).rejects.toThrow();
    expect((await f.store.previewBuildCleanup()).builds).toHaveLength(0);
  });
  it.each(["workflows/weather-advisor/missing.md", "workflows/weather-advisor/auth.json", "../escape"])("rejects missing or unsafe asset %s", async asset => {
    const f = await setup(); await f.registry({ ...f.declaration, construction: { ...f.declaration.construction, assets: [asset] } });
    await expect(prepareDeclaredRetainedWorkflowBuild(f.store, f.options)).rejects.toThrow();
  });
  it("rejects duplicate assets and unknown extension fields", async () => {
    const f = await setup();
    expect(() => workflowDeclarationWithConstructionSchema.parse({ ...f.declaration, construction: { ...f.declaration.construction, assets: ["src/a", "src/a"] } })).toThrow();
    expect(() => workflowDeclarationWithConstructionSchema.parse({ ...f.declaration, construction: { ...f.declaration.construction, liveFallback: true } })).toThrow();
  });
  it("rejects changed source-validation inputs on both fresh and reused builds", async () => {
    const f = await setup(), checked = await validateProjectSource(f.root, { includeRenderers: false });
    const options = { projectRoot: f.root, entryPoint: f.declaration.construction.file, constructionExport: "createWeather",
      assets: f.declaration.construction.assets, hostRequirements: f.options.hostRequirements, validatedInputFiles: checked.sourceDigests };
    await prepareRetainedWorkflowBuild(f.store, options);
    const registry = await readFile(path.join(f.root, "src/arkimux.workflows.ts"), "utf8");
    await writeFile(path.join(f.root, "src/arkimux.workflows.ts"), `${registry}\n// edited after validation`);
    await expect(prepareRetainedWorkflowBuild(f.store, options)).rejects.toThrow("changed after source validation");
    await expect(prepareRetainedWorkflowBuild(f.store, { ...options, constructionExport: "other" })).rejects.toThrow("changed after source validation");
  });
  it("rejects a newly introduced import target that bypasses the checked source graph", async () => {
    const f = await setup(), checked = await validateProjectSource(f.root, { includeRenderers: false });
    await writeFile(path.join(f.root, "workflows/weather-advisor/workflow.js"), 'export function defineWeatherAdvisor() { return {}; }');
    await expect(prepareRetainedWorkflowBuild(f.store, { projectRoot: f.root, entryPoint: f.declaration.construction.file,
      constructionExport: "createWeather", assets: [], hostRequirements: f.options.hostRequirements,
      validatedInputFiles: checked.sourceDigests })).rejects.toThrow("import resolution changed");
  });
});
