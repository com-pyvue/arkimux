import type { PublishedResultRef, PublishedResultStore } from "./publishedResult.ts";
import { getExternalErrorDiagnostic, publicErrorMessage, type ExternalErrorDiagnostic } from "./externalError.ts";
import type { ReservableRunStateV5Store } from "./runState.ts";
import type {
  ExecutionAttemptV1,
  ExecutionHostV1,
} from "./durableExecution.ts";
import { immutableJson, type DeepReadonly, type JsonValue } from "./durableWorkflow.ts";
import type { DurableWorkflowEngineV2 } from "./durableWorkflowEngine.ts";
import {
  assertInvocationMatchesDefinition,
  validateWorkflowInvocationV1,
  type DurableWorkflowDefinitionV1,
  type WorkflowInvocationStoreV1,
  type WorkflowInvocationV1,
} from "./durableWorkflowInvocation.ts";

export interface DurableWorkflowRunExecutorV2Options {
  readonly engine: DurableWorkflowEngineV2;
  readonly host: ExecutionHostV1;
  readonly invocations: WorkflowInvocationStoreV1;
  readonly runState: Pick<ReservableRunStateV5Store, "update">;
  readonly results: PublishedResultStore;
  readonly now?: () => Date;
}

export interface DurableWorkflowRunRequestV2<Input extends JsonValue, Output extends JsonValue> {
  readonly attempt: ExecutionAttemptV1;
  readonly invocation: WorkflowInvocationV1<Input>;
  readonly definition: DurableWorkflowDefinitionV1<Input, Output>;
}

export type DurableWorkflowRunOutcomeV1 =
  | { readonly status: "complete"; readonly result: PublishedResultRef }
  | { readonly status: "failed" | "cancelled" | "outcome_unknown"; readonly code: string; readonly message: string; readonly externalDiagnostic?: ExternalErrorDiagnostic };

/** Persists the complete invocation before adapting execution to Run State V5 and Results V1. */
export class DurableWorkflowRunExecutorV2 {
  readonly #engine: DurableWorkflowEngineV2;
  readonly #host: ExecutionHostV1;
  readonly #invocations: WorkflowInvocationStoreV1;
  readonly #runState: Pick<ReservableRunStateV5Store, "update">;
  readonly #results: PublishedResultStore;
  readonly #now: () => Date;

  constructor(options: DurableWorkflowRunExecutorV2Options) {
    this.#engine = options.engine;
    this.#host = options.host;
    this.#invocations = options.invocations;
    this.#runState = options.runState;
    this.#results = options.results;
    this.#now = options.now ?? (() => new Date());
  }

  async execute<Input extends JsonValue, Output extends JsonValue>(request: DurableWorkflowRunRequestV2<Input, Output>): Promise<DurableWorkflowRunOutcomeV1> {
    const invocation = validateWorkflowInvocationV1<Input>(request.invocation);
    if (invocation.runRef.executionId !== request.attempt.runRef.executionId) {
      throw new Error("Workflow invocation Run reference must match the execution attempt.");
    }
    assertInvocationMatchesDefinition(invocation, request.definition);
    const input = immutableJson(request.definition.input.parse(invocation.input), "Workflow invocation input");
    await this.#invocations.create(invocation);
    await this.#runState.update({ kind: "status", status: "running", updatedAt: this.#timestamp() });
    const outcome = await this.#host.executeAttempt(request.attempt, (host) => this.#engine.execute({
      workflowContractVersion: invocation.workflowContractVersion,
      host,
      execute: async (context) => request.definition.output.parse(await request.definition.execute(context, input)),
    }));
    if (outcome.status === "completed") {
      const payload = structuredClone(outcome.output) as DeepReadonly<Output>;
      const result = await this.#results.publish({
        envelopeSchemaVersion: 1,
        resultKind: invocation.resultKind,
        runRef: request.attempt.runRef,
        payload,
      });
      await this.#runState.update({ kind: "status", status: "complete", updatedAt: this.#timestamp() });
      return { status: "complete", result };
    }
    const code = outcome.status === "cancelled" ? outcome.reason : outcome.code;
    const message = outcome.status === "cancelled" ? `Workflow attempt was ${outcome.reason}.` : publicErrorMessage(outcome, "The workflow attempt failed. Inspect its runtime diagnostics before retrying.");
    const externalDiagnostic = getExternalErrorDiagnostic(outcome);
    await this.#runState.update({ kind: "status", status: "failed", updatedAt: this.#timestamp(), message });
    return { status: outcome.status, code, message, ...(externalDiagnostic ? { externalDiagnostic } : {}) };
  }

  #timestamp(): string { return this.#now().toISOString(); }
}
