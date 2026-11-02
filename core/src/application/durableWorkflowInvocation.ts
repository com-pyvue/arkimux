import type { RunConfigurationReference } from "../domain/runConfigurationReference.ts";
import { validateRunConfigurationReference } from "../domain/runConfigurationReference.ts";
import type { RunRef } from "../domain/runIdentity.ts";
import { validateRunRef } from "../domain/runIdentity.ts";
import type { WorkflowIdentity } from "../domain/workflowIdentity.ts";
import { validateWorkflowIdentity } from "../domain/workflowIdentity.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";
import {
  assertDurableIdentifier,
  immutableJson,
  type DeepReadonly,
  type JsonValue,
  type ValueValidatorV1,
  type WorkflowExecutionContextV1,
} from "./durableWorkflow.ts";

/** Immutable data needed to reconstruct a workflow call after process restart. */
export interface WorkflowInvocationV1<Input extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly runRef: RunRef;
  readonly workflow: WorkflowIdentity;
  readonly workflowContractVersion: string;
  readonly runConfiguration: RunConfigurationReference;
  readonly resultKind: string;
  readonly input: DeepReadonly<Input>;
  readonly createdAt: string;
}

export interface WorkflowInvocationStoreV1 {
  create<Input extends JsonValue>(invocation: WorkflowInvocationV1<Input>): Promise<void>;
  read<Input extends JsonValue>(runRef: RunRef): Promise<WorkflowInvocationV1<Input> | undefined>;
}

export interface DurableWorkflowDefinitionV1<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
> {
  readonly workflow: WorkflowIdentity;
  readonly workflowContractVersion: string;
  readonly resultKind: string;
  readonly input: ValueValidatorV1<Input>;
  readonly output: ValueValidatorV1<Output>;
  execute(context: WorkflowExecutionContextV1, input: DeepReadonly<Input>): Promise<Output>;
}

export interface DurableWorkflowDefinitionResolverV1 {
  resolve(
    workflow: WorkflowIdentity,
    workflowContractVersion: string,
  ): DurableWorkflowDefinitionV1 | undefined;
}

export interface DurableRunConfigurationResolverV1<ResolvedConfiguration = unknown> {
  resolve(
    workflow: WorkflowIdentity,
    reference: RunConfigurationReference,
  ): Promise<ResolvedConfiguration | undefined>;
}

export interface ResolvedInterruptedWorkflowV1<ResolvedConfiguration = unknown> {
  readonly invocation: WorkflowInvocationV1;
  readonly definition: DurableWorkflowDefinitionV1;
  readonly runConfiguration: ResolvedConfiguration;
}

export function validateWorkflowInvocationV1<Input extends JsonValue = JsonValue>(
  value: unknown,
): WorkflowInvocationV1<Input> {
  if (!isRecord(value)) throw new Error("Workflow invocation must be an object.");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "runRef",
      "workflow",
      "workflowContractVersion",
      "runConfiguration",
      "resultKind",
      "input",
      "createdAt",
    ],
    "Workflow invocation",
  );
  if (value.schemaVersion !== 1) throw new Error("Workflow invocation.schemaVersion must be 1.");
  if (typeof value.workflowContractVersion !== "string") throw new Error("Workflow invocation.workflowContractVersion must be a string.");
  assertDurableIdentifier(value.workflowContractVersion, "Workflow contract version");
  if (typeof value.resultKind !== "string") throw new Error("Workflow invocation.resultKind must be a string.");
  assertDurableIdentifier(value.resultKind, "Workflow result kind");
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("Workflow invocation.createdAt must be an ISO timestamp.");
  }
  return {
    schemaVersion: 1,
    runRef: validateRunRef(value.runRef),
    workflow: validateWorkflowIdentity(value.workflow),
    workflowContractVersion: value.workflowContractVersion,
    runConfiguration: validateRunConfigurationReference(value.runConfiguration),
    resultKind: value.resultKind,
    input: immutableJson(value.input as Input, "Workflow invocation input"),
    createdAt: value.createdAt,
  };
}

export function assertInvocationMatchesDefinition(
  invocation: WorkflowInvocationV1,
  definition: DurableWorkflowDefinitionV1,
): void {
  if (
    invocation.workflow.kind !== definition.workflow.kind
    || invocation.workflow.version !== definition.workflow.version
    || invocation.workflowContractVersion !== definition.workflowContractVersion
    || invocation.resultKind !== definition.resultKind
  ) {
    throw new Error("Workflow invocation does not match the resolved workflow definition.");
  }
}
