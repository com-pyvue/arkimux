import { assertSafeIdentifier } from "./identifiers.ts";
import { assertExactKeys, isRecord } from "./validation.ts";

export interface WorkflowIdentity {
  kind: string;
  version: number;
}

export function validateWorkflowIdentity(value: unknown): WorkflowIdentity {
  if (!isRecord(value)) throw new Error("Workflow identity must be an object.");
  assertExactKeys(value, ["kind", "version"], "Workflow identity");
  assertSafeIdentifier(value.kind, "Workflow identity.kind");
  if (!Number.isInteger(value.version) || (value.version as number) <= 0) {
    throw new Error("Workflow identity.version must be a positive integer.");
  }
  return { kind: value.kind, version: value.version as number };
}
