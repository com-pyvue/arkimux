/** Read-only workflow walk, executed only in the disposable validation process. */
import { hashJson, immutableJson, stepDefinitionHash, type CompletedStepV1, type JsonValue } from "../../core/src/application/durableWorkflow.ts";
import { sameStepBinding } from "../../core/src/application/durableExecution.ts";
import { defineInputForm, inputWaitJsonSnapshot, validateInputResponseV1, type InputResponseV1, type WorkflowExecutionContextV2 } from "../../core/src/application/inputWait.ts";
import type { ConstructedRetainedWorkflowV1 } from "../../core/src/application/retainedWorkflowConstruction.ts";
import type { WorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import type { RetainedRunControlV1 } from "../../core/src/application/retainedExecution.ts";

export class RetainedAnswerRejected extends Error {
  constructor() { super("The retained form rejected this answer."); }
}

export async function validateRetainedAnswer(options: {
  constructed: ConstructedRetainedWorkflowV1; invocation: WorkflowInvocationV1;
  requests: RetainedRunControlV1["requests"]; buildSha256: string;
  checkpoints: CompletedStepV1<JsonValue, JsonValue>[]; requestId: string; response: InputResponseV1;
  validationDeadlineAt: string; finalizationReserveMs: number;
}): Promise<InputResponseV1> {
  const checkpoints = new Map(options.checkpoints.map(step => [step.ref.stepId, step]));
  if (checkpoints.size !== options.checkpoints.length || options.checkpoints.some(step => step.ref.runRef.executionId !== options.invocation.runRef.executionId)) {
    throw new Error("Retained input checkpoints do not match the Run.");
  }
  const used = new Set<string>(), done = new Error("Validation reached input");
  let result: InputResponseV1 | undefined, invalid = false, rejected = false, closed = false, pending = 0;
  const fail = (): never => { invalid = true; throw new Error("Retained input validation is incompatible."); };
  const guard = (id: string) => { if (closed || invalid) fail(); if (result) throw done; if (used.has(id)) fail(); used.add(id); };
  const context: WorkflowExecutionContextV2 = { runRef: options.invocation.runRef,
    deadlineAt: options.validationDeadlineAt, finalizationReserveMs: options.finalizationReserveMs,
    cancellation: Object.freeze({ aborted: false }), steps: {
    async run(step, value) {
      guard(step.id); pending++;
      try {
        const input = immutableJson(step.input.parse(value));
        const saved = checkpoints.get(step.id);
        const binding = { workflowContractVersion: options.invocation.workflowContractVersion,
          stepDefinitionVersion: step.definitionVersion, stepDefinitionSha256: stepDefinitionHash(step), inputSha256: hashJson(input) };
        if (!saved || !sameStepBinding(saved.binding, binding)) fail();
        // Never execute step.execute or parse its already validated output again.
        return immutableJson(inputWaitJsonSnapshot(saved!)) as never;
      } finally { pending--; }
    },
    async waitForInput(input) {
      guard(input.id); if (pending) fail();
      const form = defineInputForm(input.form);
      const saved = Object.values(options.requests).find(request => request.definition.stepId === input.id);
      if (!saved || saved.optionsSha256 !== hashJson({ stepId: input.id, title: input.title, form: form.descriptor, expiresAfter: input.expiresAfter })) fail();
      if (saved!.definition.requestId === options.requestId) {
        try { result = inputWaitJsonSnapshot(validateInputResponseV1(form, options.response)) as InputResponseV1; }
        catch { invalid = true; rejected = true; throw new RetainedAnswerRejected(); }
        throw done;
      }
      const checkpoint = checkpoints.get(input.id);
      const binding = { workflowContractVersion: options.invocation.workflowContractVersion, stepDefinitionVersion: "input-wait-v1",
        stepDefinitionSha256: hashJson({ kind: "input-wait", buildSha256: options.buildSha256,
          formSha256: saved!.definition.formSha256, optionsSha256: saved!.optionsSha256 }), inputSha256: hashJson(saved!.definition) };
      if (saved!.status !== "submitted" || !checkpoint || !sameStepBinding(checkpoint.binding, binding)
        || hashJson(checkpoint.output) !== hashJson(inputWaitJsonSnapshot(saved!.response))) fail();
      return immutableJson(inputWaitJsonSnapshot(checkpoint!)) as never;
    },
  } };
  try {
    const input = immutableJson(options.constructed.workflow.input.parse(options.invocation.input));
    await options.constructed.workflow.execute(context, input);
  } catch (error) { if (rejected) throw new RetainedAnswerRejected(); if (error !== done) throw error; }
  finally { closed = true; }
  if (rejected) throw new RetainedAnswerRejected();
  if (invalid || !result || pending) fail();
  return result!;
}
