import path from "node:path";
import { readFile, realpath, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateWorkflowManifestV1, workflowManifestDigest,
  rendererDeclarationV1Schema, projectSourcePathV1Schema, type WorkflowManifestV1 } from "../../core/src/application/workflowManifest.ts";
import type { LocalWorkflowRegistration } from "./index.ts";
import type { LocalResultView } from "./resultViews.ts";
import { validateWorkflowEnvironmentDeclaration, type WorkflowEnvironmentDeclaration } from "./workflowEnvironment.ts";
import { canonicalWorkflowJson } from "../../core/src/application/workflowManifest.ts";
import { workflowDeclarationWithConstructionSchema } from "../../core/src/application/retainedWorkflowDeclaration.ts";

export interface LocalWorkflowDeclarationBinding<T = unknown> {
  manifest: WorkflowManifestV1;
  result: { kind: string; schemaVersion: number };
  inputValidator: { parse(value: unknown): T };
  resultValidator: { parse(value: unknown): unknown };
  environment: { file: string; declaration: WorkflowEnvironmentDeclaration };
}
const bindings = new WeakMap<object, LocalWorkflowDeclarationBinding>();

/** Private composition read; validator objects stay in this process. */
export function readLocalWorkflowDeclarationBinding(registration: object) {
  const binding = bindings.get(registration);
  if (!binding) throw new Error("Workflow has no checked declaration binding.");
  return { manifest: structuredClone(binding.manifest), result: { ...binding.result },
    environment: structuredClone(binding.environment) };
}

export function assertLocalRendererDeclarations(declarations: readonly unknown[], views: readonly LocalResultView[]): void {
  const expected = declarations.map(d => rendererDeclarationV1Schema.parse(d));
  const key = (kind: string, version: number) => JSON.stringify([kind, version]);
  const expectedKeys = expected.map(d => key(d.resultKind, d.payloadSchemaVersion)).sort();
  const actualKeys = views.map(v => key(v.resultKind, v.payloadSchemaVersion)).sort();
  if (new Set(expectedKeys).size !== expectedKeys.length || JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)
    || views.some(v => typeof v.render !== "function")) throw new Error("Loaded result views do not match their declarations.");
}

/** Attach checked metadata without replacing the existing runtime registration API. */
export function withLocalWorkflowDeclaration<T>(registration: LocalWorkflowRegistration<T>, binding: LocalWorkflowDeclarationBinding<T>): LocalWorkflowRegistration<T> {
  const manifest = validateWorkflowManifestV1(binding.manifest);
  if (registration.workflow.kind !== manifest.workflowId || typeof binding.inputValidator?.parse !== "function"
    || typeof binding.resultValidator?.parse !== "function" || !binding.result.kind
    || !Number.isSafeInteger(binding.result.schemaVersion) || binding.result.schemaVersion < 1) {
    throw new Error("Workflow declaration binding does not match the registration.");
  }
  if (bindings.has(registration)) throw new Error("Workflow declaration binding is already set.");
  projectSourcePathV1Schema.parse(binding.environment.file);
  const environment = validateWorkflowEnvironmentDeclaration(binding.environment.declaration);
  const parseInput = binding.inputValidator.parse.bind(binding.inputValidator);
  // This is the input validator used by the server, not a second metadata-only validator.
  Object.defineProperty(registration, "validateInput", { value: parseInput, enumerable: true, writable: false, configurable: false });
  bindings.set(registration, { ...binding, manifest, result: { ...binding.result },
    environment: { file: binding.environment.file, declaration: environment } });
  return registration;
}

/** Read names-only source metadata before loading .env or invoking a workflow factory. */
export async function readDeclaredWorkflowEnvironment(repositoryRoot: string, relative: string): Promise<WorkflowEnvironmentDeclaration> {
  const file = await declarationFile(repositoryRoot, relative);
  return validateWorkflowEnvironmentDeclaration(JSON.parse(await readFile(file, "utf8")));
}

async function declarationFile(repositoryRoot: string, relative: string): Promise<string> {
  projectSourcePathV1Schema.parse(relative);
  const root = await realpath(repositoryRoot);
  const candidate = path.resolve(root, relative);
  const resolved = await realpath(candidate);
  const actual = path.relative(root, resolved).split(path.sep).join("/");
  projectSourcePathV1Schema.parse(actual);
  const info = await lstat(candidate);
  if (!/^(src|workflows)\//.test(actual) || !info.isFile() || info.size > 1024 * 1024) throw new Error("Declaration file must stay in bounded project source.");
  return resolved;
}

/** Startup/reload check. Unlike the offline CLI, this loads trusted project validators. */
export async function assertLocalWorkflowDeclarations(options: {
  repositoryRoot: string; declarations: readonly unknown[]; workflows: readonly LocalWorkflowRegistration[];
  /** Private CLI module graph, shared with the candidate's registry import. */
  loadModule?(absoluteFile: string): Promise<Record<string, unknown>>;
}): Promise<void> {
  const file = (relative: string) => declarationFile(options.repositoryRoot, relative);
  if (options.declarations.length !== options.workflows.length) throw new Error("Loaded workflows do not match the static declaration set.");
  const seen = new Set<string>();
  for (const input of options.declarations) {
    const declaration = workflowDeclarationWithConstructionSchema.parse(input);
    const manifest = validateWorkflowManifestV1(JSON.parse(await readFile(await file(declaration.manifest), "utf8")));
    if (seen.has(manifest.workflowId)) throw new Error("Duplicate declared workflow.");
    seen.add(manifest.workflowId);
    const candidates = options.workflows.filter(w => w.workflow.kind === manifest.workflowId);
    if (candidates.length !== 1) throw new Error(`Loaded workflow set does not match ${manifest.workflowId}.`);
    const registration = candidates[0];
    const actual = bindings.get(registration);
    if (!actual || workflowManifestDigest(actual.manifest) !== workflowManifestDigest(manifest)
      || actual.result.kind !== declaration.result.kind || actual.result.schemaVersion !== declaration.result.schemaVersion
      || JSON.stringify((registration.agentSlots ?? []).map(s => s.slotId).sort()) !== JSON.stringify([...declaration.agentSlots].sort())) {
      throw new Error(`Loaded metadata does not match the static declaration for ${manifest.workflowId}.`);
    }
    const environment = await readDeclaredWorkflowEnvironment(options.repositoryRoot, declaration.environment);
    if (actual.environment.file !== declaration.environment
      || canonicalWorkflowJson(actual.environment.declaration) !== canonicalWorkflowJson(environment)) {
      throw new Error(`${manifest.workflowId}: loaded environment differs from its declaration.`);
    }
    for (const key of ["inputValidator", "resultValidator"] as const) {
      const reference = declaration[key];
      const absoluteFile = await file(reference.file);
      const module = options.loadModule ? await options.loadModule(absoluteFile) : await import(pathToFileURL(absoluteFile).href);
      if (module[reference.export] !== actual[key]) throw new Error(`${manifest.workflowId}: loaded ${key} differs from its declared export.`);
    }
  }
}
