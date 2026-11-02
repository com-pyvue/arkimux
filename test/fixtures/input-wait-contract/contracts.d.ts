/** Approved input-wait@1 API declarations. Not yet exported by a runtime package. */
import type {
  CompletedStepV1,
  ValueValidatorV1,
  WorkflowExecutionContextV1,
  WorkflowStepOperationsV1,
} from "../../../core/src/application/durableWorkflow.ts";

type FieldBase = { id: string; label: string; required: boolean };
export type InputFieldV1 = FieldBase & (
  | { type: "text"; maxLength: number }
  | { type: "number"; min: number; max: number; integer: boolean }
  | { type: "boolean" }
  | { type: "date" }
  | { type: "choice"; options: string[] }
  | { type: "files"; maxFiles: number; maxBytesPerFile: number; mediaTypes: string[] }
);
export type InputFormDescriptorV1 = {
  schemaVersion: 1;
  id: string;
  version: string;
  fields: InputFieldV1[];
};
export type ImmutableInputFileRefV1 = {
  objectId: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
};
export type InputResponseV1 = {
  schemaVersion: 1;
  fields: { [id: string]: string | number | boolean };
  files: { [id: string]: ImmutableInputFileRefV1[] };
};
export interface InputFormV1<Response extends InputResponseV1> {
  readonly descriptor: InputFormDescriptorV1;
  readonly output: ValueValidatorV1<Response>;
}
/** Fixed definition, not the mutable request-state record. */
export type InputRequestV1 = {
  schemaVersion: 1;
  requestId: string;
  stepId: string;
  title: string;
  form: InputFormDescriptorV1;
  formSha256: string;
  executableBindingId: string;
  createdAt: string;
  expiresAt: string;
};
/** Runtime validation must enforce positive integers and the 366-day maximum. */
export type InputWaitDurationV1 = `${number}${"s" | "m" | "h" | "d"}`;
export interface WorkflowStepOperationsV2 extends WorkflowStepOperationsV1 {
  waitForInput<Response extends InputResponseV1>(options: {
    id: string;
    title: string;
    form: InputFormV1<Response>;
    expiresAfter: InputWaitDurationV1;
  }): Promise<CompletedStepV1<InputRequestV1, Response>>;
}
export interface WorkflowExecutionContextV2 extends WorkflowExecutionContextV1 {
  readonly steps: WorkflowStepOperationsV2;
}
