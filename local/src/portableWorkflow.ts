import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DurableExecutionTerminalError } from "../../core/src/application/durableExecution.ts";
import { ExternalProviderError, getExternalErrorDiagnostic, publicErrorMessage } from "../../core/src/application/externalError.ts";
import {
  CompositeRunEventSink, FilePublishedResultStore, FileRunArtifactStore,
  FileRunPerformanceV2Store, FileRunStateV3Store, JsonlRunEventSink, PerformanceCollector,
  createAgentExecutionProviderRegistry, createAgentProviderConfigProvider,
  validateAgentRunPolicy, validateWorkflowIdentity, validateRunRef, runConfigurationContentHash,
  parseStructuredJsonOutput,
  resolveCliExecutable,
  type AgentRunPolicy, type RunEvent, type RunRef, type WorkflowIdentity,
} from "../../core/src/index.ts";
import type { DeepReadonly, JsonValue, ValueValidatorV1, WorkflowExecutionContextV1, DurableAgentOperationExecutorV1 } from "../../core/src/application/durableWorkflow.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { DurableWorkflowEngineV2 } from "../../core/src/application/durableWorkflowEngine.ts";
import { DurableWorkflowRunExecutorV2 } from "../../core/src/application/durableWorkflowRun.ts";
import { createLocalDurableExecutionStorage, createLocalWorkflowInvocationStore, LocalWholeRunExecutionHostV1, listInterruptedLocalRuns } from "./localDurableWorkflowRuntime.ts";
import { createLocalAgentAuthProviderRegistry, type LocalWorkflowRegistration } from "./index.ts";
import { resolveLocalFileStorePaths } from "./localStorePaths.ts";
import { loadLocalWorkflowEnvironment, type WorkflowEnvironmentDeclaration } from "./workflowEnvironment.ts";
import { canonicalWorkflowJson, validateWorkflowManifestV1, type WorkflowManifestV1 } from "../../core/src/application/workflowManifest.ts";
import { readDeclaredWorkflowEnvironment, withLocalWorkflowDeclaration } from "./workflowDeclarations.ts";
import { validateWorkflowEnvironmentDeclaration } from "./workflowEnvironment.ts";

export interface PortableWorkflowDefinition<Input extends JsonValue, Output extends JsonValue> {
  workflow: WorkflowIdentity;
  workflowContractVersion: string;
  resultKind: string;
  input: ValueValidatorV1<Input>;
  output: ValueValidatorV1<Output>;
  execute(context: WorkflowExecutionContextV1, input: DeepReadonly<Input>): Promise<Output>;
}

export interface LocalPortableWorkflowOptions<Input extends JsonValue, Output extends JsonValue> {
  repositoryRoot: string;
  workflow: WorkflowIdentity;
  title: string;
  description: string;
  inputExample: Input;
  input: ValueValidatorV1<Input>;
  environment: WorkflowEnvironmentDeclaration;
  /** Called once at server startup without environment or credential authority. */
  define(): PortableWorkflowDefinition<Input, Output>;
  agentSlots: readonly { slotId: string; title: string; description: string; prompt: string }[];
  maxDurationMs: number;
  finalizationReserveMs: number;
  manifest?: WorkflowManifestV1;
  /** Required with a manifest; names-only source checked before loading values. */
  environmentFile?: string;
  resultSchemaVersion?: number;
}

export interface LocalGraphWorkflowOptions<Input extends JsonValue, Output extends JsonValue>
  extends Omit<LocalPortableWorkflowOptions<Input, Output>, "define"> {
  workflowContractVersion: string;
  resultKind: string;
  output: ValueValidatorV1<Output>;
}

interface Configuration {
  schemaVersion: 1;
  configurationId: string;
  workflow: WorkflowIdentity;
  agents: Record<string, AgentRunPolicy>;
  [key: string]: unknown;
}
const recoveries = new WeakMap<object, (skip?: ReadonlySet<string>) => Promise<void>>();
// Private admission metadata. This does not add a project-facing factory option.
const retainedInputs = new WeakMap<object, {
  environment: Record<string, string>; maxDurationMs: number; finalizationReserveMs: number; maxScratchBytes: number;
}>();
const portableScratchBytes = 16 * 1024 * 1024;
export function readPortableRetainedInputs(registration: object) {
  const inputs = retainedInputs.get(registration);
  if (!inputs) throw new Error("Retained execution requires a portable workflow registration.");
  return structuredClone(inputs);
}

/** Public registration boundary. Engine, stores, provider composition and recovery stay in Local. */
export async function createLocalPortableWorkflow<Input extends JsonValue, Output extends JsonValue>(
  options: LocalPortableWorkflowOptions<Input, Output>,
): Promise<LocalWorkflowRegistration<Input>> {
  const root = path.resolve(options.repositoryRoot);
  const workflow = validateWorkflowIdentity(options.workflow);
  const resultSchemaVersion = options.resultSchemaVersion ?? 1;
  const enforceResultVersion = options.manifest !== undefined || options.resultSchemaVersion !== undefined;
  const environmentFile = options.environmentFile;
  if (!Number.isSafeInteger(resultSchemaVersion) || resultSchemaVersion < 1) throw new Error("Result schema version must be a positive integer.");
  const environmentDeclaration = validateWorkflowEnvironmentDeclaration(options.environment);
  if (options.manifest) {
    if (!environmentFile) throw new Error("A declared workflow requires environmentFile.");
    const declared = await readDeclaredWorkflowEnvironment(root, environmentFile);
    if (canonicalWorkflowJson(declared) !== canonicalWorkflowJson(environmentDeclaration)) {
      throw new Error("Workflow environment options differ from environmentFile.");
    }
  }
  const paths = resolveLocalFileStorePaths(root);
  // Snapshot before the server accepts submissions; never recover a newly submitted run.
  const interruptedAtStartup = await listInterruptedLocalRuns(root);
  const publicEnvironmentDeclaration = { schemaVersion: 1 as const,
    variables: environmentDeclaration.variables.filter(variable => !variable.secret) };
  const nonSecretEnvironment = await loadLocalWorkflowEnvironment(root, publicEnvironmentDeclaration);
  // Workflow registration and construction receive no environment values.
  // Host-owned effect adapters resolve declared values separately.
  const definition = options.define();
  if (definition.workflow.kind !== workflow.kind || definition.workflow.version !== workflow.version) throw new Error("Portable definition identity does not match its registration.");
  if (options.manifest) {
    const manifest = validateWorkflowManifestV1(options.manifest);
    if (manifest.workflowMode !== "arkimux-portable" || manifest.workflowId !== workflow.kind
      || manifest.workflowContractVersion !== definition.workflowContractVersion || options.input !== definition.input
      || manifest.executionRequirements.run.maxDurationSeconds * 1000 !== options.maxDurationMs) {
      throw new Error("Portable definition, validators or run deadline do not match the manifest.");
    }
  }
  const slots = new Map(options.agentSlots.map((slot) => [slot.slotId, slot]));
  if (slots.size !== options.agentSlots.length) throw new Error("Agent slot IDs must be unique.");
  const providerEnvironment = { ...process.env };
  for (const variable of environmentDeclaration.variables) delete providerEnvironment[variable.name];
  const validateConfiguration = (value: unknown, expectedId?: string): Configuration => {
    const config = value as Configuration;
    if (!config || config.schemaVersion !== 1 || typeof config.configurationId !== "string"
      || (expectedId !== undefined && config.configurationId !== expectedId)
      || config.workflow?.kind !== workflow.kind || config.workflow?.version !== workflow.version
      || !config.agents || Object.keys(config.agents).length !== slots.size) throw new Error("Run Configuration must match the workflow and its exact agent slots.");
    for (const id of slots.keys()) validateAgentRunPolicy(config.agents[id]);
    return structuredClone(config);
  };
  const runtime = async () => {
    const config = await (await createAgentProviderConfigProvider({
      defaultConfigPath: path.join(root, "config/agent-providers.default.json"), environment: providerEnvironment,
    })).resolve();
    for (const provider of Object.values(config.executionProviders)) {
      provider.environmentAllowlist = provider.environmentAllowlist.filter((name) => !environmentDeclaration.variables.some((variable) => variable.name === name));
      const executable = await resolveCliExecutable(provider.command, root, providerEnvironment);
      if (executable) provider.command = executable.command;
    }
    const auth = await createLocalAgentAuthProviderRegistry({ repositoryRoot: root, providerConfig: config, environment: providerEnvironment });
    return createAgentExecutionProviderRegistry(config, auth, providerEnvironment);
  };
  const preflight = async (configuration: Configuration) => {
    const providers = await runtime();
    const agents = await Promise.all([...slots.keys()].map(async (slotId) => {
      const policy = configuration.agents[slotId];
      const readiness = await providers.get(policy.execution.provider).preflight({ cwd: root, authProviderId: policy.execution.authProvider, parameters: policy.execution.parameters });
      const externalDiagnostic = getExternalErrorDiagnostic(readiness) ?? getExternalErrorDiagnostic(readiness.auth);
      return { slotId, providerId: policy.execution.provider, authProviderId: policy.execution.authProvider, available: readiness.available,
        ...(readiness.message ? { message: readiness.message } : {}), ...(externalDiagnostic ? { externalDiagnostic } : {}) };
    }));
    return { available: agents.every((agent) => agent.available), agents };
  };
  const runRoot = (ref: RunRef) => path.join(paths.runs, ref.executionId);
  const state = (ref: RunRef) => new FileRunStateV3Store({ root: path.join(runRoot(ref), "state"), reservationRoot: paths.reservations, runRef: ref });
  const host = new LocalWholeRunExecutionHostV1({ repositoryRoot: root });
  const active = new Set<string>();
  const execute = async (ref: RunRef) => {
    if (active.has(ref.executionId)) throw new Error("Run already has an active Local attempt.");
    active.add(ref.executionId);
    let events: CompositeRunEventSink<RunEvent> | undefined;
    try {
      const invocationStore = createLocalWorkflowInvocationStore(root, ref);
      const invocation = await invocationStore.read<Input>(ref);
      if (!invocation) throw new Error("Run has no immutable invocation.");
      const runState = state(ref);
      const stored = await runState.get();
      if (stored?.status?.status === "complete" || stored?.status?.status === "failed"
        || stored?.status?.status === "cancelled") return;
      const configuration = validateConfiguration(JSON.parse(await readFile(path.join(runRoot(ref), "state/run-config.resolved.json"), "utf8")), invocation.runConfiguration.configurationId);
      if (runConfigurationContentHash(configuration) !== invocation.runConfiguration.contentHash) throw new Error("Stored Run Configuration hash does not match the invocation.");
      const readiness = await preflight(configuration);
      if (!readiness.available) {
        const diagnostic = getExternalErrorDiagnostic(readiness.agents.find(agent => !agent.available));
        if (diagnostic) throw new ExternalProviderError(diagnostic.provider, diagnostic.message, { code: diagnostic.code, httpStatus: diagnostic.httpStatus });
        throw new Error("Agent connection is unavailable.");
      }
      const providers = await runtime();
      const artifacts = new FileRunArtifactStore(runRoot(ref));
      events = new CompositeRunEventSink<RunEvent>([
        new JsonlRunEventSink(artifacts.scope("artifacts")),
        new PerformanceCollector(new FileRunPerformanceV2Store(path.join(runRoot(ref), "state"), ref)),
      ]);
      if (!stored) throw new Error("Run manifest is missing.");
      await events.emit({ type: "run-started", at: new Date().toISOString(), manifest: stored.manifest });
      const attempt = await host.nextAttempt(ref, { maxDurationMs: options.maxDurationMs, finalizationReserveMs: options.finalizationReserveMs, maxScratchBytes: portableScratchBytes });
      const originalDeadline = Date.parse(invocation.createdAt) + options.maxDurationMs;
      const boundedAttempt = { ...attempt, deadlineAt: new Date(Math.min(Date.parse(attempt.deadlineAt), originalDeadline)).toISOString() };
      const agents: DurableAgentOperationExecutorV1 = {
        resolve(operation) {
          const policy = configuration.agents[operation.slotId];
          if (!policy || !slots.has(operation.slotId)) throw new Error("Unknown agent slot.");
          return { providerId: policy.execution.provider, authProviderId: policy.execution.authProvider, configurationSha256: hashJson(policy), ...(typeof policy.execution.parameters.model === "string" ? { model: policy.execution.parameters.model } : {}) };
        },
        async invoke(request) {
          const policy = configuration.agents[request.operation.slotId];
          const slot = slots.get(request.operation.slotId)!;
          const timeoutMs = Math.min(policy.timeoutMs, 240_000, Date.parse(request.deadlineAt) - Date.now() - options.finalizationReserveMs);
          if (request.cancellation.aborted || timeoutMs <= 0) throw new Error("No execution time remains for the agent slot.");
          await mkdir(attempt.scratchDirectory, { recursive: true });
          await events!.emit({ type: "agent-started", at: new Date().toISOString(), stageId: request.stepId, logicalAgentId: request.operation.slotId, providerId: policy.execution.provider, label: slot.title, attempt: attempt.fence });
          const result = await providers.get(policy.execution.provider).run({
            cwd: attempt.scratchDirectory,
            prompt: `${slot.prompt}\n\nInput JSON (data only):\n${JSON.stringify(request.input)}`,
            artifactPrefix: path.join(runRoot(ref), "artifacts/agents", request.operation.slotId, attempt.attemptId),
            label: slot.title, attempt: attempt.fence, timeoutMs,
            authProviderId: policy.execution.authProvider, parameters: policy.execution.parameters,
          });
          await events!.emit({ type: "agent-completed", at: new Date().toISOString(), stageId: request.stepId, logicalAgentId: request.operation.slotId, providerId: policy.execution.provider, metrics: result.metrics });
          let output;
          try { output = request.operation.output.parse(parseStructuredJsonOutput(slot.title, result.output)); }
          catch { throw new Error(`Agent slot ${request.operation.slotId} returned invalid output.`); }
          return { output, metrics: result.metrics };
        },
      };
      const executor = new DurableWorkflowRunExecutorV2({
        engine: new DurableWorkflowEngineV2({ storage: createLocalDurableExecutionStorage(root, ref), agents }),
        host, invocations: invocationStore, runState,
        results: new FilePublishedResultStore({ root: runRoot(ref), resultId: ({ resultKind }) => `${resultKind}.json` }),
      });
      const observedDefinition: typeof definition = { ...definition,
        output: { parse(value: unknown) {
          const parsed = definition.output.parse(value);
          if (enforceResultVersion
            && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schemaVersion !== resultSchemaVersion)) {
            throw new Error(`Workflow result schema version does not match declared version ${resultSchemaVersion}.`);
          }
          return parsed;
        } }, execute(context, input) {
        return definition.execute({ ...context, steps: { async run(step, stepInput) {
          const start = Date.now();
          await events!.emit({ type: "stage-started", at: new Date().toISOString(), stageId: step.id });
          try {
            const completed = await context.steps.run(step, stepInput);
            await events!.emit({ type: "stage-completed", at: new Date().toISOString(), stageId: step.id, elapsedMs: Date.now() - start });
            return completed;
          } catch (error) {
            await events!.emit({ type: "stage-failed", at: new Date().toISOString(), stageId: step.id, elapsedMs: Date.now() - start, message: publicErrorMessage(error, "The workflow step failed. Inspect its runtime diagnostics before retrying.") });
            throw error;
          }
        } } }, input);
      } };
      const outcome = await executor.execute({ attempt: boundedAttempt, invocation, definition: observedDefinition });
      if (outcome.status !== "complete") throw new DurableExecutionTerminalError(outcome.code, outcome.message, { cause: outcome });
      await events.emit({ type: "run-completed", at: new Date().toISOString() });
    } catch (error) {
      const message = publicErrorMessage(error, "The workflow failed. Inspect its runtime diagnostics before retrying.");
      await events?.emit({ type: "run-failed", at: new Date().toISOString(), message });
      await state(ref).update({ kind: "status", status: "failed", updatedAt: new Date().toISOString(), message });
      throw error;
    } finally { active.delete(ref.executionId); }
  };
  const registration: LocalWorkflowRegistration<Input> = {
    workflow, title: options.title, description: options.description, inputExample: options.inputExample,
    agentSlots: options.agentSlots.map(({ slotId, title, description }) => ({ slotId, title, description })),
    validateInput: (value) => options.input.parse(value),
    runConfigurationBase: { schemaVersion: 1 },
    runConfigurationValidator: { workflow, validate: validateConfiguration },
    preflight: ({ resolvedConfiguration }) => preflight(validateConfiguration(resolvedConfiguration.configuration)),
    async reserve(request) {
      const ref = validateRunRef({ executionId: request.requestedExecutionId ?? `${workflow.kind}-${Date.now()}-${randomUUID().slice(0, 8)}` });
      const configuration = validateConfiguration(request.resolvedConfiguration.configuration);
      const input = options.input.parse(request.input);
      const store = state(ref);
      await store.reserve();
      const createdAt = new Date().toISOString();
      const runConfiguration = { configurationId: configuration.configurationId, contentHash: request.resolvedConfiguration.contentHash };
      await store.create({ schemaVersion: 3, runRef: ref, workflow, createdAt, actor: request.actor, runConfiguration });
      const artifacts = new FileRunArtifactStore(runRoot(ref));
      await artifacts.scope("state").writeJson("run-config.resolved.json", configuration);
      await artifacts.scope("artifacts").writeJson("input.json", input);
      await createLocalWorkflowInvocationStore(root, ref).create({ schemaVersion: 1, runRef: ref, workflow, workflowContractVersion: definition.workflowContractVersion, resultKind: definition.resultKind, input: input as DeepReadonly<Input>, runConfiguration, createdAt });
      return ref;
    },
    execute: (command) => execute(command.runRef),
  };
  retainedInputs.set(registration, { environment: { ...nonSecretEnvironment }, maxDurationMs: options.maxDurationMs,
    finalizationReserveMs: options.finalizationReserveMs, maxScratchBytes: portableScratchBytes });
  recoveries.set(registration, async (skip) => {
    for (const ref of interruptedAtStartup) {
      if (skip?.has(ref.executionId)) continue;
      const invocation = await createLocalWorkflowInvocationStore(root, ref).read(ref);
      if (invocation?.workflow.kind === workflow.kind && invocation.workflow.version === workflow.version) await execute(ref);
    }
  });
  return options.manifest ? withLocalWorkflowDeclaration(registration, {
    manifest: options.manifest, inputValidator: definition.input, resultValidator: definition.output,
    result: { kind: definition.resultKind, schemaVersion: resultSchemaVersion },
    environment: { file: environmentFile!, declaration: environmentDeclaration },
  }) : registration;
}

/** Register graph metadata without constructing project graph code in the API process.
 * The declared retained constructor is the sole graph construction path. */
export async function createLocalGraphWorkflow<Input extends JsonValue, Output extends JsonValue>(
  options: LocalGraphWorkflowOptions<Input, Output>,
): Promise<LocalWorkflowRegistration<Input>> {
  const registration = await createLocalPortableWorkflow({
    ...options,
    define: () => ({
      workflow: options.workflow,
      workflowContractVersion: options.workflowContractVersion,
      resultKind: options.resultKind,
      input: options.input,
      output: options.output,
      async execute() {
        throw new Error("Graph workflows execute only through the retained graph runtime.");
      },
    }),
  });
  registration.invocationModel = "graph-entry";
  return registration;
}

export async function recoverPortableWorkflows(registrations: readonly LocalWorkflowRegistration[], skip?: ReadonlySet<string>): Promise<void> {
  for (const registration of registrations) await recoveries.get(registration)?.(skip);
}
