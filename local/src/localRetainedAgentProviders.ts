/** Current host credentials and native runtimes for an immutable retained Run. */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  createAgentExecutionProviderRegistry, createAgentProviderConfigProvider, resolveCliExecutable,
  validateAgentRunPolicy, parseStructuredJsonOutput, runConfigurationContentHash,
} from "../../core/src/index.ts";
import { hashJson, type DeepReadonly, type DurableAgentBindingV1 } from "../../core/src/application/durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { validateWorkflowInvocationV1, type WorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import type { GraphRunInvocationV1 } from "../../core/src/application/graphInvocationRecords.ts";
import { ownerSchema, type ExecutableBindingV1, type RetainedOwnerV1 } from "../../core/src/application/retainedExecution.ts";
import { AgentProcessCleanupError, AgentResourceCleanupError, assertAgentNotCancelled } from "../../core/src/infrastructure/agents/agentProcessLifetime.ts";
import { createLocalAgentAuthProviderRegistry } from "./localAgentAuthProviderRegistry.ts";
import { resolveLocalExecutionDataPaths } from "./localStorePaths.ts";
import { resolveLocalDurableExecutionPaths } from "./localDurableWorkflowRuntime.ts";
import { debuggerEnvironmentNames } from "./localDebugger.ts";
import type { PreparedRetainedAgentsV1 } from "./localRetainedWorkflowRunner.ts";

const configSchema = z.object({ schemaVersion: z.literal(1), configurationId: z.string(),
  workflow: z.unknown(), agents: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.unknown()) });

export async function prepareLocalRetainedAgentProviders(options: {
  projectRoot: string; executionDataRoot?: string; binding: DeepReadonly<ExecutableBindingV1>; signal: AbortSignal;
  prompts: Readonly<Record<string, string>>; owner: RetainedOwnerV1;
  invocation?: DeepReadonly<WorkflowInvocationV1 | GraphRunInvocationV1>;
}): Promise<PreparedRetainedAgentsV1> {
  assertAgentNotCancelled(options.signal);
  const root = path.resolve(options.projectRoot), owner = ownerSchema.parse(options.owner);
  const invocation = options.invocation ?? validateWorkflowInvocationV1(inputWaitJsonSnapshot(options.binding.invocation));
  const savedConfiguration = inputWaitJsonSnapshot(options.binding.runConfiguration);
  const configuration = configSchema.parse(savedConfiguration);
  if (runConfigurationContentHash(savedConfiguration) !== invocation.runConfiguration.contentHash
    || configuration.configurationId !== invocation.runConfiguration.configurationId
    || hashJson(inputWaitJsonSnapshot(configuration.workflow)) !== hashJson(inputWaitJsonSnapshot(invocation.workflow))) {
    throw new Error("Retained agent configuration does not match the admitted Run.");
  }
  const prompts = Object.freeze({ ...options.prompts });
  if (JSON.stringify(Object.keys(configuration.agents).sort()) !== JSON.stringify(Object.keys(prompts).sort())) {
    throw new Error("Retained prompts must match the configured agent slots.");
  }
  const policies = Object.fromEntries(Object.entries(configuration.agents).map(([slot, value]) => [slot, validateAgentRunPolicy(value)]));
  for (const policy of Object.values(policies)) {
    if (!options.binding.credentialReferences.includes(policy.execution.authProvider)) throw new Error("Retained agent references an unbound Connection.");
  }
  // A pure workflow has no provider dependency. Keep identity/prompt checks above,
  // but do not read provider configuration, look up executables or resolve secrets.
  if (Object.keys(policies).length === 0) {
    return { bindings: Object.freeze({}), async invoke() { throw new Error("This Run has no configured agent slots."); }, async close() {} };
  }

  // Workflow settings belong to the retained worker, never native provider env.
  // Provider keys remain in the current host registry, not the saved binding.
  const environment = { ...process.env };
  const excluded = new Set([...Object.keys(options.binding.nonSecretEnvironment), ...debuggerEnvironmentNames]);
  for (const name of excluded) delete environment[name];
  const runtime = await (await createAgentProviderConfigProvider({
    defaultConfigPath: path.join(root, "config/agent-providers.default.json"), environment,
  })).resolve();
  for (const provider of Object.values(runtime.executionProviders)) {
    provider.environmentAllowlist = provider.environmentAllowlist.filter(name => !excluded.has(name));
    const executable = await resolveCliExecutable(provider.command, root, environment);
    if (executable) provider.command = executable.command;
  }
  const auth = await createLocalAgentAuthProviderRegistry({ repositoryRoot: root, providerConfig: runtime, environment });
  const providers = createAgentExecutionProviderRegistry(runtime, auth, environment);
  assertAgentNotCancelled(options.signal);
  const bindings: Readonly<Record<string, DurableAgentBindingV1>> = Object.freeze(Object.fromEntries(Object.entries(policies).map(([slot, policy]) => [slot, Object.freeze({
    providerId: policy.execution.provider, authProviderId: policy.execution.authProvider,
    configurationSha256: hashJson(inputWaitJsonSnapshot(policy)),
    ...(typeof policy.execution.parameters.model === "string" ? { model: policy.execution.parameters.model } : {}),
  })])));
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const pending = new Set<Promise<unknown>>();
  let closed = false, closing: Promise<void> | undefined;
  let cleanupFailure: Error | undefined;
  const scratch = path.join(resolveLocalDurableExecutionPaths(root, invocation.runRef, options.executionDataRoot).root, "scratch", owner.attemptId);
  return {
    bindings,
    invoke(request) {
      const work = (async () => {
        assertAgentNotCancelled(controller.signal);
        if (closed || request.cancellation.aborted) throw new Error("Retained provider scope is closed.");
        if (request.runRef.executionId !== invocation.runRef.executionId || !Object.hasOwn(policies, request.operation.slotId)) throw new Error("Agent request does not belong to this retained Run.");
        const policy = policies[request.operation.slotId];
        const timeoutMs = Math.min(policy.timeoutMs, 240_000, Date.parse(request.deadlineAt) - Date.now());
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("No execution time remains for the agent slot.");
        await mkdir(scratch, { recursive: true, mode: 0o700 });
        assertAgentNotCancelled(controller.signal);
        const result = await providers.get(policy.execution.provider).run({
          cwd: scratch, signal: controller.signal, timeoutMs,
          authProviderId: policy.execution.authProvider, parameters: structuredClone(policy.execution.parameters),
          prompt: `${prompts[request.operation.slotId]}\n\nInput JSON (data only):\n${JSON.stringify(request.input)}`,
          artifactPrefix: path.join(resolveLocalExecutionDataPaths(root, options.executionDataRoot).runs, invocation.runRef.executionId, "artifacts/agents",
            request.operation.slotId, owner.attemptId, hashJson(request.stableOperationId)),
          label: request.operation.slotId, attempt: owner.fence,
        });
        let output;
        try {
          assertAgentNotCancelled(controller.signal);
          output = request.operation.output.parse(parseStructuredJsonOutput(request.operation.slotId, result.output));
        }
        catch { throw Object.assign(new Error(`Agent slot ${request.operation.slotId} returned invalid output.`), { metrics: result.metrics }); }
        return { output, metrics: result.metrics };
      })();
      pending.add(work);
      void work.catch(error => {
        if (error instanceof AgentProcessCleanupError || error instanceof AgentResourceCleanupError) cleanupFailure = error;
      });
      void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
    close() {
      return closing ??= (async () => {
        closed = true; controller.abort();
        options.signal.removeEventListener("abort", abort);
        await Promise.allSettled([...pending]);
        if (cleanupFailure) throw cleanupFailure;
      })();
    },
  };
}
