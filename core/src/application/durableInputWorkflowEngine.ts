import { DurableWorkflowEngineV2, type DurableWorkflowEngineV2Options } from "./durableWorkflowEngine.ts";
import { DurableExecutionTerminalError, sameStepBinding, type ExecutionHostContextV1 } from "./durableExecution.ts";
import { hashJson, immutableJson, type CompletedStepV1, type DeepReadonly, type JsonValue, type StepDefinitionBindingV1 } from "./durableWorkflow.ts";
import { defineInputForm, inputWaitJsonSnapshot, validateInputResponseShapeV1, type InputFormV1, type InputWaitDurationV1, type InputRequestV1, type InputResponseV1, type WorkflowExecutionContextV2, type WorkflowStepOperationsV2 } from "./inputWait.ts";
import { inputRequestTimingV1 } from "./activeCompute.ts";
import { sameOwner, terminalRun, type RetainedOwnerV1 } from "./retainedExecution.ts";
import type { DurableInputControlV1, DurableWorkflowEngineOutcomeV3 } from "./durableInputWait.ts";

export interface DurableInputWorkflowExecutionV1<Output extends JsonValue> {
  readonly workflowContractVersion: string;
  readonly host: ExecutionHostContextV1;
  readonly owner: RetainedOwnerV1;
  readonly runExpiresAt?: string;
  execute(context: WorkflowExecutionContextV2): Promise<Output>;
}

/** V3 composes V2 unchanged. Ordinary step/agent/effect replay stays in V2;
 * an input checkpoint is completed only from a durably accepted response. */
export class DurableWorkflowEngineV3 {
  readonly #options: DurableWorkflowEngineV2Options;
  readonly #input: DurableInputControlV1;
  readonly #base: DurableWorkflowEngineV2;
  constructor(options: DurableWorkflowEngineV2Options & { readonly input: DurableInputControlV1 }) {
    this.#options = options; this.#input = options.input; this.#base = new DurableWorkflowEngineV2(options);
  }
  async execute<Output extends JsonValue>(execution: DurableInputWorkflowExecutionV1<Output>): Promise<DurableWorkflowEngineOutcomeV3<Output>> {
    const ref = execution.host.runRef, owner = execution.owner;
    if (execution.host.attemptId !== owner.attemptId || execution.host.fence !== owner.fence) throw new Error("Input engine host and retained owner differ.");
    const initial = await this.#input.read(ref);
    if (!initial || terminalRun(initial) || !sameOwner(initial.owner, owner)) throw new Error("Input engine requires the live retained owner.");
    const used = new Set<string>(), pending = new Set<Promise<unknown>>();
    const suspension = new Error("Internal input suspension");
    let waiting = false, closed = false, request: InputRequestV1 | undefined, violation: Error | undefined;
    const invalid = (message: string): never => { violation = new DurableExecutionTerminalError("invalid_input_sequence", message); throw violation; };
    const guard = (id: string) => {
      if (violation) throw violation;
      if (closed) invalid("Workflow operations cannot start after execution has ended.");
      if (request) throw suspension;
      if (waiting) invalid("No operation may run concurrently with an input step.");
      if (used.has(id)) invalid(`Step ${id} was invoked more than once.`);
      if (execution.host.cancellation.aborted) throw new DurableExecutionTerminalError("cancelled", "The workflow attempt was cancelled.");
      used.add(id);
    };
    const track = <T>(operation: Promise<T>): Promise<T> => {
      pending.add(operation);
      // Attach handlers even when user code forgets to await an operation.
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
    try {
      const guardedHost: ExecutionHostContextV1 = { ...execution.host, cancellation: {
        get aborted() { return !!violation || execution.host.cancellation.aborted; },
        get reason() { return violation ? "host_terminated" as const : execution.host.cancellation.reason; },
      } };
      const output = await this.#base.execute({ workflowContractVersion: execution.workflowContractVersion, host: guardedHost,
        execute: async context => {
          const steps: WorkflowStepOperationsV2 = {
            run: (step, input) => {
              guard(step.id);
              return track(context.steps.run(step, input));
            },
            waitForInput: <Response extends InputResponseV1>(options: { id: string; title: string; form: InputFormV1<Response>; expiresAfter: InputWaitDurationV1 }) => {
              guard(options.id);
              if (pending.size) invalid("Input may be requested only between completed steps, never inside or alongside one.");
              waiting = true;
              return track((async () => {
                try {
                  const form = defineInputForm(options.form);
                  const saved = await this.#input.openRequest(ref, owner, { stepId: options.id, title: options.title,
                    form: form.descriptor, expiresAfter: options.expiresAfter,
                    ...(execution.runExpiresAt ? { runExpiresAt: execution.runExpiresAt } : {}) });
                  const state = await this.#input.read(ref);
                  if (!state || terminalRun(state) || !sameOwner(state.owner, owner)) throw new Error("Run ownership or status changed at its input step.");
                  const stored = state.requests[saved.requestId];
                  if (stored.status === "pending") { request = saved; throw suspension; }
                  if (stored.status !== "submitted") throw new DurableExecutionTerminalError("input_closed", "Input request is cancelled or expired.");
                  // Submission owns retained-validator execution. Do not transform
                  // the already accepted answer a second time during replay.
                  const answer = validateInputResponseShapeV1(form.descriptor, stored.response);
                  const binding: StepDefinitionBindingV1 = { workflowContractVersion: execution.workflowContractVersion,
                    stepDefinitionVersion: "input-wait-v1", stepDefinitionSha256: hashJson({ kind: "input-wait", buildSha256: state.binding.buildSha256,
                      formSha256: saved.formSha256, optionsSha256: stored.optionsSha256 }), inputSha256: hashJson(saved) };
                  const stepRef = { runRef: ref, stepId: saved.stepId };
                  const previous = await this.#options.storage.steps.read<InputRequestV1, InputResponseV1>(stepRef);
                  let completed: CompletedStepV1<InputRequestV1, InputResponseV1>;
                  if (previous?.state === "COMPLETED") {
                    if (!sameStepBinding(previous.binding, binding) || hashJson(inputWaitJsonSnapshot(previous.completed!.output)) !== hashJson(answer)) throw new Error("Retained input checkpoint differs from its accepted response.");
                    completed = previous.completed!;
                  } else {
                    const claim = await this.#options.storage.steps.claim<InputRequestV1, InputResponseV1>({ ref: stepRef, binding,
                      attemptId: owner.attemptId, fence: owner.fence, expectedRevision: previous?.revision ?? 0, claimedAt: this.#now() });
                    if (claim.kind !== "claimed") throw new Error(`Input checkpoint cannot be claimed: ${claim.kind}.`);
                    const timing = inputRequestTimingV1(saved, state.receipts[stored.submissionId!].acceptedAt);
                    const token = { availability: "unavailable" as const, reason: "not_applicable" as const };
                    completed = { schemaVersion: 1, ref: stepRef, binding, input: immutableJson(saved, "Input request"), output: immutableJson(answer, "Accepted input"),
                      execution: { status: "completed", attemptCount: claim.checkpoint.attemptCount, startedAt: timing.startedAt, completedAt: timing.completedAt, elapsedMs: timing.elapsedMs },
                      performance: { inputTokens: token, outputTokens: token, cachedInputTokens: token, reasoningTokens: token }, artifacts: [] };
                    await this.#options.storage.steps.complete({ ref: stepRef, claimToken: claim.claimToken, completed, at: this.#now() });
                  }
                  // Persist checkpoint first. A crash before consuming the command
                  // reuses that same checkpoint instead of repeating callbacks.
                  await this.#input.completeInput(ref, owner, saved.requestId);
                  return completed as CompletedStepV1<InputRequestV1, Response>;
                } finally { waiting = false; }
              })());
            },
          };
          const workflowContext: WorkflowExecutionContextV2 = { ...context, get deadlineAt() { return context.deadlineAt; }, steps };
          execution.host.diagnosticExclude?.(workflowContext);
          const result = await execution.execute(workflowContext);
          if (request) throw suspension;
          if (pending.size) invalid("Workflow returned without awaiting its operations.");
          if (violation) throw violation;
          return result;
        } });
      return { status: "completed", output };
    } catch (error) {
      if (error === suspension && request && !violation) return { status: "suspended", request: immutableJson(request, "Saved input request") as DeepReadonly<InputRequestV1> };
      throw error;
    } finally {
      closed = true;
      await Promise.allSettled([...pending]);
    }
  }
  #now(): string { return (this.#options.now?.() ?? new Date()).toISOString(); }
}
