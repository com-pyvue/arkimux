import {
  validateWorkflowIdentity,
  type WorkflowIdentity,
} from "@com-pyvue/agent-execution-core";

export interface RunConfigurationDefinition {
  configurationId: string;
  workflow: WorkflowIdentity;
}

export interface RunConfigurationDefinitionValidator<
  TDefinition extends RunConfigurationDefinition = RunConfigurationDefinition,
> {
  workflow: WorkflowIdentity;
  validate(value: unknown, expectedConfigurationId?: string): TDefinition;
}

export class DuplicateRunConfigurationValidatorError extends Error {
  constructor(readonly workflowKey: string) {
    super(`Run configuration validator is registered more than once: ${workflowKey}`);
    this.name = "DuplicateRunConfigurationValidatorError";
  }
}

export class UnknownRunConfigurationWorkflowError extends Error {
  constructor(readonly workflowKey: string) {
    super(`Run configuration workflow is not registered: ${workflowKey}`);
    this.name = "UnknownRunConfigurationWorkflowError";
  }
}

export class RunConfigurationDefinitionValidatorRegistry {
  readonly #validators = new Map<string, RunConfigurationDefinitionValidator>();

  constructor(validators: readonly RunConfigurationDefinitionValidator[] = []) {
    for (const validator of validators) this.register(validator);
  }

  register(validator: RunConfigurationDefinitionValidator): void {
    const workflow = validateWorkflowIdentity(validator.workflow);
    const key = workflowKey(workflow);
    if (this.#validators.has(key)) throw new DuplicateRunConfigurationValidatorError(key);
    this.#validators.set(key, validator);
  }

  validate(value: unknown, expectedConfigurationId?: string): RunConfigurationDefinition {
    const workflow = workflowFromDefinition(value);
    const key = workflowKey(workflow);
    const validator = this.#validators.get(key);
    if (!validator) throw new UnknownRunConfigurationWorkflowError(key);
    const definition = validator.validate(value, expectedConfigurationId);
    const validatedWorkflow = validateWorkflowIdentity(definition.workflow);
    if (workflowKey(validatedWorkflow) !== key) {
      throw new Error(`Run configuration validator ${key} returned workflow ${workflowKey(validatedWorkflow)}.`);
    }
    return definition;
  }
}

function workflowFromDefinition(value: unknown): WorkflowIdentity {
  if (!isRecord(value)) throw new Error("Run configuration definition must be an object.");
  return validateWorkflowIdentity(value.workflow);
}

function workflowKey(workflow: WorkflowIdentity): string {
  return `${workflow.kind}@${workflow.version}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
