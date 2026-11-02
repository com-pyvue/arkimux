import { validateRunActor, type RunActor } from "../domain/runActor.ts";
import {
  validateRunConfigurationReference,
  type RunConfigurationReference,
} from "../domain/runConfigurationReference.ts";
import { validateRunRef, type RunRef } from "../domain/runIdentity.ts";
import {
  validateWorkflowIdentity,
  type WorkflowIdentity,
} from "../domain/workflowIdentity.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";

export interface TrustedRunCommand<TInput = unknown> {
  runRef: RunRef;
  actor: RunActor;
  workflow: WorkflowIdentity;
  input: TInput;
  runConfiguration: RunConfigurationReference;
}

export function validateTrustedRunCommand<TInput>(
  value: unknown,
  validateInput: (input: unknown) => TInput,
): TrustedRunCommand<TInput> {
  if (!isRecord(value)) throw new Error("Trusted run command must be an object.");
  assertExactKeys(
    value,
    ["runRef", "actor", "workflow", "input", "runConfiguration"],
    "Trusted run command",
  );
  return {
    runRef: validateRunRef(value.runRef),
    actor: validateRunActor(value.actor),
    workflow: validateWorkflowIdentity(value.workflow),
    input: validateInput(value.input),
    runConfiguration: validateRunConfigurationReference(value.runConfiguration),
  };
}
