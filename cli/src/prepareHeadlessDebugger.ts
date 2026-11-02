/** CLI-owned source preparation. Reopening a session never calls this adapter. */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { assertRunConfigurationId, runConfigurationContentHash, validateAgentRunPolicy } from "../../core/src/application/runConfiguration.ts";
import { constructionDescriptorFile, constructionDescriptorSchema } from "../../core/src/application/retainedWorkflowConstruction.ts";
import { validateWorkflowIdentity } from "../../core/src/domain/workflowIdentity.ts";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { resolveWorkflowEnvironment, validateWorkflowEnvironmentDeclaration } from "../../local/src/workflowEnvironment.ts";
import { HeadlessDebuggerError, parseHeadlessAuthorization, parseHeadlessManifest, resolveHeadlessExecutionBudget,
  type HeadlessManifest, type HeadlessAuthorization, type HeadlessManifestV2, type HeadlessAuthorizationV2 } from "../../local/src/headlessDebuggerContracts.ts";
import type { PreparedHeadlessSession } from "../../local/src/headlessDebugger.ts";
import { prepareDeclaredRetainedWorkflowBuild } from "./declaredRetainedWorkflowBuild.ts";
import { ensureDebugImage, type DebugImageSource, type EnsuredDebugImage } from "./dockerMockDebugger.ts";
import type { PreparedDockerMockDebuggerSession } from "./dockerMockDebuggerCoordinator.ts";

const maxFileBytes = 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalidConfiguration(message: string): never { throw new HeadlessDebuggerError("configuration_invalid", message); }
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HeadlessDebuggerError("preparation_incomplete", "Diagnostic preparation was cancelled. Create a new session.");
}

/** Bounds all bytes and rejects symlinks, including parent-directory symlinks. */
async function checkedPath(root: string, relative: string): Promise<string | undefined> {
  const pieces = relative.split("/");
  if (path.isAbsolute(relative) || relative.includes("\\") || pieces.some(piece => !piece || piece === "." || piece === "..")) {
    throw new Error("Invalid project data path.");
  }
  let absolute = root;
  for (const [index, piece] of pieces.entries()) {
    absolute = path.join(absolute, piece);
    let info;
    try { info = await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (info.isSymbolicLink() || (index < pieces.length - 1 && !info.isDirectory())) throw new Error("Project data path must not use symlinks.");
  }
  return absolute;
}
async function readChecked(root: string, relative: string): Promise<Buffer | undefined> {
  const absolute = await checkedPath(root, relative);
  if (!absolute) return undefined;
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxFileBytes) throw new Error("Project data must be a regular file no larger than 1 MiB.");
    const bytes = Buffer.alloc(maxFileBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > maxFileBytes) throw new Error("Project data exceeds 1 MiB.");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

function validateConfiguration(value: unknown, workflowId: string, configurationId: string, slotIds: string[]): PreparedHeadlessSession["configuration"] {
  if (!record(value) || value.schemaVersion !== 1 || value.configurationId !== configurationId || !record(value.agents)) {
    invalidConfiguration("Run Configuration must match the selected ID and contain a schemaVersion 1 agent map.");
  }
  const workflow = validateWorkflowIdentity(value.workflow);
  if (workflow.kind !== workflowId || !Number.isSafeInteger(workflow.version)) invalidConfiguration("Run Configuration belongs to another workflow.");
  const agents = value.agents;
  if (Object.keys(agents).length !== slotIds.length || slotIds.some(id => !Object.hasOwn(agents, id))) {
    invalidConfiguration("Run Configuration must contain exactly the declared agent slots.");
  }
  for (const id of slotIds) validateAgentRunPolicy(agents[id]);
  return { ...value, configurationId, workflow, agents } as PreparedHeadlessSession["configuration"];
}

async function readConfiguration(root: string, manifest: HeadlessManifest, slotIds: string[], workflowDirectory: string): Promise<PreparedHeadlessSession["configuration"]> {
  const publishedRoot = `.arkimux/local/configuration/run-configurations/${manifest.workflowId}`;
  const directory = await checkedPath(root, publishedRoot);
  const versions = directory ? await readdir(directory) : [];
  const candidates: { configuration: PreparedHeadlessSession["configuration"]; relative: string }[] = [];
  for (const version of versions.filter(name => /^[1-9][0-9]*$/.test(name)).sort()) {
    if (!Number.isSafeInteger(Number(version))) invalidConfiguration("Published workflow version is invalid.");
    const relative = `${publishedRoot}/${version}/${manifest.configurationId}`;
    const bytes = await readChecked(root, `${relative}/definition.json`);
    if (!bytes) {
      if (await checkedPath(root, relative)) invalidConfiguration("The published Run Configuration is incomplete. Restore its definition instead of using an included default.");
      continue;
    }
    const configuration = validateConfiguration(JSON.parse(bytes.toString("utf8")), manifest.workflowId, manifest.configurationId, slotIds);
    if (configuration.workflow.version !== Number(version)) invalidConfiguration("Published Run Configuration version does not match its storage identity.");
    candidates.push({ configuration, relative });
  }
  if (candidates.length > 1) invalidConfiguration("The configuration ID exists for multiple workflow versions. Select a uniquely named configuration.");
  if (candidates.length === 1) {
    const selected = candidates[0], bytes = await readChecked(root, `${selected.relative}/lifecycle.json`);
    if (bytes) {
      const lifecycle: unknown = JSON.parse(bytes.toString("utf8"));
      if (!record(lifecycle) || lifecycle.schemaVersion !== 1 || lifecycle.configurationId !== manifest.configurationId
        || !record(lifecycle.workflow) || lifecycle.workflow.kind !== selected.configuration.workflow.kind
        || lifecycle.workflow.version !== selected.configuration.workflow.version
        || typeof lifecycle.updatedAt !== "string" || !Number.isFinite(Date.parse(lifecycle.updatedAt))
        || !["active", "archived"].includes(String(lifecycle.status))) invalidConfiguration("Run Configuration lifecycle metadata is invalid.");
      if (lifecycle.status === "archived") invalidConfiguration("The selected Run Configuration is archived. Restore it or select another configuration.");
    }
    return selected.configuration;
  }
  const includedDirectory = `${workflowDirectory}/run-configurations`;
  const includedPath = await checkedPath(root, includedDirectory);
  const included: PreparedHeadlessSession["configuration"][] = [];
  // Included filenames need not equal their IDs (the scaffold uses codex-openai-v1.json).
  // Read only this declared workflow's directory, never another workflow's defaults.
  for (const name of (includedPath ? await readdir(includedPath) : []).filter(name => !name.startsWith(".") && name.endsWith(".json")).sort()) {
    const bytes = await readChecked(root, `${includedDirectory}/${name}`);
    if (!bytes) throw new Error("Included configuration changed during preparation.");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (record(value) && value.configurationId === manifest.configurationId) {
      included.push(validateConfiguration(value, manifest.workflowId, manifest.configurationId, slotIds));
    }
  }
  if (included.length > 1) invalidConfiguration("Multiple included files declare the selected configuration ID. Keep one unambiguous definition.");
  if (!included.length) invalidConfiguration("The selected Run Configuration was not found in this workflow's published store or included files.");
  return included[0];
}

export async function prepareHeadlessDebuggerSession(options: {
  projectRoot: string; store: FileRetainedExecutionStoreV1; manifest: HeadlessManifest; authorization: HeadlessAuthorization;
  hostRequirements: Record<string, string>; signal?: AbortSignal;
}): Promise<PreparedHeadlessSession> {
  return prepareHeadlessDebuggerSessionInternal(options, true);
}

async function prepareHeadlessDebuggerSessionInternal(options: {
  projectRoot: string; store: FileRetainedExecutionStoreV1; manifest: HeadlessManifest; authorization: HeadlessAuthorization;
  hostRequirements: Record<string, string>; signal?: AbortSignal;
}, resolveHostEnvironment: boolean): Promise<PreparedHeadlessSession> {
  const manifest = parseHeadlessManifest(options.manifest), authorization = parseHeadlessAuthorization(options.authorization, manifest.schemaVersion);
  cancelled(options.signal);
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.workflowId)) throw new HeadlessDebuggerError("project_invalid", "Select a declared workflow ID.");
  try { assertRunConfigurationId(manifest.configurationId); } catch { invalidConfiguration("Select a valid versioned Run Configuration ID."); }
  let root: string, prepared: Awaited<ReturnType<typeof prepareDeclaredRetainedWorkflowBuild>>;
  try {
    root = await realpath(options.projectRoot);
    prepared = await prepareDeclaredRetainedWorkflowBuild(options.store, { projectRoot: root,
      workflowId: manifest.workflowId, hostRequirements: options.hostRequirements });
  } catch { throw new HeadlessDebuggerError("project_invalid", "The declared workflow could not be retained. Validate project source and its retained construction declaration."); }
  cancelled(options.signal);
  const defaultMs = prepared.workflow.manifest.executionRequirements.run.maxDurationSeconds * 1000;
  const computeLimits = resolveHeadlessExecutionBudget(defaultMs, manifest, authorization);
  const agentSlotIds = [...prepared.workflow.declaration.agentSlots];
  let configuration: PreparedHeadlessSession["configuration"];
  try { configuration = await readConfiguration(root, manifest, agentSlotIds, path.posix.dirname(prepared.workflow.declaration.manifest)); }
  catch (error) {
    if (error instanceof HeadlessDebuggerError) throw error;
    invalidConfiguration("The selected Run Configuration is invalid or could not be read safely. Check its identity, slots and agent policies.");
  }
  let nonSecretEnvironment: Record<string, string> = {};
  if (resolveHostEnvironment) {
    try {
      const environmentFile = prepared.workflow.declaration.environment, bytes = await readChecked(root, environmentFile);
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== prepared.manifest.preparation?.inputFiles[environmentFile]) {
        throw new Error("Environment declaration changed after source validation.");
      }
      const declaration = validateWorkflowEnvironmentDeclaration(JSON.parse(bytes.toString("utf8")));
      const publicDeclaration = { schemaVersion: 1 as const,
        variables: declaration.variables.filter(variable => !variable.secret) };
      const values = await readChecked(root, ".env");
      nonSecretEnvironment = { ...resolveWorkflowEnvironment(publicDeclaration, values ? parseEnv(values.toString("utf8")) : {}) };
    } catch { throw new HeadlessDebuggerError("project_invalid", "Declared non-secret workflow variables could not be resolved safely. Check the environment declaration and project .env."); }
  }
  cancelled(options.signal);
  return { workflow: configuration.workflow, configuration, buildSha256: prepared.manifest.buildSha256,
    buildVersion: `${prepared.manifest.createdAt.replace(/[-:]/g, "")}-${prepared.manifest.buildSha256.slice(0, 16)}`,
    workflowContractVersion: prepared.workflow.manifest.workflowContractVersion, resultKind: prepared.workflow.declaration.result.kind,
    agentSlotIds, nonSecretEnvironment,
    credentialReferences: [...new Set(Object.values(configuration.agents).map(policy => validateAgentRunPolicy(policy).execution.authProvider))].sort(),
    executionProfile: { maxScratchBytes: 16 * 1024 * 1024, computeLimits },
    hostRequirements: { ...options.hostRequirements } };
}

/**
 * Selects and verifies the immutable Docker image before it reads or retains
 * project source. Returned environment and credentials are deliberately absent:
 * the container receives only the retained build, selected configuration and
 * declared mock inputs.
 */
export async function prepareDockerMockDebuggerSession(options: {
  projectRoot: string;
  store: FileRetainedExecutionStoreV1;
  manifest: HeadlessManifestV2;
  authorization: HeadlessAuthorizationV2;
  hostRequirements: Record<string, string>;
  imageSource: DebugImageSource;
  signal?: AbortSignal;
  ensureImage?: (source: DebugImageSource) => Promise<EnsuredDebugImage>;
}): Promise<PreparedDockerMockDebuggerSession> {
  const image = await (options.ensureImage ?? ensureDebugImage)(options.imageSource);
  cancelled(options.signal);
  // Docker mocks replace every host adapter, so preparation must not read or
  // validate the project's current .env values at all.
  const prepared = await prepareHeadlessDebuggerSessionInternal(options, false);
  cancelled(options.signal);
  let build: Awaited<ReturnType<FileRetainedExecutionStoreV1["readBuild"]>>;
  try { build = await options.store.readBuild(prepared.buildSha256); }
  catch { throw new HeadlessDebuggerError("project_invalid", "The retained workflow build could not be read safely. Validate the project and retry."); }
  const entry = build.files[build.manifest.entryPoint];
  const descriptorBytes = build.files[constructionDescriptorFile];
  if (!entry || !descriptorBytes) {
    throw new HeadlessDebuggerError("project_invalid", "The retained workflow build is missing its executable entry or construction descriptor.");
  }
  let construction: ReturnType<typeof constructionDescriptorSchema.parse>;
  try { construction = constructionDescriptorSchema.parse(JSON.parse(Buffer.from(descriptorBytes).toString("utf8"))); }
  catch { throw new HeadlessDebuggerError("project_invalid", "The retained workflow construction descriptor is invalid."); }
  const retainedAssets = Object.fromEntries(Object.entries(build.files)
    .filter(([name]) => name.startsWith("assets/"))
    .map(([name, bytes]) => [name.slice("assets/".length), Uint8Array.from(bytes)]));
  return {
    image,
    retainedCode: Buffer.from(entry).toString("utf8"),
    retainedAssets,
    buildSha256: prepared.buildSha256,
    buildVersion: prepared.buildVersion,
    workflow: prepared.workflow,
    configuration: { configurationId: prepared.configuration.configurationId,
      contentHash: runConfigurationContentHash(prepared.configuration) },
    // The debug container receives only the workflow construction entrypoint.
    // Host effect-adapter exports stay outside the sandbox and are replaced by
    // the case's declared mocks.
    construction: { schemaVersion: 1, export: construction.export },
    workflowContractVersion: prepared.workflowContractVersion,
    resultKind: prepared.resultKind,
    runConfiguration: prepared.configuration as PreparedDockerMockDebuggerSession["runConfiguration"],
    invocationModel: construction.invocationModel ?? "workflow-input",
    agentSlotIds: [...prepared.agentSlotIds],
  };
}
