import type { CompletedStepV1, InputRequestV1, InputResponseV1, InputFormV1,
  WorkflowExecutionContextV2, WorkflowStepOperationsV2, RunStateV6 } from "../../core/src/index.ts";
import type { WorkflowExecutionContextV2 as ApprovedContext } from "../fixtures/input-wait-contract/contracts.d.ts";
// @ts-expect-error The internal suspended host outcome is not a public plugin contract.
import type { SuspendedInputOutcomeV1 } from "../../core/src/index.ts";
declare const approved: ApprovedContext;
declare const context: WorkflowExecutionContextV2;
const forwards: WorkflowExecutionContextV2 = approved;
const backwards: ApprovedContext = context;
const steps: WorkflowStepOperationsV2 = context.steps;
declare const form: InputFormV1<InputResponseV1>;
const result: Promise<CompletedStepV1<InputRequestV1, InputResponseV1>> = steps.waitForInput({ id: "ask", title: "Answer", form, expiresAfter: "366d" });
// @ts-expect-error Stable named steps cannot omit the expiry.
steps.waitForInput({ id: "ask", title: "Answer", form });
// @ts-expect-error No arbitrary calendar duration string.
steps.waitForInput({ id: "ask", title: "Answer", form, expiresAfter: "1year" });
declare const state: RunStateV6;
if (state.status?.status === "waiting_for_input") {
  const spent: number = state.status.activeComputeMs;
  const requestId: string = state.status.requestId;
  void spent; void requestId;
}
void forwards; void backwards; void result;
