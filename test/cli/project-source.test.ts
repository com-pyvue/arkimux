import { cp, mkdtemp, readFile, writeFile, mkdir, rm, symlink, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { validateProjectSource } from "../../cli/src/projectSourceGuard.ts";
import { ProjectSourceError, projectSourceDiagnostic } from "../../cli/src/projectSourceDiagnostic.ts";
import { definePortableWorkflowManifest, workflowManifestDigest } from "../../core/src/index.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-source-check-")); roots.push(root);
  await cp(new URL("../../cli/scaffold/src/", import.meta.url), path.join(root, "src"), { recursive: true });
  await cp(new URL("../../cli/scaffold/workflows/", import.meta.url), path.join(root, "workflows"), { recursive: true });
  return root;
}
async function edit(root: string, file: string, f: (s: string) => string) {
  await writeFile(path.join(root, file), f(await readFile(path.join(root, file), "utf8")));
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("offline workflow declarations and import policy", () => {
  it("retains the compiler message and exact project-relative source location", async () => {
    const root = await fixture();
    const text = "export const invalid = ;";
    await writeFile(path.join(root, "src/arkimux.workflows.ts"), `\n${text}\n`);
    const error = await validateProjectSource(root).catch(error => error);
    expect(error).toBeInstanceOf(ProjectSourceError);
    expect(error.message).toContain(`src/arkimux.workflows.ts:2:${text.indexOf(";") + 1}: Expression expected.`);
    expect(projectSourceDiagnostic(error)).toEqual({ kind: "source", code: "TS1109", message: "Expression expected.",
      file: "src/arkimux.workflows.ts", line: 2, column: text.indexOf(";") + 1 });
    expect(JSON.stringify(projectSourceDiagnostic(error))).not.toContain(root);
  });

  it("reports source-policy errors without copying source values", async () => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/src/workflow.ts", source => `const binding = { model: 'PRIVATE_SENTINEL' };\n${source}`);
    const error = await validateProjectSource(root).catch(error => error);
    expect(projectSourceDiagnostic(error)).toMatchObject({ kind: "source", code: "source-policy",
      file: "workflows/weather-advisor/src/workflow.ts", line: 1,
      message: "Runtime/model bindings belong in Run Configuration, not portable workflow source." });
    expect(JSON.stringify(projectSourceDiagnostic(error))).not.toContain("PRIVATE_SENTINEL");
  });

  it("reports a computed declaration at its source location without evaluating it", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src/arkimux.workflows.ts"), "export const loadProjectWorkflows = () => [];\nexport const workflowDeclarations = forbidden();");
    const error = await validateProjectSource(root).catch(error => error);
    expect(projectSourceDiagnostic(error)).toMatchObject({ code: "source-declaration", file: "src/arkimux.workflows.ts",
      line: 2, column: 37, message: "Declarations require JSON literals, not calls, imported values or computed expressions." });
  });

  it("only classifies bounded diagnostics created by the source validator", () => {
    const value = { file: "src/arkimux.workflows.ts", code: "TS1109", message: "Expression expected.", line: 1, column: 2 };
    const error = new ProjectSourceError(value);
    const copy = projectSourceDiagnostic(error)!; copy.message = "changed";
    expect(projectSourceDiagnostic(error)!.message).toBe("Expression expected.");
    expect(projectSourceDiagnostic(Object.assign(new Error("PRIVATE_INTERNAL_STACK"), { name: "ProjectSourceError", diagnostic: value }))).toBeUndefined();
    expect(projectSourceDiagnostic(Object.create(ProjectSourceError.prototype))).toBeUndefined();
    for (const invalid of [{ ...value, file: "/private/internal.ts" }, { ...value, file: "src/../internal.ts" },
      { ...value, message: "x".repeat(1001) }, { ...value, line: 0 }, { ...value, column: undefined },
      { ...value, message: "line\nwith control" }]) {
      expect(projectSourceDiagnostic(new ProjectSourceError(invalid))).toBeUndefined();
    }
  });

  it("does not follow imports in an explicitly disabled renderer registry", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src/arkimux.renderers.tsx"), "import { FileRunArtifactStore } from '@com-pyvue/agent-execution-core'; export const rendererDeclarations = []; export const resultViews = [];\n");
    await expect(validateProjectSource(root)).resolves.toMatchObject({ rendererRegistryPresent: true, rendererRegistryEmpty: true, renderers: [] });
    await expect(validateProjectSource(root, { includeRenderers: false })).resolves.toBeDefined();
  });
  it("still checks forbidden imports in registered renderers", async () => {
    const root = await fixture();
    await edit(root, "src/arkimux.renderers.tsx", s => `import { FileRunArtifactStore } from '@com-pyvue/agent-execution-core';\n${s}`);
    await expect(validateProjectSource(root)).rejects.toThrow("Unsupported ArkiMux");
  });
  it.each(["[{ resultKind: 'leftover' }]", "makeViews()"])("does not treat unproven resultViews %s as disabled", async views => {
    const root = await fixture();
    await writeFile(path.join(root, "src/arkimux.renderers.tsx"), `export const rendererDeclarations = []; export const resultViews = ${views};\n`);
    await expect(validateProjectSource(root)).rejects.toThrow();
  });
  it("keeps host adapters out of workflow imports and checks their private dependencies", async () => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => `import { createWeatherEffect } from './weather-effect.js';\n${s}`);
    await expect(validateProjectSource(root)).rejects.toThrow("cannot import a host effect adapter");
    const separate = await fixture();
    await edit(separate, "workflows/weather-advisor/src/weather-effect.ts", s => `import OpenAI from 'openai';\n${s}`);
    await expect(validateProjectSource(separate)).rejects.toThrow("Portable source");
  });
  it.each(["direct", "re-export", "local-alias"])("checks required capabilities through a %s constructor alias", async mode => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => {
      if (mode === "direct") return s.replace("defineStep,", "defineStep as step,").replaceAll("defineStep({", "step({");
      const prefix = mode === "re-export" ? "import { step } from './step-helper.js';\n" : "const step = defineStep;\n";
      return `${prefix}${mode === "re-export" ? s.replace("defineStep, ", "") : s}`.replaceAll("defineStep({", "step({");
    });
    if (mode === "re-export") await writeFile(path.join(root, "workflows/weather-advisor/src/step-helper.ts"), "export { defineStep as step } from '@com-pyvue/agent-execution-core';\n");
    await expect(validateProjectSource(root)).resolves.toBeDefined();
    await edit(root, "workflows/weather-advisor/manifest.json", s => { const m = JSON.parse(s); m.requiredCapabilities = m.requiredCapabilities.filter((x: string) => x !== "durable-sequential-steps@1"); return JSON.stringify(m); });
    await expect(validateProjectSource(root)).rejects.toThrow("required capability durable-sequential-steps@1");
  });
  it("allows schema and explicitly parsed model data, but rejects unclassified shorthand bindings", async () => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/src/contract.ts", s => `${s}\nconst product = z.object({model: z.string(), provider: z.string()});\nexport const sample = product.parse({model: 'car-model', provider: 'vendor-name'});\n`);
    await expect(validateProjectSource(root)).resolves.toBeDefined();
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => `const model = 'fixed-model'; export const binding = { model };\n${s}`);
    await expect(validateProjectSource(root)).rejects.toThrow("Runtime/model bindings");
  });
  it("handles schema aliases, schema shorthand and parsed-data shorthand consistently", async () => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/src/contract.ts", s => `${s}\nimport { z as schema } from 'zod';\nconst model = schema.string();\nconst product = schema.object({ model });\nconst provider = 'vendor-name';\nexport const sample = schema.object({provider: schema.string()}).parse({provider});\n`);
    await expect(validateProjectSource(root)).resolves.toBeDefined();
  });
  it.each(["const key = 'model'; const binding = {[key]: 'fixed'};", "const binding = {['model']: 'fixed'};"])("rejects unclassified computed bindings: %s", async prefix => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => `${prefix}\n${s}`);
    await expect(validateProjectSource(root)).rejects.toThrow(/binding|Runtime\/model/);
  });
  it("keeps optional broken renderer checks separate from startup workflow validation", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src/arkimux.renderers.tsx"), "throw new Error('broken renderer'); export const resultViews = [];\n");
    await expect(validateProjectSource(root)).rejects.toThrow("rendererDeclarations");
    expect((await validateProjectSource(root, { includeRenderers: false })).workflows).toHaveLength(2);
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => `import OpenAI from 'openai';\n${s}`);
    await expect(validateProjectSource(root, { includeRenderers: false })).rejects.toThrow("Portable source");
  });
  it("validates the scaffold without credentials, installed project packages or running its registry", async () => {
    const root = await fixture();
    await edit(root, "src/arkimux.workflows.ts", s => `${s}\nawait readFile('/not-read-by-the-validator');\nawait fetch('http://127.0.0.1:1/not-called');\nthrow new Error('must not execute');`);
    const before = await readFile(path.join(root, "src/arkimux.workflows.ts"));
    const result = await validateProjectSource(root);
    expect(result.workflows[0].manifest.workflowMode).toBe("arkimux-portable");
    expect(result.renderers).toHaveLength(2);
    expect(await readFile(path.join(root, "src/arkimux.workflows.ts"))).toEqual(before);
    expect(await readdir(root)).toEqual(["src", "workflows"]);
    expect(workflowManifestDigest(definePortableWorkflowManifest(result.workflows[0].manifest))).toBe(result.workflows[0].digest);
  });
  it("never executes top-level file writes", async () => {
    const root = await fixture();
    await edit(root, "src/arkimux.workflows.ts", s => `import { writeFile } from 'node:fs/promises';\n${s}\nawait writeFile(${JSON.stringify(path.join(root, "unexpected"))}, 'bad');`);
    await validateProjectSource(root);
    expect(await readdir(root)).not.toContain("unexpected");
  });
  it.each([
    ["import { FileRunArtifactStore } from '@com-pyvue/agent-execution-core';", "Unsupported ArkiMux"],
    ["import * as core from '@com-pyvue/agent-execution-core';", "Unsupported ArkiMux"],
    ["export { FileRunArtifactStore } from '@com-pyvue/agent-execution-core';", "Unsupported ArkiMux"],
    ["import { x } from '@com-pyvue/agent-execution-core/src/private.js';", "Unsupported ArkiMux"],
    ["import OpenAI from 'openai';", "Portable source"],
    ["import x from 'unknown-library';", "unclassified-dependency"],
    ["const p = 'openai'; import(p);", "Computed dynamic"],
    ["const x = process.env.API_KEY;", "direct environment"],
    ["const x = globalThis['process'];", "direct environment"],
    ["const x = { model: 'fixed-model' };", "Runtime/model bindings"],
    ["fetch('https://example.invalid');", "declared typed effect"],
  ])("rejects %s", async (prefix, message) => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => `${prefix}\n${s}`);
    await expect(validateProjectSource(root)).rejects.toThrow(message);
  });
  it("checks transitive helpers and effect dependencies", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "workflows/weather-advisor/src/hidden.ts"), "import OpenAI from 'openai'; export const helper = 1;");
    await edit(root, "workflows/weather-advisor/src/weather-effect.ts", s => `import { helper } from './hidden.js';\n${s}`);
    await expect(validateProjectSource(root)).rejects.toThrow("Portable source");
  });
  it("rejects computed static declarations and missing source exports", async () => {
    const root = await fixture();
    const file = "src/arkimux.workflows.ts";
    const source = await readFile(path.join(root, file), "utf8");
    await edit(root, file, s => s.replace("agentSlots: [", "agentSlots: makeSlots(["));
    await expect(validateProjectSource(root)).rejects.toThrow();
    await writeFile(path.join(root, file), source.replace('export: "defineWeatherAdvisor"', 'export: "missing"'));
    await expect(validateProjectSource(root)).rejects.toThrow("missing export missing");
  });
  it("accepts names-only secret declarations without reading an .env", async () => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/environment.json", s => s.replace('"secret": false', '"secret": true'));
    await expect(validateProjectSource(root)).resolves.toMatchObject({ workflows: [expect.any(Object), expect.any(Object)] });
  });
  it("rejects invalid renderer identities and permits missing optional renderer", async () => {
    const root = await fixture();
    await edit(root, "src/arkimux.renderers.tsx", s => s.replace('workflowId: "weather-advisor"', 'workflowId: "unknown"'));
    await expect(validateProjectSource(root)).rejects.toThrow("unknown workflow result");
    await rm(path.join(root, "src/arkimux.renderers.tsx"));
    expect((await validateProjectSource(root)).renderers).toEqual([]);
  });
  it("rejects duplicate workflow identities even when registered from distinct files", async () => {
    const root = await fixture();
    await cp(path.join(root, "workflows/weather-advisor"), path.join(root, "workflows/duplicate"), { recursive: true });
    await edit(root, "src/arkimux.workflows.ts", source => {
      const declaration = source.slice(source.indexOf("export const workflowDeclarations = [") + "export const workflowDeclarations = [".length, source.indexOf("];"));
      return source.replace("export const workflowDeclarations = [", `export const workflowDeclarations = [${declaration.replaceAll("workflows/weather-advisor", "workflows/duplicate")},`);
    });
    await expect(validateProjectSource(root)).rejects.toThrow("Duplicate workflow");
  });
  it.each([
    ['resultKind: "weather-advisor.result"', 'resultKind: "other.result"'],
    ['payloadSchemaVersion: 2', 'payloadSchemaVersion: 99'],
  ])("rejects a renderer whose %s does not match the registered result", async (before, after) => {
    const root = await fixture();
    await edit(root, "src/arkimux.renderers.tsx", source => source.replace(before, after));
    await expect(validateProjectSource(root)).rejects.toThrow("unknown workflow result");
  });
  it("rejects source symlinks into hidden runtime data", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".arkimux"));
    await writeFile(path.join(root, ".arkimux/hidden.ts"), "export const hidden = 1;");
    await symlink(path.join(root, ".arkimux"), path.join(root, "workflows/runtime"));
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => `import { hidden } from '../../runtime/hidden.js';\n${s}`);
    await expect(validateProjectSource(root)).rejects.toThrow();
  });
  it("accepts native imports only with a matching declared binding", async () => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => `import OpenAI from 'openai';\n${s}`);
    await edit(root, "workflows/weather-advisor/manifest.json", s => JSON.stringify({ ...JSON.parse(s), workflowMode: "native-runtime-bound" }));
    await expect(validateProjectSource(root)).rejects.toThrow("Declare this native source binding");
    await edit(root, "workflows/weather-advisor/manifest.json", s => JSON.stringify({ ...JSON.parse(s), sourceBindings: [{
      kind: "agent-provider", id: "openai", source: { file: "workflows/weather-advisor/src/workflow.ts", import: "openai" },
    }] }));
    expect((await validateProjectSource(root)).workflows[0].manifest.workflowMode).toBe("native-runtime-bound");
  });
  it("rejects missing capability declarations", async () => {
    const root = await fixture();
    await edit(root, "workflows/weather-advisor/manifest.json", s => JSON.stringify({ ...JSON.parse(s), requiredCapabilities: [] }));
    await expect(validateProjectSource(root)).rejects.toThrow("required capability");
  });
  it("checks native JSON pointers and rejects the same binding in portable source", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "workflows/weather-advisor/src/binding.json"), JSON.stringify({ model: "example-model" }));
    await edit(root, "workflows/weather-advisor/src/workflow.ts", s => `import config from './binding.json';\n${s}`);
    await expect(validateProjectSource(root)).rejects.toThrow("bindings in JSON");
    await edit(root, "workflows/weather-advisor/manifest.json", s => JSON.stringify({ ...JSON.parse(s), workflowMode: "native-runtime-bound" }));
    await expect(validateProjectSource(root)).rejects.toThrow("every native JSON");
    await edit(root, "workflows/weather-advisor/manifest.json", s => JSON.stringify({ ...JSON.parse(s), sourceBindings: [{
      kind: "model", id: "example-model", source: { file: "workflows/weather-advisor/src/binding.json", pointer: "/model" },
    }] }));
    await expect(validateProjectSource(root)).resolves.toBeDefined();
  });
  it("validates both public workflow fixtures alongside the generated graph example", async () => {
    const root = await fixture();
    const directory = "workflows/vendor-evaluation";
    await cp(new URL("../fixtures/local-v2-vendor/src/", import.meta.url), path.join(root, directory, "src"), { recursive: true });
    const fixtures = JSON.parse(await readFile(new URL("../fixtures/public-workflow-contract/fixtures.json", import.meta.url), "utf8"));
    await writeFile(path.join(root, directory, "manifest.json"), JSON.stringify(fixtures.vendor));
    await writeFile(path.join(root, directory, "environment.json"), JSON.stringify({ schemaVersion: 1, variables: [] }));
    const extra = { manifest: `${directory}/manifest.json`, environment: `${directory}/environment.json`,
      definition: { file: `${directory}/src/workflow.ts`, export: "defineVendorEvaluation" },
      inputValidator: { file: `${directory}/src/contract.ts`, export: "vendorInputSchema" },
      resultValidator: { file: `${directory}/src/contract.ts`, export: "vendorResultSchema" },
      result: { kind: "vendor-evaluation.result", schemaVersion: 1 }, effects: [], agentSlots: ["vendor-evaluator"] };
    await edit(root, "src/arkimux.workflows.ts", s => s.replace("export const workflowDeclarations = [", `export const workflowDeclarations = [${JSON.stringify(extra)},`));
    expect((await validateProjectSource(root)).workflows.map(w => w.manifest.workflowId).sort()).toEqual(["graph-invocation", "vendor-evaluation", "weather-advisor"]);
  });
});
