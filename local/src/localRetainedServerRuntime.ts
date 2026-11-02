/** Private server composition. Developer projects never construct these stores/services. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { activeComputeLimitsSchema } from "../../core/src/application/activeCompute.ts";
import { canonicalWorkflowJson, workflowManifestDigest, type WorkflowManifestV1 } from "../../core/src/application/workflowManifest.ts";
import type { WorkflowDeclarationWithConstruction } from "../../core/src/application/retainedWorkflowDeclaration.ts";
import { validateAgentRunPolicy } from "../../core/src/application/runConfiguration.ts";
import { validateRunRef } from "../../core/src/domain/runIdentity.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { LocalRetainedRunService } from "./localRetainedRunService.ts";
import { createLocalRetainedRuntime } from "./localRetainedRuntime.ts";
import type { LocalDebugger } from "./localDebugger.ts";
import { readPortableRetainedInputs } from "./portableWorkflow.ts";
import { readLocalWorkflowDeclarationBinding } from "./workflowDeclarations.ts";
import type { LocalWorkflowRegistration } from "./index.ts";
import { ApplicationBoundaryError } from "../../apps/packages/application-host/src/authorization.ts";
import type { CodedWorkflowPreflightRequest } from "../../apps/packages/run/api/src/workflowRegistry.ts";
import { describeLocalRetainedGraph, prepareLocalRetainedGraphInput } from "./localRetainedRunAdmission.ts";
import { FileRunCorrectionLinks } from "./fileRunCorrectionLinks.ts";
import { resolveLocalExecutionDataPaths } from "./localStorePaths.ts";
import { loadLocalWorkflowSecretValues } from "./workflowEnvironment.ts";

export interface RetainedServerAdmissionOptions {
  workflowIds: readonly string[];
  /** CLI-owned source checking and bundling, used only for NEW Runs. */
  prepareBuild(store: FileRetainedExecutionStoreV1, workflowId: string, hostRequirements: Record<string, string>): Promise<{
    buildSha256: string; manifest: WorkflowManifestV1; declaration: WorkflowDeclarationWithConstruction;
  }>;
}

export async function createLocalRetainedServerRuntime(options: {
  projectRoot: string; workflows: readonly LocalWorkflowRegistration[]; admission: RetainedServerAdmissionOptions;
  workerPath?: string;
  debuggerSession?: LocalDebugger;
  onFrameworkError?: import("../../core/src/application/frameworkErrors.ts").FrameworkErrorObserver;
  onFirstValidTypedResult?(event: { elapsedMs: number }): Promise<void>;
  onRunSettled?(event: { executionId: string; status: "complete" | "failed" | "cancelled"; elapsedMs: number }): Promise<void>;
}) {
  const runtime = await createLocalRetainedRuntime({ projectRoot: options.projectRoot,
    workerPath: options.workerPath, debuggerSession: options.debuggerSession,
    onFirstValidTypedResult: options.onFirstValidTypedResult,
    onRunSettled: options.onRunSettled,
    onFrameworkError: options.onFrameworkError,
    async resolveEffectCredentials(binding, signal) {
      if (signal.aborted) throw new Error("Effect credential resolution was cancelled.");
      const values = await loadLocalWorkflowSecretValues(options.projectRoot, binding.effectSecretNames ?? []);
      if (signal.aborted) throw new Error("Effect credential resolution was cancelled.");
      return Object.freeze({ ...values });
    } });
  const { store, hostRequirements } = runtime;
  const service = new LocalRetainedRunService(runtime.runs.options, runtime.runs);
  const corrections = new FileRunCorrectionLinks(path.join(
    resolveLocalExecutionDataPaths(options.projectRoot).root,
    "run-corrections",
  ));
  try {
    const adapt = (registrations: readonly LocalWorkflowRegistration[], admission: RetainedServerAdmissionOptions) => {
    const selected = new Set(admission.workflowIds);
    if (selected.size !== admission.workflowIds.length
      || [...selected].some(id => registrations.filter(w => w.workflow.kind === id).length !== 1)) {
      throw new Error("Retained workflow selection does not match the loaded registry.");
    }
    return registrations.map(registration => {
      if (!selected.has(registration.workflow.kind)) return registration;
      const metadata = readLocalWorkflowDeclarationBinding(registration), inputs = readPortableRetainedInputs(registration);
      const computeLimits = activeComputeLimitsSchema.parse({ totalMs: inputs.maxDurationMs,
        attemptMs: inputs.maxDurationMs, finalizationReserveMs: inputs.finalizationReserveMs });
      if (metadata.manifest.workflowMode !== "arkimux-portable") throw new Error("Retained workflow must be portable.");
      const prepareCheckedBuild = async () => {
        const build = await admission.prepareBuild(store, registration.workflow.kind, { ...hostRequirements }).catch(() => {
          // Source/bundler exceptions can contain project data. Return a fixed,
          // actionable admission failure through the existing API boundary.
          throw new ApplicationBoundaryError("invalid-request", 409,
            "The retained workflow could not be prepared. Validate the project and restart the Local server before submitting a Run.");
        });
        if (!build.declaration.construction || workflowManifestDigest(build.manifest) !== workflowManifestDigest(metadata.manifest)
          || canonicalWorkflowJson(build.declaration.result) !== canonicalWorkflowJson(metadata.result)
          || build.declaration.environment !== metadata.environment.file
          || canonicalWorkflowJson([...build.declaration.agentSlots].sort()) !== canonicalWorkflowJson((registration.agentSlots ?? []).map(s => s.slotId).sort())) {
          throw new ApplicationBoundaryError("invalid-request", 409, "Retained source differs from the loaded workflow. Restart the Local server.");
        }
        return build;
      };
      const validateConfigurationSlots = (configuration: Record<string, unknown>) => {
        const agents = configuration.agents;
        if (!agents || typeof agents !== "object" || Array.isArray(agents)
          || canonicalWorkflowJson(Object.keys(agents).sort()) !== canonicalWorkflowJson((registration.agentSlots ?? []).map(s => s.slotId).sort())) {
          throw new Error("Run Configuration must match the retained agent slots.");
        }
        return agents as Record<string, unknown>;
      };
      const retained = service.registration({ ...registration, prepareBinding: async request => {
        const build = await prepareCheckedBuild();
        const configuration = request.resolvedConfiguration.configuration;
        const agents = validateConfigurationSlots(configuration);
        const credentialReferences = [...new Set(Object.values(agents).map(policy => validateAgentRunPolicy(policy).execution.authProvider))].sort();
        const runRef = validateRunRef({ executionId: request.requestedExecutionId ?? `${request.workflow.kind}-${Date.now()}-${randomUUID().slice(0, 8)}` });
        const createdAt = new Date().toISOString();
        const runConfiguration = { configurationId: configuration.configurationId, contentHash: request.resolvedConfiguration.contentHash };
        const base = { id: runRef.executionId, buildSha256: build.buildSha256, workflow: inputWaitJsonSnapshot(request.workflow),
          runConfiguration: inputWaitJsonSnapshot(configuration),
          executionProfile: { maxScratchBytes: inputs.maxScratchBytes, computeLimits },
          nonSecretEnvironment: { ...inputs.environment },
          effectSecretNames: metadata.environment.declaration.variables.filter(variable => variable.secret).map(variable => variable.name).sort(),
          credentialReferences, hostRequirements: { ...hostRequirements },
          runManifest: { schemaVersion: 3 as const, runRef, workflow: request.workflow, actor: request.actor, runConfiguration, createdAt } };
        if (registration.invocationModel === "graph-entry") {
          const graphInput = await prepareLocalRetainedGraphInput(store, { buildSha256: build.buildSha256,
            hostRequirements: { ...hostRequirements }, runConfiguration: inputWaitJsonSnapshot(configuration),
            request: request.input, identity: { runRef, runConfiguration, executableBindingId: runRef.executionId,
              buildSha256: build.buildSha256, createdAt, requestId: `graph-${randomUUID()}` },
            agentSlotIds: (registration.agentSlots ?? []).map(slot => slot.slotId), workerPath: options.workerPath });
          return { binding: { ...base, invocation: inputWaitJsonSnapshot(graphInput.invocation) },
            graphInput, admittedInput: inputWaitJsonSnapshot(request.input) };
        }
        return { ...base, invocation: inputWaitJsonSnapshot({ schemaVersion: 1, runRef, workflow: request.workflow,
          workflowContractVersion: build.manifest.workflowContractVersion, resultKind: build.declaration.result.kind,
          runConfiguration, input: request.input, createdAt }) };
      } });
      return { ...retained,
        describeInvocation: registration.invocationModel === "graph-entry" ? async (request: CodedWorkflowPreflightRequest) => {
          const build = await prepareCheckedBuild();
          const configuration = request.resolvedConfiguration.configuration;
          validateConfigurationSlots(configuration);
          const description = await describeLocalRetainedGraph(store, {
            buildSha256: build.buildSha256,
            hostRequirements: { ...hostRequirements },
            runConfiguration: inputWaitJsonSnapshot(configuration),
            agentSlotIds: (registration.agentSlots ?? []).map(slot => slot.slotId),
            workerPath: options.workerPath,
          });
          return { model: "graph-entry" as const, ...description };
        } : retained.describeInvocation,
        runConfigurationValidator: registration.runConfigurationValidator };
    });
    };
    const workflows = adapt(options.workflows, options.admission);
    return {
      workflows,
      isIdle: () => runtime.runs.isIdle(),
      stopComputing: () => runtime.runs.close(),
      /** Prepare immutable admission inputs on the existing store. No second runtime. */
      async prepareCandidate(registrations: readonly LocalWorkflowRegistration[], admission: RetainedServerAdmissionOptions) {
        // Validate selection/metadata before spending time building any candidate.
        adapt(registrations, admission);
        const builds = new Map<string, Awaited<ReturnType<RetainedServerAdmissionOptions["prepareBuild"]>>>();
        const releases: (() => Promise<void>)[] = [];
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          const results = await Promise.allSettled(releases.map(release => release()));
          const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failure) throw failure.reason;
        };
        try {
          for (const id of admission.workflowIds) {
            const build = await admission.prepareBuild(store, id, { ...hostRequirements });
            const registration = registrations.find(w => w.workflow.kind === id)!;
            const metadata = readLocalWorkflowDeclarationBinding(registration);
            if (!build.declaration.construction || workflowManifestDigest(build.manifest) !== workflowManifestDigest(metadata.manifest)
              || canonicalWorkflowJson(build.declaration.result) !== canonicalWorkflowJson(metadata.result)
              || build.declaration.environment !== metadata.environment.file
              || canonicalWorkflowJson([...build.declaration.agentSlots].sort()) !== canonicalWorkflowJson((registration.agentSlots ?? []).map(s => s.slotId).sort())) {
              throw new Error("Prepared retained build differs from candidate registration.");
            }
            releases.push(await store.holdBuild(build.buildSha256));
            builds.set(id, build);
          }
          return { workflows: adapt(registrations, { workflowIds: admission.workflowIds,
            async prepareBuild(_store, id) {
              if (released) throw new Error("Registry candidate is no longer active.");
              const build = builds.get(id);
              if (!build) throw new Error("Registry has no prepared build for this workflow.");
              return build;
            } }), release };
        } catch (error) { await release(); throw error; }
      },
      inputRequests: service.inputRequests,
      corrections,
      retainedRunIds: runtime.retainedRunIds,
      recover: runtime.recover,
      close: runtime.close,
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
