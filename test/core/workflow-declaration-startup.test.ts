import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { it, expect, afterEach } from "vitest";
import { assertLocalWorkflowDeclarations, withLocalWorkflowDeclaration, assertLocalRendererDeclarations } from "../../local/src/workflowDeclarations.ts";
import type { LocalWorkflowRegistration } from "../../local/src/index.ts";
import { validateWorkflowManifestV1 } from "../../core/src/application/workflowManifest.ts";
import fixtures from "../fixtures/public-workflow-contract/fixtures.json";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-startup-contract-")); roots.push(root);
  await mkdir(path.join(root, "workflows/weather-advisor"), { recursive: true });
  const validatorFile = path.join(root, "workflows/weather-advisor/validators.mjs");
  await writeFile(validatorFile, "export const input = { parse: x => x }; export const output = { parse: x => x };");
  const validators = await import(pathToFileURL(validatorFile).href);
  await writeFile(path.join(root, "workflows/weather-advisor/manifest.json"), JSON.stringify(fixtures.weather));
  const environment = { schemaVersion: 1 as const, variables: [] };
  await writeFile(path.join(root, "workflows/weather-advisor/environment.json"), JSON.stringify(environment));
  const ref = { file: "workflows/weather-advisor/validators.mjs", export: "input" };
  const declaration = { manifest: "workflows/weather-advisor/manifest.json", environment: "workflows/weather-advisor/environment.json",
    definition: ref, inputValidator: ref, resultValidator: { ...ref, export: "output" },
    result: { kind: "weather-advisor.result", schemaVersion: 1 }, effects: [], agentSlots: ["recommendation"] };
  const registration = { workflow: { kind: "weather-advisor", version: 1 }, agentSlots: [{ slotId: "recommendation" }] } as LocalWorkflowRegistration;
  const binding = { manifest: validateWorkflowManifestV1(fixtures.weather), result: declaration.result,
    inputValidator: validators.input, resultValidator: validators.output,
    environment: { file: declaration.environment, declaration: environment } };
  return { root, declaration, registration, binding };
}
it("keeps the shipped manifest implementation byte-identical to the frozen rules", async () => {
  expect(await readFile(new URL("../../core/src/application/workflowManifest.ts", import.meta.url), "utf8"))
    .toBe(await readFile(new URL("../fixtures/public-workflow-contract/contracts.ts", import.meta.url), "utf8"));
});
it("checks loaded slots, result identity, manifest and exact validator exports before serving", async () => {
  const f = await fixture();
  withLocalWorkflowDeclaration(f.registration, f.binding);
  const options = { repositoryRoot: f.root, declarations: [f.declaration], workflows: [f.registration] };
  await expect(assertLocalWorkflowDeclarations(options)).resolves.toBeUndefined();
  await expect(assertLocalWorkflowDeclarations({ ...options, workflows: [] })).rejects.toThrow("declaration set");
  await expect(assertLocalWorkflowDeclarations({ ...options, declarations: [{ ...f.declaration, agentSlots: [] }] })).rejects.toThrow("metadata");
  await expect(assertLocalWorkflowDeclarations({ ...options, declarations: [{ ...f.declaration, result: { kind: "wrong", schemaVersion: 1 } }] })).rejects.toThrow("metadata");
  await expect(assertLocalWorkflowDeclarations({ ...options, declarations: [{ ...f.declaration, inputValidator: { ...f.declaration.inputValidator, export: "output" } }] })).rejects.toThrow("inputValidator");
  await writeFile(path.join(f.root, "workflows/weather-advisor/manifest.json"), JSON.stringify({ ...fixtures.weather, workflowContractVersion: "2" }));
  await expect(assertLocalWorkflowDeclarations(options)).rejects.toThrow("metadata");
});
it("rejects unbound registrations and rebinding without changing old registrations", async () => {
  const f = await fixture();
  await expect(assertLocalWorkflowDeclarations({ repositoryRoot: f.root, declarations: [f.declaration], workflows: [f.registration] })).rejects.toThrow("metadata");
  expect(withLocalWorkflowDeclaration(f.registration, f.binding)).toBe(f.registration);
  expect(() => withLocalWorkflowDeclaration(f.registration, f.binding)).toThrow("already set");
});
it("matches loaded renderer identities and permits an empty optional view set", () => {
  const declaration = { workflowId: "weather-advisor", resultKind: "weather-advisor.result", payloadSchemaVersion: 1,
    renderer: { file: "workflows/weather-advisor/src/result-renderer.tsx", export: "WeatherAdvisorResult" } };
  const view = { resultKind: declaration.resultKind, payloadSchemaVersion: 1, render: () => "<p>result</p>" };
  expect(() => assertLocalRendererDeclarations([declaration], [view])).not.toThrow();
  expect(() => assertLocalRendererDeclarations([declaration], [{ ...view, payloadSchemaVersion: 2 }])).toThrow();
  expect(() => assertLocalRendererDeclarations([], [])).not.toThrow();
});
it("makes the declared validator authoritative instead of calling the old native validator", async () => {
  const f = await fixture();
  f.registration.validateInput = () => { throw new Error("old validator must not run"); };
  withLocalWorkflowDeclaration(f.registration, f.binding);
  const input = { from: "declared validator" };
  expect(f.registration.validateInput(input)).toBe(input);
  expect(() => { f.registration.validateInput = () => { throw new Error("replacement"); }; }).toThrow();
  await expect(assertLocalWorkflowDeclarations({ repositoryRoot: f.root, declarations: [f.declaration], workflows: [f.registration] })).resolves.toBeUndefined();
});
it("rejects a changed environment declaration at startup", async () => {
  const f = await fixture();
  withLocalWorkflowDeclaration(f.registration, f.binding);
  await writeFile(path.join(f.root, f.declaration.environment), JSON.stringify({ schemaVersion: 1, variables: [
    { name: "EXTRA", required: false, secret: false, type: "string" },
  ] }));
  await expect(assertLocalWorkflowDeclarations({ repositoryRoot: f.root, declarations: [f.declaration], workflows: [f.registration] })).rejects.toThrow("environment differs");
});
