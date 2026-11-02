import type { AgentExecutionMetrics } from "./agentProvider.ts";
import { getExternalErrorDiagnostic, getFailureRetryability, publicErrorMessage,
  type ExternalErrorDiagnostic, type FailureRetryabilityV1 } from "./externalError.ts";
import {
  DurableExecutionTerminalError,
  DurableOutcomeUnknownError,
  type AgentOperationBindingV1,
  type AgentOperationRefV1,
  type AgentOperationV1,
  type ClaimTokenV1,
  type DurableExecutionStorageV2,
  type EffectDefinitionBindingV1,
  type EffectOperationRefV1,
  type EffectOperationV1,
  type ExecutionHostContextV1,
  type StepCheckpointV1,
  sameAgentBinding,
  sameEffectBinding,
  sameStepBinding,
} from "./durableExecution.ts";
import {
  assertDurableIdentifier,
  hashJson,
  immutableJson,
  normalizedStepPerformance,
  stepDefinitionHash,
  type AgentSlotOperationV1,
  type ArtifactRefV1,
  type CompletedStepV1,
  type DeepReadonly,
  type DurableAgentOperationExecutorV1,
  type EffectAdapterV1,
  type EffectContractV1,
  type EffectExecutionContextV1,
  type EffectReconciliationV1,
  type JsonValue,
  type StepDefinitionBindingV1,
  type StepDefinitionV1,
  type StepRefV1,
  type StepDetailsRefV1,
  type StepExecutionContextV1,
  type StepPerformanceV1,
  type WorkflowExecutionContextV1,
} from "./durableWorkflow.ts";

/** Internal host adapter used when an execution environment must replace an
 * effect implementation. Ordinary engines omit it and call the declaration. */
export interface DurableEffectOperationExecutorV1 {
  execute<Input extends JsonValue, Output extends JsonValue>(request: {
    readonly stableOperationId: string;
    readonly definition: EffectContractV1<Input, Output>;
    readonly context: EffectExecutionContextV1;
    readonly input: DeepReadonly<Input>;
  }): Promise<Output>;
  reconcile<Input extends JsonValue, Output extends JsonValue>(request: {
    readonly stableOperationId: string;
    readonly definition: Extract<EffectContractV1<Input, Output>, { readonly safety: "reconcilable-write" }>;
    readonly context: EffectExecutionContextV1;
    readonly input: DeepReadonly<Input>;
  }): Promise<EffectReconciliationV1<Output>>;
}

export interface DurableWorkflowEngineV2Options {
  readonly storage: DurableExecutionStorageV2;
  readonly agents: DurableAgentOperationExecutorV1;
  readonly effects?: DurableEffectOperationExecutorV1;
  readonly adapterConformance?: (effectOperationId: string) => boolean;
  readonly now?: () => Date;
}

export interface DurableWorkflowExecutionV1<Output extends JsonValue> {
  readonly workflowContractVersion: string;
  readonly host: ExecutionHostContextV1;
  execute(context: WorkflowExecutionContextV1): Promise<Output>;
}

/** Internal scheduling entrypoint for a declared step occurrence. The caller
 * owns the stable occurrence ID; the durable engine still owns validation,
 * checkpointing, effects and provider operations. */
export interface DurableStepInstanceExecutionV1<Input extends JsonValue, Output extends JsonValue> {
  readonly workflowContractVersion: string;
  readonly host: ExecutionHostContextV1;
  readonly stepInstanceId: string;
  readonly step: StepDefinitionV1<Input, Output>;
  readonly input: DeepReadonly<Input>;
}

export interface DurableStepRetryExecutionV1<Input extends JsonValue, Output extends JsonValue>
  extends DurableStepInstanceExecutionV1<Input, Output> {
  readonly policyId: string;
  readonly expectedAttempt: number;
}

export class DurableWorkflowEngineV2 {
  readonly #storage: DurableExecutionStorageV2;
  readonly #agents: DurableAgentOperationExecutorV1;
  readonly #effects: DurableEffectOperationExecutorV1 | undefined;
  readonly #adapterConformance: (effectOperationId: string) => boolean;
  readonly #now: () => Date;

  constructor(options: DurableWorkflowEngineV2Options) {
    this.#storage = options.storage;
    this.#agents = options.agents;
    this.#effects = options.effects;
    this.#adapterConformance = options.adapterConformance ?? (() => false);
    this.#now = options.now ?? (() => new Date());
  }

  async execute<Output extends JsonValue>(execution: DurableWorkflowExecutionV1<Output>): Promise<DeepReadonly<Output>> {
    assertDurableIdentifier(execution.workflowContractVersion, "Workflow contract version");
    const usedStepIds = new Set<string>();
    const context: WorkflowExecutionContextV1 = {
      runRef: execution.host.runRef,
      get deadlineAt() { return execution.host.diagnosticClock?.deadlineAt() ?? execution.host.deadlineAt; },
      finalizationReserveMs: execution.host.finalizationReserveMs,
      cancellation: execution.host.cancellation,
      steps: {
        run: async (step, input) => {
          if (usedStepIds.has(step.id)) throw new Error(`Step ${step.id} was invoked more than once.`);
          usedStepIds.add(step.id);
          return this.#runStep(execution, step, input);
        },
      },
    };
    execution.host.diagnosticExclude?.(context);
    const output = await execution.execute(context);
    return immutableJson(output, "Workflow output");
  }

  async executeStepInstance<Input extends JsonValue, Output extends JsonValue>(
    execution: DurableStepInstanceExecutionV1<Input, Output>,
  ): Promise<CompletedStepV1<Input, Output>> {
    assertDurableIdentifier(execution.workflowContractVersion, "Workflow contract version");
    assertDurableIdentifier(execution.stepInstanceId, "Step instance ID");
    return this.#runStep(execution, execution.step, execution.input, execution.stepInstanceId);
  }

  async readStepInstance<Input extends JsonValue, Output extends JsonValue>(
    runRef: StepRefV1["runRef"], stepInstanceId: string,
  ): Promise<StepCheckpointV1<Input, Output> | undefined> {
    assertDurableIdentifier(stepInstanceId, "Step instance ID");
    return this.#storage.steps.read({ runRef, stepId: stepInstanceId });
  }

  async retryStepInstance<Input extends JsonValue, Output extends JsonValue>(
    execution: DurableStepRetryExecutionV1<Input, Output>,
  ): Promise<CompletedStepV1<Input, Output>> {
    assertDurableIdentifier(execution.workflowContractVersion, "Workflow contract version");
    assertDurableIdentifier(execution.stepInstanceId, "Step instance ID");
    assertDurableIdentifier(execution.policyId, "Retry policy ID");
    if (!Number.isSafeInteger(execution.expectedAttempt) || execution.expectedAttempt <= 0) {
      throw new Error("Retry expected attempt must be positive.");
    }
    this.#assertCanStart(execution.host);
    const input = await this.#activity(execution.host,
      () => immutableJson(execution.step.input.parse(execution.input), `Step ${execution.step.id} input`));
    const ref: StepRefV1 = { runRef: execution.host.runRef, stepId: execution.stepInstanceId };
    const binding: StepDefinitionBindingV1 = {
      workflowContractVersion: execution.workflowContractVersion,
      stepDefinitionVersion: execution.step.definitionVersion,
      stepDefinitionSha256: stepDefinitionHash(execution.step as StepDefinitionV1<JsonValue, JsonValue>),
      inputSha256: hashJson(input as Input),
    };
    const current = await this.#storage.steps.read<Input, Output>(ref);
    if (!current || !sameStepBinding(current.binding, binding)) {
      throw new DurableExecutionTerminalError("incompatible", `Stored step ${execution.step.id} cannot be retried with another definition or input.`);
    }
    if (current.attemptCount !== execution.expectedAttempt) {
      throw new DurableExecutionTerminalError("retry_conflict", `Stored step ${execution.step.id} retry attempt changed.`);
    }
    const retryId = `retry-${hashJson({ schemaVersion: 1, policyId: execution.policyId,
      stepInstanceId: execution.stepInstanceId, nextAttempt: execution.expectedAttempt + 1 })}`;
    const retryRequest = { retryId, policyId: execution.policyId, attemptId: execution.host.attemptId,
      fence: execution.host.fence, at: this.#timestamp() };
    const agentsToRetry: AgentOperationV1[] = [];
    for (const operationId of current.agentOperationIds) {
      const operation = await this.#storage.agents.read({ runRef: ref.runRef, operationId });
      if (!operation || operation.state === "COMPLETED") continue;
      const alreadyAdmitted = operation.retryAdmissions?.some(admission => admission.retryId === retryId);
      if (!alreadyAdmitted && (operation.state !== "FAILED" || operation.terminal?.retryability !== "retryable")) {
        throw terminalOperation(operation.terminal, operationId);
      }
      agentsToRetry.push(operation);
    }
    const effectsToRetry: EffectOperationV1[] = [];
    for (const operationId of current.effectOperationIds) {
      const operation = await this.#storage.effects.read({ runRef: ref.runRef, operationId });
      if (!operation || operation.state === "COMPLETED") continue;
      const alreadyAdmitted = operation.retryAdmissions?.some(admission => admission.retryId === retryId);
      if (!alreadyAdmitted && (operation.state !== "FAILED" || operation.terminal?.retryability !== "retryable")) {
        throw terminalOperation(operation.terminal, operationId);
      }
      if (operation.safety !== "read") {
        throw new DurableExecutionTerminalError("retry_not_safe", `Effect operation ${operationId} cannot reopen automatically.`);
      }
      effectsToRetry.push(operation);
    }
    // Preflight every child before changing one. A crash between writes remains
    // recoverable through the stable retry ID, but policy rejection changes none.
    for (const operation of agentsToRetry) {
      await this.#storage.agents.reopenForRetry({ ...retryRequest, ref: operation.ref,
        expectedRevision: operation.revision, expectedAttemptCount: operation.attemptCount });
    }
    for (const operation of effectsToRetry) {
      await this.#storage.effects.reopenForRetry({ ...retryRequest, ref: operation.ref,
        expectedRevision: operation.revision, expectedAttemptCount: operation.attemptCount });
    }
    await this.#storage.steps.reopenForRetry({ ...retryRequest, ref,
      expectedRevision: current.revision, expectedAttemptCount: current.attemptCount });
    return this.#runStep(execution, execution.step, input, execution.stepInstanceId);
  }

  async #runStep<Input extends JsonValue, Output extends JsonValue>(
    execution: Pick<DurableWorkflowExecutionV1<JsonValue>, "workflowContractVersion" | "host">,
    step: StepDefinitionV1<Input, Output>,
    input: DeepReadonly<Input>,
    stepInstanceId = step.id,
  ): Promise<CompletedStepV1<Input, Output>> {
    this.#assertCanStart(execution.host);
    const validatedInput = await this.#activity(execution.host, () => immutableJson(step.input.parse(input), `Step ${step.id} input`));
    const ref: StepRefV1 = { runRef: execution.host.runRef, stepId: stepInstanceId };
    const binding: StepDefinitionBindingV1 = {
      workflowContractVersion: execution.workflowContractVersion,
      stepDefinitionVersion: step.definitionVersion,
      stepDefinitionSha256: stepDefinitionHash(step as StepDefinitionV1<JsonValue, JsonValue>),
      inputSha256: hashJson(validatedInput as Input),
    };
    const current = await this.#storage.steps.read<Input, Output>(ref);
    if (current) {
      if (!sameStepBinding(current.binding, binding)) throw new DurableExecutionTerminalError("incompatible", `Stored step ${step.id} has another definition or input.`);
      if (current.state === "COMPLETED") return current.completed!;
      if (current.state === "FAILED" || current.state === "CANCELLED") throw terminalStep(current);
      if (current.state === "OUTCOME_UNKNOWN") throw new DurableOutcomeUnknownError(current.terminal?.message ?? `Step ${step.id} outcome is unknown.`, { cause: current.terminal });
      if (current.state === "RUNNING") {
        try {
          await this.#assertStepRecoverable(current);
        } catch (error) {
          await this.#terminateInterruptedStep(current, error);
          throw error;
        }
      }
    }
    const claim = await this.#storage.steps.claim<Input, Output>({
      ref,
      binding,
      attemptId: execution.host.attemptId,
      fence: execution.host.fence,
      expectedRevision: current?.revision ?? 0,
      claimedAt: this.#timestamp(),
    });
    if (claim.kind === "completed") return claim.completed;
    if (claim.kind === "incompatible") throw new DurableExecutionTerminalError("incompatible", `Stored step ${step.id} is incompatible: ${claim.reasonCode}.`);
    if (claim.kind === "terminal") throw terminalStep(claim.checkpoint);
    if (claim.kind === "busy") throw new DurableExecutionTerminalError("step_busy", `Step ${step.id} already has a live owner.`);
    await this.#emit(ref, "step-claimed");
    const startedAt = this.#timestamp();
    const metrics: AgentExecutionMetrics[] = [];
    const artifacts: ArtifactRefV1[] = [];
    const details: StepDetailsRefV1[] = [];
    try {
      const stepContext: StepExecutionContextV1 = {
        runRef: execution.host.runRef,
        get deadlineAt() { return execution.host.diagnosticClock?.deadlineAt() ?? execution.host.deadlineAt; },
        finalizationReserveMs: execution.host.finalizationReserveMs,
        cancellation: execution.host.cancellation,
        agents: { invoke: (operation, operationInput) => this.#runAgent(execution.host, ref, claim.claimToken, operation, operationInput, metrics, artifacts, details) },
        effects: { run: (effect, effectInput) => this.#runEffect(execution.host, ref, claim.claimToken, effect, effectInput) },
      };
      execution.host.diagnosticExclude?.(stepContext);
      const returned = await step.execute(stepContext, validatedInput);
      const output = await this.#activity(execution.host, () => immutableJson(step.output.parse(returned), `Step ${step.id} output`));
      const completedAt = this.#timestamp();
      const completed: CompletedStepV1<Input, Output> = {
        schemaVersion: 1,
        ref,
        binding,
        input: validatedInput,
        output,
        execution: {
          status: "completed",
          attemptCount: claim.checkpoint.attemptCount,
          startedAt,
          completedAt,
          elapsedMs: Date.parse(completedAt) - Date.parse(startedAt),
        },
        performance: normalizedStepPerformance(metrics),
        artifacts: uniqueArtifacts(artifacts),
        ...(details[0] ? { detailsRef: details[0] } : {}),
      };
      await this.#storage.steps.complete({ ref, claimToken: claim.claimToken, completed, at: completedAt });
      await this.#emit(ref, "step-completed");
      return completed;
    } catch (error) {
      await this.#terminateStep(ref, claim.claimToken, execution.host, error);
      throw error;
    }
  }

  async #runAgent<Input extends JsonValue, Output extends JsonValue>(
    host: ExecutionHostContextV1,
    stepRef: StepRefV1,
    stepClaim: ClaimTokenV1,
    operation: AgentSlotOperationV1<Output>,
    input: DeepReadonly<Input>,
    metrics: AgentExecutionMetrics[],
    artifacts: ArtifactRefV1[],
    details: StepDetailsRefV1[],
  ): Promise<DeepReadonly<Output>> {
    this.#assertCanStart(host);
    assertOperation(operation.schemaVersion, operation.operationId);
    const stableOperationId = `${stepRef.stepId}:${operation.operationId}`;
    const ref: AgentOperationRefV1 = { runRef: host.runRef, operationId: stableOperationId };
    await this.#storage.steps.registerOperation({ ref: stepRef, claimToken: stepClaim, kind: "agent", operationId: stableOperationId, at: this.#timestamp() });
    const resolved = this.#agents.resolve(operation);
    const validatedInput = immutableJson(input as Input, `Agent operation ${operation.operationId} input`);
    const binding: AgentOperationBindingV1 = {
      sourceOperationId: operation.operationId,
      slotId: operation.slotId,
      providerId: resolved.providerId,
      authProviderId: resolved.authProviderId,
      ...(resolved.model ? { model: resolved.model } : {}),
      configurationSha256: resolved.configurationSha256,
      inputSha256: hashJson(validatedInput as Input),
    };
    const stored = await this.#storage.agents.read<Output>(ref);
    if (stored) {
      if (!sameAgentBinding(stored.binding, binding)) throw new DurableExecutionTerminalError("incompatible", `Agent operation ${stableOperationId} binding changed.`);
      if (stored.state === "COMPLETED") {
        if (stored.performance) metrics.push(...performanceAsMetrics(stored.performance, binding.providerId));
        artifacts.push(...(stored.artifacts ?? []));
        if (stored.detailsRef) details.push(stored.detailsRef);
        return this.#activity(host, () => immutableJson(operation.output.parse(stored.output), `Agent operation ${stableOperationId} output`));
      }
      if (stored.state === "DISPATCHED") throw new DurableOutcomeUnknownError(`Agent operation ${stableOperationId} may already have been dispatched.`);
      if (["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(stored.state)) throw terminalOperation(stored.terminal, stableOperationId);
    }
    const claimed = await this.#storage.agents.claim<Output>({
      ref,
      binding,
      attemptId: host.attemptId,
      fence: host.fence,
      expectedRevision: stored?.revision ?? 0,
      claimedAt: this.#timestamp(),
    });
    const token = claimed.activeClaim!;
    await this.#storage.agents.markDispatched({ ref, claimToken: token, at: this.#timestamp() });
    try {
      const result = await this.#agents.invoke({ stableOperationId, runRef: host.runRef, stepId: stepRef.stepId, operation, input: validatedInput, deadlineAt: host.diagnosticClock?.deadlineAt() ?? host.deadlineAt, cancellation: host.cancellation });
      const output = await this.#activity(host, () => immutableJson(operation.output.parse(result.output), `Agent operation ${stableOperationId} output`));
      const performance = normalizedStepPerformance(result.metrics ? [result.metrics] : []);
      await this.#storage.agents.complete({ ref, claimToken: token, output, performance, artifacts: result.artifacts ?? [], ...(result.detailsRef ? { detailsRef: result.detailsRef } : {}), at: this.#timestamp() });
      if (result.metrics) metrics.push(result.metrics);
      artifacts.push(...(result.artifacts ?? []));
      if (result.detailsRef) details.push(result.detailsRef);
      return output;
    } catch (error) {
      const message = errorMessage(error);
      const fields = externalFields(error);
      if (fields.retryability === "unknown") {
        await this.#storage.agents.markOutcomeUnknown({ ref, claimToken: token, code: "agent_dispatch_outcome_unknown", message, ...fields, at: this.#timestamp() });
        throw new DurableOutcomeUnknownError(message, { cause: error });
      }
      await this.#storage.agents.fail({ ref, claimToken: token, code: failureCode(error, "agent_failed"), message,
        ...fields, at: this.#timestamp() });
      throw error;
    }
  }

  async #runEffect<Input extends JsonValue, Output extends JsonValue>(
    host: ExecutionHostContextV1,
    stepRef: StepRefV1,
    stepClaim: ClaimTokenV1,
    effect: EffectContractV1<Input, Output>,
    input: DeepReadonly<Input>,
  ): Promise<DeepReadonly<Output>> {
    this.#assertCanStart(host);
    assertOperation(effect.schemaVersion, effect.operationId);
    const stableOperationId = `${stepRef.stepId}:${effect.operationId}`;
    const ref: EffectOperationRefV1 = { runRef: host.runRef, operationId: stableOperationId };
    await this.#storage.steps.registerOperation({ ref: stepRef, claimToken: stepClaim, kind: "effect", operationId: stableOperationId, at: this.#timestamp() });
    const validatedInput = await this.#activity(host, () => immutableJson(effect.input.parse(input), `Effect ${effect.operationId} input`));
    const binding: EffectDefinitionBindingV1 = {
      definitionVersion: effect.definitionVersion,
      definitionSha256: hashJson({ schemaVersion: effect.schemaVersion, operationId: effect.operationId, definitionVersion: effect.definitionVersion, safety: effect.safety }),
      inputSha256: hashJson(validatedInput as Input),
      safety: effect.safety,
    };
    const stored = await this.#storage.effects.read<Output>(ref);
    if (stored) {
      if (!sameEffectBinding(stored, binding)) throw new DurableExecutionTerminalError("incompatible", `Effect ${stableOperationId} binding changed.`);
      if (stored.state === "COMPLETED") return this.#activity(host, () => immutableJson(effect.output.parse(stored.output), `Effect ${stableOperationId} output`));
      if (["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(stored.state)) throw terminalOperation(stored.terminal, stableOperationId);
      if (stored.state === "DISPATCHED" && effect.safety === "unsafe-write") throw new DurableOutcomeUnknownError(`Unsafe effect ${stableOperationId} may already have been dispatched.`);
      if (stored.state === "DISPATCHED" && effect.safety === "idempotent-write" && !stored.adapterConformanceRecorded) throw new DurableOutcomeUnknownError(`Effect ${stableOperationId} lacks idempotency conformance.`);
    }
    const claimed = await this.#storage.effects.claim<Output>({
      ref,
      ...binding,
      adapterConformanceRecorded: this.#adapterConformance(effect.operationId),
      attemptId: host.attemptId,
      fence: host.fence,
      expectedRevision: stored?.revision ?? 0,
      claimedAt: this.#timestamp(),
    });
    const token = claimed.activeClaim!;
    const context = { stableOperationId, deadlineAt: host.diagnosticClock?.deadlineAt() ?? host.deadlineAt, cancellation: host.cancellation };
    host.diagnosticExclude?.(context);
    if (stored?.state === "DISPATCHED" && effect.safety === "reconcilable-write") {
      const reconciled = await this.#activity(host, () => this.#effects
        ? this.#effects.reconcile({ stableOperationId, definition: effect, context, input: validatedInput })
        : "reconcile" in effect && typeof effect.reconcile === "function"
          ? effect.reconcile(context, validatedInput)
          : Promise.reject(new Error(`Effect ${effect.operationId} has no host adapter.`)));
      if (reconciled.outcome === "completed") {
        const output = await this.#activity(host, () => immutableJson(effect.output.parse(reconciled.output), `Effect ${stableOperationId} output`));
        await this.#storage.effects.complete({ ref, claimToken: token, output, at: this.#timestamp() });
        await this.#emitOperation(host, stableOperationId, "effect-completed");
        return output;
      }
      if (reconciled.outcome === "unknown") {
        await this.#storage.effects.markOutcomeUnknown({ ref, claimToken: token, code: reconciled.reasonCode, message: `Effect ${stableOperationId} reconciliation was inconclusive.`, at: this.#timestamp() });
        throw new DurableOutcomeUnknownError(`Effect ${stableOperationId} reconciliation was inconclusive.`);
      }
    }
    await this.#storage.effects.markDispatched({ ref, claimToken: token, at: this.#timestamp() });
    await this.#emitOperation(host, stableOperationId, "effect-dispatched");
    try {
      const output = await this.#activity(host, async () => {
        const executed = this.#effects
          ? await this.#effects.execute({ stableOperationId, definition: effect, context, input: validatedInput })
          : "execute" in effect && typeof (effect as EffectAdapterV1<Input, Output>).execute === "function"
            ? await (effect as EffectAdapterV1<Input, Output>).execute(context, validatedInput)
            : await Promise.reject(new Error(`Effect ${effect.operationId} has no host adapter.`));
        return immutableJson(effect.output.parse(executed), `Effect ${stableOperationId} output`);
      });
      await this.#storage.effects.complete({ ref, claimToken: token, output, at: this.#timestamp() });
      await this.#emitOperation(host, stableOperationId, "effect-completed");
      return output;
    } catch (error) {
      const message = errorMessage(error);
      if (effect.safety === "read") {
        await this.#storage.effects.fail({ ref, claimToken: token, code: "effect_failed", message, ...externalFields(error), at: this.#timestamp() });
        await this.#emitOperation(host, stableOperationId, "effect-failed", "effect_failed");
        throw error;
      }
      const fields = externalFields(error);
      await this.#storage.effects.markOutcomeUnknown({ ref, claimToken: token, code: "effect_dispatch_outcome_unknown", message,
        ...fields, ...(effect.safety === "unsafe-write" ? { retryability: "not-retryable" as const } : {}), at: this.#timestamp() });
      await this.#emitOperation(host, stableOperationId, "effect-outcome-unknown", "effect_dispatch_outcome_unknown");
      throw new DurableOutcomeUnknownError(message, { cause: error,
        ...(effect.safety === "unsafe-write" ? { retryability: "not-retryable" as const } : {}) });
    }
  }

  async #assertStepRecoverable(step: StepCheckpointV1): Promise<void> {
    for (const operationId of step.agentOperationIds) {
      const operation = await this.#storage.agents.read({ runRef: step.ref.runRef, operationId });
      if (operation?.state === "DISPATCHED" || operation?.state === "OUTCOME_UNKNOWN") {
        const message = `Agent operation ${operationId} cannot be safely replayed.`;
        if (operation.state === "DISPATCHED") {
          if (!operation.activeClaim) throw new DurableExecutionTerminalError("invalid_checkpoint", `Dispatched agent operation ${operationId} has no active claim.`);
          await this.#storage.agents.markOutcomeUnknown({ ref: operation.ref, claimToken: operation.activeClaim,
            code: "agent_dispatch_outcome_unknown", message, at: this.#timestamp() });
        }
        throw new DurableOutcomeUnknownError(message, { cause: operation.terminal });
      }
      if (operation && ["FAILED", "CANCELLED"].includes(operation.state)) throw terminalOperation(operation.terminal, operationId);
    }
    for (const operationId of step.effectOperationIds) {
      const operation = await this.#storage.effects.read({ runRef: step.ref.runRef, operationId });
      if (!operation || operation.state === "PENDING" || operation.state === "COMPLETED") continue;
      if (operation.state === "OUTCOME_UNKNOWN" || (operation.state === "DISPATCHED" && (operation.safety === "unsafe-write" || (operation.safety === "idempotent-write" && !operation.adapterConformanceRecorded)))) {
        const message = `Effect operation ${operationId} cannot be safely replayed.`;
        if (operation.state === "DISPATCHED") {
          if (!operation.activeClaim) throw new DurableExecutionTerminalError("invalid_checkpoint", `Dispatched effect operation ${operationId} has no active claim.`);
          await this.#storage.effects.markOutcomeUnknown({ ref: operation.ref, claimToken: operation.activeClaim,
            code: "effect_dispatch_outcome_unknown", message, at: this.#timestamp() });
        }
        throw new DurableOutcomeUnknownError(message, { cause: operation.terminal });
      }
      if (["FAILED", "CANCELLED"].includes(operation.state)) throw terminalOperation(operation.terminal, operationId);
    }
  }

  async #terminateInterruptedStep(step: StepCheckpointV1, error: unknown): Promise<void> {
    if (!step.activeClaim) throw new DurableExecutionTerminalError("invalid_checkpoint", `Running step ${step.ref.stepId} has no active claim.`);
    const at = this.#timestamp();
    if (error instanceof DurableOutcomeUnknownError) {
      await this.#storage.steps.markOutcomeUnknown({ ref: step.ref, claimToken: step.activeClaim, code: error.code, message: errorMessage(error), ...externalFields(error), at });
      await this.#emit(step.ref, "step-outcome-unknown", error.code);
      return;
    }
    const code = error instanceof DurableExecutionTerminalError ? error.code : "step_failed";
    if (code === "cancelled" || code === "deadline_exceeded" || code === "host_terminated") {
      await this.#storage.steps.cancel({ ref: step.ref, claimToken: step.activeClaim, code, at });
      await this.#emit(step.ref, "step-cancelled", code);
      return;
    }
    await this.#storage.steps.fail({ ref: step.ref, claimToken: step.activeClaim, code, message: errorMessage(error), ...externalFields(error), at });
    await this.#emit(step.ref, "step-failed", code);
  }

  #assertCanStart(host: ExecutionHostContextV1): void {
    if (host.cancellation.aborted) throw new DurableExecutionTerminalError(host.cancellation.reason ?? "cancelled", "Workflow attempt is cancelled.");
    const remaining = host.diagnosticClock?.remainingMs?.();
    if (remaining !== undefined && (!Number.isFinite(remaining) || remaining < 0)) throw new DurableExecutionTerminalError("host_terminated", "Diagnostic clock accounting is uncertain.");
    if (remaining !== undefined ? remaining <= host.finalizationReserveMs : this.#now().getTime() >= Date.parse(host.diagnosticClock?.deadlineAt() ?? host.deadlineAt) - host.finalizationReserveMs) throw new DurableExecutionTerminalError("deadline_exceeded", "Workflow attempt has no execution time remaining.");
  }

  async #activity<T>(host: ExecutionHostContextV1, work: () => T | Promise<T>): Promise<T> {
    return host.diagnosticActivity ? host.diagnosticActivity(work) : work();
  }

  async #terminateStep(ref: StepRefV1, token: ClaimTokenV1, host: ExecutionHostContextV1, error: unknown): Promise<void> {
    const at = this.#timestamp();
    if (error instanceof DurableOutcomeUnknownError) {
      await this.#storage.steps.markOutcomeUnknown({ ref, claimToken: token, code: error.code, message: errorMessage(error), ...externalFields(error), at });
      await this.#emit(ref, "step-outcome-unknown", error.code);
    } else if (host.cancellation.aborted || (error instanceof DurableExecutionTerminalError && error.code === "deadline_exceeded")) {
      const code = host.cancellation.reason ?? "deadline_exceeded";
      await this.#storage.steps.cancel({ ref, claimToken: token, code, at });
      await this.#emit(ref, "step-cancelled", code);
    } else {
      const code = failureCode(error, "step_failed");
      await this.#storage.steps.fail({ ref, claimToken: token, code, message: errorMessage(error), ...externalFields(error), at });
      await this.#emit(ref, "step-failed", code);
    }
  }

  async #emit(ref: StepRefV1, type: Omit<import("./durableExecution.ts").ExecutionEventV1, "schemaVersion" | "sequence" | "runRef" | "at">["type"], code?: string): Promise<void> {
    await this.#storage.events.emit({ schemaVersion: 1, runRef: ref.runRef, at: this.#timestamp(), type, stepId: ref.stepId, ...(code ? { code } : {}) });
  }
  async #emitOperation(host: ExecutionHostContextV1, operationId: string, type: import("./durableExecution.ts").ExecutionEventV1["type"], code?: string): Promise<void> {
    await this.#storage.events.emit({ schemaVersion: 1, runRef: host.runRef, at: this.#timestamp(), type, operationId, ...(code ? { code } : {}) });
  }
  #timestamp(): string { return this.#now().toISOString(); }
}

function terminalStep(step: StepCheckpointV1): DurableExecutionTerminalError { return terminalOperation(step.terminal, step.ref.stepId); }
function terminalOperation(terminal: { readonly code: string; readonly message: string; readonly externalDiagnostic?: ExternalErrorDiagnostic } | undefined, id: string): DurableExecutionTerminalError {
  return terminal?.code === "outcome_unknown"
    ? new DurableOutcomeUnknownError(terminal.message, { cause: terminal })
    : new DurableExecutionTerminalError(terminal?.code ?? "terminal", terminal?.message ?? `${id} is terminal.`, { cause: terminal });
}
function assertOperation(schemaVersion: number, operationId: string): void {
  if (schemaVersion !== 1) throw new Error("Operation schemaVersion must be 1.");
  assertDurableIdentifier(operationId, "Operation ID");
}
function errorMessage(error: unknown): string { return publicErrorMessage(error, "The workflow operation failed. Inspect its runtime diagnostics before retrying."); }
function failureCode(error: unknown, fallback: string): string {
  if (error instanceof DurableExecutionTerminalError) return error.code;
  return getExternalErrorDiagnostic(error)?.code ?? fallback;
}
function externalFields(error: unknown): { externalDiagnostic?: ExternalErrorDiagnostic; retryability: FailureRetryabilityV1 } {
  const externalDiagnostic = getExternalErrorDiagnostic(error);
  return { ...(externalDiagnostic ? { externalDiagnostic } : {}), retryability: getFailureRetryability(error) };
}
function uniqueArtifacts(values: readonly ArtifactRefV1[]): ArtifactRefV1[] { return [...new Map(values.map((value) => [value.artifactId, value])).values()]; }
function performanceAsMetrics(performance: StepPerformanceV1, providerId: string): AgentExecutionMetrics[] {
  const reported = (metric: StepPerformanceV1[keyof StepPerformanceV1]) => metric.availability === "reported" ? metric.value : undefined;
  return [{
    providerId,
    status: "complete",
    elapsedMs: 0,
    nativeToolCalls: 0,
    toolCallUnit: "native-tool-call",
    artifacts: { eventsPath: "reference-only", stderrPath: "reference-only", lastMessagePath: "reference-only", heartbeatPath: "reference-only" },
    usage: {
      ...(reported(performance.inputTokens) === undefined ? {} : { inputTokens: reported(performance.inputTokens) }),
      ...(reported(performance.cachedInputTokens) === undefined ? {} : { cachedInputTokens: reported(performance.cachedInputTokens) }),
      ...(reported(performance.outputTokens) === undefined ? {} : { outputTokens: reported(performance.outputTokens) }),
      ...(reported(performance.reasoningTokens) === undefined ? {} : { reasoningOutputTokens: reported(performance.reasoningTokens) }),
    },
  }];
}
