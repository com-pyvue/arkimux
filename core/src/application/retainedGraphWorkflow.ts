import type { ExecutionHostContextV1 } from "./durableExecution.ts";
import { DurableGraphSchedulerV1 } from "./durableGraphScheduler.ts";
import type { DurableWorkflowEngineV2 } from "./durableWorkflowEngine.ts";
import { hashJson, type DeepReadonly, type JsonValue } from "./durableWorkflow.ts";
import type { GraphEntryRequestV1, GraphAcceptedBoundaryV1, GraphRunInvocationV1 } from "./graphInvocationRecords.ts";
import { validateGraphAcceptedBoundaryV1, validateGraphRunInvocationV1 } from "./graphInvocationRecords.ts";
import type { GraphWorkflowV1 } from "./graphWorkflow.ts";
import { inputWaitJsonSnapshot } from "./inputWait.ts";

export interface RetainedGraphWorkflowExecutionV1<Output extends JsonValue = JsonValue> {
  readonly graph: GraphWorkflowV1<JsonValue, Output>;
  readonly invocation: GraphRunInvocationV1;
  readonly accepted: GraphAcceptedBoundaryV1;
  readonly request?: GraphEntryRequestV1;
  readonly host: ExecutionHostContextV1;
  readonly engine: DurableWorkflowEngineV2;
}

/** Bridges retained graph records to the serial scheduler. It accepts only an
 * immutable supplied or already accepted deferred boundary; request creation,
 * submission and resume dispatch remain host/storage responsibilities. */
export async function executeRetainedGraphWorkflowV1<Output extends JsonValue>(
  execution: RetainedGraphWorkflowExecutionV1<Output>,
): Promise<DeepReadonly<Output>> {
  const invocation = validateGraphRunInvocationV1(execution.graph, execution.invocation);
  if (hashJson(inputWaitJsonSnapshot(invocation.runRef)) !== hashJson(inputWaitJsonSnapshot(execution.host.runRef))) {
    throw new Error("Retained graph invocation belongs to another Run.");
  }
  const accepted = validateGraphAcceptedBoundaryV1(execution.graph, invocation, execution.request, execution.accepted);
  const scheduler = new DurableGraphSchedulerV1({ engine: execution.engine });
  return scheduler.executeEntry({ graph: execution.graph, host: execution.host,
    plan: invocation.entryPlan, boundary: accepted.boundary });
}
