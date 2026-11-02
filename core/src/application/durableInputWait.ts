/** Internal host/engine contracts only. No runtime implementation or public plugin export. */
import type { DeepReadonly, JsonValue } from "./durableWorkflow.ts";
import type { InputRequestV1 } from "./inputWait.ts";
import type { DurableWorkflowRunOutcomeV1 } from "./durableWorkflowRun.ts";
import type { RetainedOwnerV1, RetainedRunControlV1 } from "./retainedExecution.ts";
import type { RunRef } from "../domain/runIdentity.ts";
import type { InputFormDescriptorV1, InputResponseV1 } from "./inputWait.ts";

export type SuspendedInputOutcomeV1 = {
  readonly status: "suspended";
  /** The fixed persisted definition; reporting this requires a durable pending request. */
  readonly request: DeepReadonly<InputRequestV1>;
};
export type DurableWorkflowEngineOutcomeV3<Output extends JsonValue> =
  | { readonly status: "completed"; readonly output: DeepReadonly<Output> }
  | SuspendedInputOutcomeV1;
export type DurableWorkflowRunOutcomeV2 = DurableWorkflowRunOutcomeV1 | SuspendedInputOutcomeV1;

/** Engine-facing subset of the retained store; no filesystem or HTTP dependency. */
export interface DurableInputControlV1 {
  read(ref: RunRef): Promise<RetainedRunControlV1 | undefined>;
  openRequest(ref: RunRef, owner: RetainedOwnerV1, options: {
    stepId: string; title: string; form: InputFormDescriptorV1; expiresAfter: string; runExpiresAt?: string;
  }): Promise<InputRequestV1>;
  completeInput(ref: RunRef, owner: RetainedOwnerV1, requestId: string): Promise<InputResponseV1>;
}
