import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createLocalAgentAuthProviderRegistry,
  resolveLocalFileStorePaths,
  type LocalWorkflowRegistration,
} from "@com-pyvue/agent-execution-local";
import {
  CompositeRunEventSink,
  FilePublishedResultStore,
  FileRunArtifactStore,
  FileRunPerformanceV2Store,
  FileRunStateV3Store,
  HeartbeatRunEventSink,
  JsonlRunEventSink,
  PerformanceCollector,
  RunStatusEventSink,
  createAgentExecutionProviderRegistry,
  createAgentProviderConfigProvider,
  redactAgentProviderConfig,
  type RunEvent,
  type RunManifestV3,
  type TrustedRunCommand,
  type WorkflowIdentity,
} from "@com-pyvue/agent-execution-core";
import { DECISION_BRIEF_RESULT_KIND, validateDecisionBriefInput, type DecisionBriefInput } from "./contract.js";
import { validateDecisionBriefRunConfiguration } from "./run-configuration.js";
import { runDecisionBriefWorkflow } from "./workflow.js";

const workflow: WorkflowIdentity = { kind: "decision-brief", version: 1 };

export async function createDecisionBriefLocalRegistration(
  repositoryRoot: string,
): Promise<LocalWorkflowRegistration<DecisionBriefInput>> {
  const inputExample = validateDecisionBriefInput(await readJsonFile(
    path.join(repositoryRoot, "workflows/decision-brief/fixtures/example-input.json"),
  ));
  return {
    workflow,
    title: "Decision Brief",
    description: "Turn evidence and constraints into a structured, reviewable architecture decision.",
    inputExample,
    agentSlots: [{
      slotId: "decision-author",
      title: "Decision author",
      description: "Analyzes the evidence and produces the structured decision brief.",
    }],
    validateInput: validateDecisionBriefInput,
    runConfigurationValidator: { workflow, validate: validateDecisionBriefRunConfiguration },
    runConfigurationBase: { schemaVersion: 1 },
    preflight: async ({ resolvedConfiguration }) => preflightRuntime(repositoryRoot, resolvedConfiguration.configuration),
    reserve: async (request) => reserveRun(repositoryRoot, request),
    execute: async (command) => executeRun(repositoryRoot, command),
  };
}

export async function preflightDecisionBrief(repositoryRoot: string, configurationValue: unknown) {
  return preflightRuntime(repositoryRoot, configurationValue);
}

async function preflightRuntime(repositoryRoot: string, configurationValue: unknown) {
  const configuration = validateDecisionBriefRunConfiguration(configurationValue);
  const policy = configuration.agents["decision-author"];
  try {
    const { executionProviders } = await resolveRuntime(repositoryRoot);
    const readiness = await executionProviders.get(policy.execution.provider).preflight({
      cwd: repositoryRoot,
      authProviderId: policy.execution.authProvider,
      parameters: policy.execution.parameters,
    });
    const auth = readiness.auth as typeof readiness.auth & {
      status?: "ready" | "unavailable" | "indeterminate";
      reason?: "session-missing" | "session-rejected" | "plan-or-billing-required" | "credential-invalid" | "provider-unavailable" | "unknown";
      identity?: { authMethod?: string; accountEmail?: string; reportedPlan?: string };
      executable?: { path: string; version?: string };
      remediation?: Array<{ kind: "login" | "upgrade" | "configure-api-key" | "retry"; label: string }>;
    };
    return {
      available: readiness.available,
      agents: [{
        slotId: "decision-author",
        providerId: policy.execution.provider,
        authProviderId: policy.execution.authProvider,
        available: readiness.available,
        status: auth.status ?? (readiness.available ? "ready" as const : "unavailable" as const),
        ...(auth.reason === undefined ? {} : { reason: auth.reason }),
        ...(auth.identity === undefined ? {} : { identity: auth.identity }),
        ...(auth.executable === undefined ? {} : { executable: auth.executable }),
        ...(auth.remediation === undefined ? {} : { remediation: auth.remediation }),
        ...(readiness.message === undefined ? {} : { message: readiness.message }),
      }],
    };
  } catch (error) {
    return {
      available: false,
      agents: [{
        slotId: "decision-author",
        providerId: policy.execution.provider,
        authProviderId: policy.execution.authProvider,
        available: false,
        status: "unavailable" as const,
        reason: "unknown" as const,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

type ReservationRequest = Parameters<LocalWorkflowRegistration<DecisionBriefInput>["reserve"]>[0];

async function reserveRun(repositoryRoot: string, request: ReservationRequest) {
  const runRef = { executionId: request.requestedExecutionId ?? `decision-brief-${Date.now()}-${randomUUID().slice(0, 8)}` };
  const runRoot = runRootFor(repositoryRoot, runRef.executionId);
  const state = stateStore(repositoryRoot, runRoot, runRef);
  const manifest: RunManifestV3 = {
    schemaVersion: 3,
    runRef,
    workflow,
    createdAt: new Date().toISOString(),
    actor: request.actor,
    runConfiguration: {
      configurationId: request.resolvedConfiguration.configuration.configurationId,
      contentHash: request.resolvedConfiguration.contentHash,
    },
  };
  await state.reserve();
  await state.create(manifest);
  const artifacts = new FileRunArtifactStore(runRoot);
  await artifacts.scope("state").writeJson("run-config.resolved.json", request.resolvedConfiguration.configuration);
  await artifacts.scope("artifacts").writeJson("input.json", request.input);
  return runRef;
}

async function executeRun(repositoryRoot: string, command: TrustedRunCommand<DecisionBriefInput>): Promise<void> {
  const runRoot = runRootFor(repositoryRoot, command.runRef.executionId);
  const stateRoot = path.join(runRoot, "state");
  const state = stateStore(repositoryRoot, runRoot, command.runRef);
  const stored = await state.get();
  if (!stored) throw new Error(`Reserved run ${command.runRef.executionId} does not exist.`);
  const configuration = validateDecisionBriefRunConfiguration(
    await readJsonFile(path.join(stateRoot, "run-config.resolved.json")),
    command.runConfiguration.configurationId,
  );
  const artifacts = new FileRunArtifactStore(runRoot);
  const performance = new PerformanceCollector(new FileRunPerformanceV2Store(stateRoot, command.runRef));
  const events = new CompositeRunEventSink<RunEvent>([
    new JsonlRunEventSink(artifacts.scope("artifacts")),
    new RunStatusEventSink(state),
    new HeartbeatRunEventSink(state),
    performance,
  ]);
  const results = new FilePublishedResultStore({ root: runRoot, resultId: ({ resultKind }) => `${resultKind}.json` });
  const startedAt = new Date();
  await events.emit({ type: "run-started", at: startedAt.toISOString(), manifest: stored.manifest });
  const stageId = "author-decision-brief";
  const stageStartedAt = new Date();
  await events.emit({ type: "stage-started", at: stageStartedAt.toISOString(), stageId });
  try {
    const { executionProviders, providerConfig } = await resolveRuntime(repositoryRoot);
    await artifacts.scope("state").writeJson("agent-provider-config.resolved.json", redactAgentProviderConfig(providerConfig));
    const policy = configuration.agents["decision-author"];
    const preflight = await executionProviders.get(policy.execution.provider).preflight({
      cwd: repositoryRoot,
      authProviderId: policy.execution.authProvider,
      parameters: policy.execution.parameters,
    });
    await events.emit({
      type: "agent-preflight-completed",
      at: new Date().toISOString(),
      stageId,
      logicalAgentId: "decision-author",
      providerId: policy.execution.provider,
      auth: preflight.auth,
    });
    if (!preflight.available) throw new Error(preflight.message ?? "Codex CLI is unavailable.");
    const payload = await runDecisionBriefWorkflow({
      cwd: repositoryRoot,
      artifactPrefix: path.join(runRoot, "artifacts/agents/decision-author/attempt-1"),
      policy,
      executionProviders,
      events,
    }, command.input);
    const completedAt = new Date();
    await events.emit({ type: "stage-completed", at: completedAt.toISOString(), stageId, elapsedMs: completedAt.getTime() - stageStartedAt.getTime() });
    await results.publish({ envelopeSchemaVersion: 1, resultKind: DECISION_BRIEF_RESULT_KIND, runRef: command.runRef, payload });
    await events.emit({ type: "run-completed", at: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await events.emit({ type: "stage-failed", at: new Date().toISOString(), stageId, elapsedMs: Date.now() - stageStartedAt.getTime(), message });
    await events.emit({ type: "run-failed", at: new Date().toISOString(), message });
    throw error;
  }
}

async function resolveRuntime(repositoryRoot: string) {
  const providerConfigProvider = await createAgentProviderConfigProvider({
    defaultConfigPath: path.join(repositoryRoot, "config/agent-providers.default.json"),
  });
  const providerConfig = await providerConfigProvider.resolve();
  const authProviders = await createLocalAgentAuthProviderRegistry({ repositoryRoot, providerConfig });
  return { providerConfig, executionProviders: createAgentExecutionProviderRegistry(providerConfig, authProviders) };
}

function runRootFor(repositoryRoot: string, executionId: string): string {
  return path.join(resolveLocalFileStorePaths(repositoryRoot).runs, workflow.kind, executionId);
}

function stateStore(repositoryRoot: string, runRoot: string, runRef: { executionId: string }) {
  return new FileRunStateV3Store({
    root: path.join(runRoot, "state"),
    reservationRoot: resolveLocalFileStorePaths(repositoryRoot).reservations,
    runRef,
  });
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
