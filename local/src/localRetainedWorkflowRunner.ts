import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import { LocalRetainedExecutionHostV2, type RetainedAttemptWorkerV2, type RetainedAttemptResultV2 } from "./localRetainedExecutionHost.ts";
import { resolveLocalDurableExecutionPaths } from "./localDurableWorkflowRuntime.ts";
import { validateWorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { ExternalProviderError, getExternalErrorDiagnostic, getFailureRetryability,
  readExternalErrorDiagnostic, readFailureRetryability } from "../../core/src/application/externalError.ts";
import { hashJson, immutableJson, type DurableAgentBindingV1, type DurableAgentOperationExecutorV1,
  type DeepReadonly, type EffectAdapterV1, type EffectExecutionContextV1, type JsonValue } from "../../core/src/application/durableWorkflow.ts";
import { constructionDescriptorFile, constructionDescriptorSchema, retainedAgentPromptsSchema } from "../../core/src/application/retainedWorkflowConstruction.ts";
import { sameOwner, terminalRun, type ExecutableBindingV1 } from "../../core/src/application/retainedExecution.ts";
import { type ActiveComputeLimitsV1, RetainedAttemptReadinessError } from "../../core/src/application/activeCompute.ts";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import type { RunRef } from "../../core/src/domain/runIdentity.ts";
import { prepareLocalRetainedAgentProviders } from "./localRetainedAgentProviders.ts";
import { recordRetainedAgentMetrics } from "./localRetainedPerformance.ts";
import type { AgentExecutionMetrics } from "../../core/src/application/agentProvider.ts";
import type { LocalDebugger } from "./localDebugger.ts";
import { retainedDebugCode } from "./retainedDebugCode.ts";
import { observeFrameworkError, type FrameworkErrorObserver } from "../../core/src/application/frameworkErrors.ts";
import { deserializeFrameworkError } from "./localFrameworkWorkerError.ts";
import { createHeadlessWorkerDebugger, type HeadlessWorkerDebugger, type LiveBreakpoint } from "./headlessWorkerDebugger.ts";
import { readHeadlessDebugActivity } from "./headlessDebugActivity.ts";
import type { RetainedAttemptContextV2 } from "./localRetainedExecutionHost.ts";
import { assertRetainedEffectAdapterMatches, assertRetainedEffectOutputSafe, prepareRetainedEffectAdapters, retainedEffectSecretValues,
  sanitizeRetainedEffectDiagnostic } from "./retainedEffectAdapters.ts";

export interface HeadlessRuntimeDebugger {
  configuration(ref: RunRef): { stopOnEntry: boolean; breakpoints: LiveBreakpoint[]; knownSecrets?: readonly string[] } | undefined;
  attached(ref: RunRef, controller: HeadlessWorkerDebugger, context: RetainedAttemptContextV2): Promise<void>;
  changed(ref: RunRef): void;
  stopped(ref: RunRef, attemptId: string): void;
}

export interface PreparedRetainedAgentsV1 {
  readonly bindings: Record<string, DurableAgentBindingV1>;
  readonly invoke: DurableAgentOperationExecutorV1["invoke"];
  /** Stop all provider processes and heartbeat work. Must settle before ownership release. */
  close(): Promise<void>;
  heartbeat?(): Promise<void>;
}
const invokeSchema = z.strictObject({ stableOperationId: z.string(), stepId: z.string(),
  operation: z.strictObject({ schemaVersion: z.literal(1), operationId: z.string(), slotId: z.string() }), input: z.unknown() });
const effectInvokeSchema = z.strictObject({ stableOperationId: z.string(), operationId: z.string(), definitionVersion: z.string(),
  safety: z.enum(["read", "idempotent-write", "reconcilable-write", "unsafe-write"]),
  phase: z.enum(["execute", "reconcile"]), input: z.unknown() });

/** Internal driver; admission/publication belong to the Run orchestrator.
 * No source/registry resolver is consulted after the Run's retained binding exists. */
export class LocalRetainedWorkflowRunnerV1 {
  constructor(readonly options: {
    onFrameworkError?: FrameworkErrorObserver;
    store: FileRetainedExecutionStoreV1; projectRoot: string; executionDataRoot?: string; workerPath?: string;
    debuggerSession?: LocalDebugger;
    liveDebugger?: HeadlessRuntimeDebugger;
    /** Resolve only; no process, heartbeat or model request may start here. */
    prepareAgents?(binding: DeepReadonly<ExecutableBindingV1>, signal: AbortSignal,
      prompts: Readonly<Record<string, string>>): Promise<PreparedRetainedAgentsV1>;
    /** Host-owned secrets for effect adapter factories. They never enter the workflow worker. */
    resolveEffectCredentials?(binding: DeepReadonly<ExecutableBindingV1>, signal: AbortSignal):
      Promise<Readonly<Record<string, string>>>;
  }) {}

  async execute(ref: RunRef, limits: ActiveComputeLimitsV1, hostRequirements: Record<string, string>, signal?: AbortSignal, onClaimed?: () => Promise<void>) {
    const { store } = this.options;
    const live = this.options.liveDebugger;
    const debug = live?.configuration(ref);
    const host = new LocalRetainedExecutionHostV2(store, { onFrameworkError: this.options.onFrameworkError });
    return host.execute({ runRef: ref, limits, hostRequirements, signal, ...(debug ? { diagnostic: true } : {}), prepare: async context => {
      const state = await store.read(context.runRef);
      if (!state || !sameOwner(state.owner, context.owner) || terminalRun(state)) throw new RetainedAttemptReadinessError("retained-code-incompatible");
      await onClaimed?.();
      const graphInput = state.graphInput;
      const invocation = graphInput?.invocation ?? validateWorkflowInvocationV1(state.binding.invocation);
      if (hashJson(inputWaitJsonSnapshot(invocation.runRef)) !== hashJson(inputWaitJsonSnapshot(context.runRef))) throw new RetainedAttemptReadinessError("retained-code-incompatible");
      const build = await store.readBuild(state.binding.buildSha256);
      const descriptor = build.files[constructionDescriptorFile];
      if (!descriptor) throw new RetainedAttemptReadinessError("retained-code-incompatible");
      const construction = constructionDescriptorSchema.parse(JSON.parse(Buffer.from(descriptor).toString("utf8")));
      const profile = z.object({ maxScratchBytes: z.number().int().positive().safe() }).parse(state.binding.executionProfile);
      const pinned = immutableJson(inputWaitJsonSnapshot(state.binding)) as DeepReadonly<ExecutableBindingV1>;
      const assets = Object.fromEntries(Object.entries(build.files).filter(([name]) => name.startsWith("assets/"))
        .map(([name, bytes]) => [name.slice("assets/".length), bytes]));
      const storageRoot = resolveLocalDurableExecutionPaths(this.options.projectRoot, context.runRef, this.options.executionDataRoot).root;
      const scratchDirectory = path.join(storageRoot, "scratch", context.owner.attemptId);
      const workerPath = this.options.workerPath ?? fileURLToPath(new URL("./retained-attempt-worker.js", import.meta.url));
      const retainedCode = Buffer.from(build.files[build.manifest.entryPoint]).toString("utf8");
      const effectCredentials = this.options.resolveEffectCredentials
        ? await this.options.resolveEffectCredentials(pinned, context.signal)
        : {};
      const effectSecretValues = retainedEffectSecretValues(pinned.nonSecretEnvironment, effectCredentials);
      const effectAdapterCode = construction.schemaVersion === 2
        ? build.files[construction.effectAdapterEntryPoint]
        : undefined;
      if (construction.schemaVersion === 2 && !effectAdapterCode) throw new Error("Retained effect adapter bundle is missing.");
      const effectAdapters = await prepareRetainedEffectAdapters({
        code: effectAdapterCode ? Buffer.from(effectAdapterCode).toString("utf8") : "", descriptor: construction,
        environment: pinned.nonSecretEnvironment, credentials: effectCredentials, runConfiguration: pinned.runConfiguration });
      const code = debug ? `${retainedCode}\n//# sourceURL=arkimux-retained://${state.binding.buildSha256}/entry.mjs\n` : this.options.debuggerSession
        ? await retainedDebugCode(retainedCode, state.binding.buildSha256, this.options.projectRoot) : retainedCode;
      return { start: (): RetainedAttemptWorkerV2 => {
        const child = fork(workerPath, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
          env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", TZ: "UTC", ...this.options.debuggerSession?.environment } });
        const calls = new Set<Promise<void>>(); let stopped = false;
        let workerDiagnostic: Error | undefined;
        let debuggerController: HeadlessWorkerDebugger | undefined, providerCalls = 0;
        const activityPath = path.join(scratchDirectory, "debug-activity.json");
        const activity = () => {
          const worker = readHeadlessDebugActivity(activityPath, context.owner);
          return { activeCount: worker.activeCount + providerCalls, activityKnown: worker.activityKnown };
        };
        const providerCancellation = new AbortController();
        let agents: PreparedRetainedAgentsV1 | undefined, preparationStarted = false, invocationSequence = 0;
        const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
        const abort = () => { providerCancellation.abort(); if (child.connected) child.send({ kind: "cancel" }, () => {}); };
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) abort();
        const completion = new Promise<RetainedAttemptResultV2>((resolve, reject) => {
          child.once("error", error => { void observeFrameworkError(this.options.onFrameworkError, error, "worker"); reject(new Error("Retained worker could not start.", { cause: error })); });
          child.once("exit", () => reject(new Error("Retained worker exited before reporting its outcome.")));
          child.on("message", message => {
            const value = message as Record<string, unknown>;
            if (value.kind === "result") resolve(value.result as RetainedAttemptResultV2);
            else if (value.kind === "framework-diagnostic") {
              const error = deserializeFrameworkError(value.frameworkDiagnostic);
              if (!live && error) {
                workerDiagnostic = error;
                const report = observeFrameworkError(this.options.onFrameworkError, error, "worker");
                calls.add(report); void report.finally(() => calls.delete(report));
              }
            }
            else if (value.kind === "error") {
              const diagnostic = readExternalErrorDiagnostic(value.externalDiagnostic);
              reject(diagnostic ? new ExternalProviderError(diagnostic.provider, diagnostic.message, {
                code: diagnostic.code, httpStatus: diagnostic.httpStatus,
                retryability: readFailureRetryability(value.retryability),
                cause: workerDiagnostic,
              }) : Object.assign(new Error("Retained workflow failed.", { cause: workerDiagnostic }), { code: "workflow-failed" }));
            }
            else if (value.kind === "call" && !stopped) {
              const dispatch = async () => {
                try {
                  const current = await store.read(context.runRef);
                  if (!current || terminalRun(current) || !sameOwner(current.owner, context.owner) || context.signal.aborted) throw new Error("Worker is no longer authorized.");
                  const args = value.args as unknown[];
                  let result: unknown;
                  if (value.method === "input.read") result = current;
                  else if (value.method === "input.open") result = await store.openRequest(context.runRef, context.owner, args[0] as Parameters<typeof store.openRequest>[2]);
                  else if (value.method === "input.complete") result = await store.completeInput(context.runRef, context.owner, args[0] as string);
                  else if (value.method === "agents.prepare") {
                    if (preparationStarted) throw new Error("Agents may be prepared only once per attempt.");
                    preparationStarted = true;
                    const prompts = Object.freeze(retainedAgentPromptsSchema.parse(args[0]));
                    agents = this.options.prepareAgents
                      ? await this.options.prepareAgents(pinned, providerCancellation.signal, prompts)
                      : await prepareLocalRetainedAgentProviders({ projectRoot: this.options.projectRoot, executionDataRoot: this.options.executionDataRoot,
                        binding: pinned, invocation, signal: providerCancellation.signal, prompts, owner: context.owner });
                    if (stopped || context.signal.aborted) throw new Error("Agent preparation cancelled.");
                    if (JSON.stringify(Object.keys(agents.bindings).sort()) !== JSON.stringify(Object.keys(prompts).sort())) throw new Error("Retained prompts must match the configured agent slots.");
                    result = inputWaitJsonSnapshot(agents.bindings);
                  }
                  else if (value.method === "heartbeat") result = await agents?.heartbeat?.();
                  else if (value.method === "agent.invoke") {
                    const request = invokeSchema.parse(args[0]);
                    if (!agents || !Object.hasOwn(agents.bindings, request.operation.slotId)) throw new Error("Unknown retained agent slot.");
                    const sequence = ++invocationSequence;
                    const saveMetrics = (metrics: AgentExecutionMetrics) => recordRetainedAgentMetrics(this.options.projectRoot, {
                      schemaVersion: 1, runRef: context.runRef, operationId: request.stableOperationId,
                      stageId: request.stepId, slotId: request.operation.slotId, fence: context.owner.fence, sequence, metrics,
                    }, this.options.executionDataRoot);
                    providerCalls++;
                    await context.diagnosticClock?.setActivity(activity());
                    try {
                      const response = await agents.invoke({ ...request, runRef: context.runRef,
                        operation: { ...request.operation, output: { parse: inputWaitJsonSnapshot } }, input: inputWaitJsonSnapshot(request.input),
                        deadlineAt: context.workDeadlineAt, cancellation: { get aborted() { return context.signal.aborted; }, get reason() { return context.signal.aborted ? "host_terminated" as const : undefined; } } });
                      if (response.metrics) await saveMetrics(response.metrics);
                      result = response;
                    } catch (error) {
                      if (error instanceof Error && "metrics" in error) await saveMetrics(error.metrics as AgentExecutionMetrics);
                      throw error;
                    } finally { providerCalls--; await context.diagnosticClock?.setActivity(activity()); }
                  }
                  else if (value.method === "effect.invoke") {
                    const request = effectInvokeSchema.parse(args[0]);
                    const adapter = effectAdapters[request.operationId];
                    if (!adapter) throw new Error(`No retained host adapter is configured for effect ${request.operationId}.`);
                    assertRetainedEffectAdapterMatches(adapter, request);
                    const effectContext: EffectExecutionContextV1 = { stableOperationId: request.stableOperationId,
                      deadlineAt: context.workDeadlineAt,
                      cancellation: { get aborted() { return providerCancellation.signal.aborted || context.signal.aborted; },
                        get reason() { return providerCancellation.signal.aborted || context.signal.aborted ? "host_terminated" as const : undefined; } } };
                    const input = immutableJson(adapter.input.parse(request.input), `Effect ${request.operationId} input`);
                    providerCalls++;
                    await context.diagnosticClock?.setActivity(activity());
                    try {
                      if (request.phase === "execute") {
                        const output = await adapter.execute(effectContext, input);
                        result = inputWaitJsonSnapshot(adapter.output.parse(output));
                        assertRetainedEffectOutputSafe(result, effectSecretValues);
                      } else {
                        if (adapter.safety !== "reconcilable-write" || typeof (adapter as EffectAdapterV1<JsonValue, JsonValue> & { reconcile?: unknown }).reconcile !== "function") {
                          throw new Error(`Effect ${request.operationId} does not support reconciliation.`);
                        }
                        const reconciled = await (adapter as Extract<EffectAdapterV1<JsonValue, JsonValue>, { safety: "reconcilable-write" }>).reconcile(effectContext, input);
                        if (reconciled.outcome === "completed") {
                          const output = inputWaitJsonSnapshot(adapter.output.parse(reconciled.output));
                          assertRetainedEffectOutputSafe(output, effectSecretValues);
                          result = { outcome: "completed", output };
                        } else result = inputWaitJsonSnapshot(reconciled);
                      }
                    } finally { providerCalls--; await context.diagnosticClock?.setActivity(activity()); }
                  }
                  else throw new Error("Unknown worker operation.");
                  if (child.connected) child.send({ kind: "reply", id: value.id, ok: true, value: result }, () => {});
                } catch (error) {
                  // Only host storage/control operations here are framework-owned.
                  // Agent/effect execution and preparation have separate semantics.
                  if (["input.read", "input.open", "input.complete"].includes(String(value.method)) && !context.signal.aborted)
                    await observeFrameworkError(this.options.onFrameworkError, error, "storage");
                  const externalDiagnostic = getExternalErrorDiagnostic(error);
                  if (child.connected) child.send({ kind: "reply", id: value.id, ok: false,
                    retryability: getFailureRetryability(error),
                    ...(externalDiagnostic ? { externalDiagnostic: sanitizeRetainedEffectDiagnostic(externalDiagnostic, effectSecretValues) } : {}) }, () => {});
                }
              };
              const pending = dispatch(); calls.add(pending); void pending.finally(() => calls.delete(pending));
            }
          });
          void mkdir(scratchDirectory, { recursive: true, mode: 0o700 }).then(async () => {
            if (stopped || context.signal.aborted) { reject(new Error("Attempt cancelled before dispatch.")); return; }
            if (debug) {
              const endpoint = await new Promise<string>((accept, fail) => {
                const timeout = setTimeout(() => finish(new Error("Debugger attachment timed out.")), 5000);
                const finish = (cause?: Error, endpoint?: string) => {
                  clearTimeout(timeout); child.removeListener("message", message); child.removeListener("exit", died);
                  context.signal.removeEventListener("abort", aborted);
                  cause ? fail(cause) : accept(endpoint!);
                };
                const died = () => finish(new Error("Debugger worker exited."));
                const aborted = () => finish(new Error("Debugger attachment cancelled."));
                const message = (value: unknown) => {
                  const event = value as { kind?: string; endpoint?: unknown };
                  if (event.kind === "debug-endpoint" && typeof event.endpoint === "string") finish(undefined, event.endpoint);
                };
                child.on("message", message); child.once("exit", died); context.signal.addEventListener("abort", aborted, { once: true });
                if (context.signal.aborted) aborted();
                else child.send({ kind: "debug-connect" }, cause => { if (cause) finish(new Error("Debugger connection failed.")); });
              });
              debuggerController = await createHeadlessWorkerDebugger({ endpoint, workerScriptUrl: pathToFileURL(workerPath).href, retainedCode, buildSha256: state.binding.buildSha256,
                attemptId: context.owner.attemptId, ...debug,
                onChange: () => live!.changed(ref),
                onDisconnect: () => {
                  if (stopped) return;
                  providerCancellation.abort(); child.kill("SIGKILL");
                  // V8 may resume on detach before the close event is observed.
                  // Do not certify that unobserved interval as a quiet pause.
                  const uncertain = store.blockUncertainAttempt(ref, context.owner);
                  calls.add(uncertain); void uncertain.finally(() => calls.delete(uncertain)).catch(() => {});
                },
                onPause: async pauseId => { await context.diagnosticClock!.observePause({ pauseId, ...activity() }); },
                onResume: async pauseId => { await context.diagnosticClock!.resume(pauseId); } });
              if (stopped || context.signal.aborted) { await debuggerController.close(); throw new Error("Debugger cancelled before dispatch."); }
              await live!.attached(ref, debuggerController, context);
            }
            if (stopped || context.signal.aborted) throw new Error("Attempt cancelled before dispatch.");
            child.send({ kind: "start", code, storageRoot, owner: context.owner, construction,
              ...(graphInput ? { executionKind: "graph", graphInput } : { executionKind: "workflow", invocation }),
              ...(debug ? { debug: { clockPath: context.diagnosticClock!.clockPath, activityPath } } : {}),
              runConfiguration: pinned.runConfiguration, assets,
              host: { schemaVersion: 1, runRef: context.runRef, attemptId: context.owner.attemptId, fence: context.owner.fence,
                deadlineAt: context.deadlineAt, finalizationReserveMs: limits.finalizationReserveMs, scratchDirectory,
                limits: { maxDurationMs: limits.attemptMs, maxScratchBytes: profile.maxScratchBytes } } }, error => { if (error) reject(new Error("Worker dispatch failed.")); });
          }).catch(reject);
        });
        let cleanup: Promise<void> | undefined;
        return { completion, stop: () => cleanup ??= (async () => {
          stopped = true; context.signal.removeEventListener("abort", abort);
          providerCancellation.abort();
          child.kill("SIGKILL"); await exited;
          await debuggerController?.close();
          if (debug) live!.stopped(ref, context.owner.attemptId);
          await Promise.allSettled([...calls]);
          await agents?.close();
          await rm(scratchDirectory, { recursive: true, force: true });
        })() };
      } };
    } });
  }
}
