/** Internal new-Run adapter; not a current-source resolver for existing Runs. */
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { executableBindingSchema, type ExecutableBindingV1 } from "../../core/src/application/retainedExecution.ts";
import { validateWorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { reserveLocalRetainedRun, RetainedRunAdmissionError } from "../../local/src/localRetainedRunAdmission.ts";
import { prepareDeclaredRetainedWorkflowBuild } from "./declaredRetainedWorkflowBuild.ts";

/** Runs the source check, builds/reuses the declared constructor, validates its
 * actual result in isolation, then atomically reserves the immutable binding.
 * The API caller remains responsible for authorization, configuration validation,
 * declared environment resolution, and subsequently publishing/dispatching the Run.
 */
export async function reserveDeclaredRetainedRun(store: FileRetainedExecutionStoreV1, options: {
  projectRoot: string; binding: Omit<ExecutableBindingV1, "buildSha256">;
  workerPath: string; validationTimeoutMs?: number; signal?: AbortSignal;
}) {
  const { projectRoot, workerPath, validationTimeoutMs, signal } = options;
  const binding = executableBindingSchema.parse(inputWaitJsonSnapshot({ ...options.binding, buildSha256: "0".repeat(64) }));
  const invocation = validateWorkflowInvocationV1(binding.invocation);
  if (signal?.aborted) throw new RetainedRunAdmissionError("validation-cancelled");
  const prepared = await prepareDeclaredRetainedWorkflowBuild(store, { projectRoot,
    workflowId: invocation.workflow.kind, hostRequirements: binding.hostRequirements });
  if (prepared.workflow.manifest.workflowContractVersion !== invocation.workflowContractVersion
    || prepared.workflow.declaration.result.kind !== invocation.resultKind) throw new RetainedRunAdmissionError("invalid-binding");
  binding.buildSha256 = prepared.manifest.buildSha256;
  return reserveLocalRetainedRun(store, { runRef: invocation.runRef, binding,
    agentSlotIds: prepared.workflow.declaration.agentSlots, workerPath, validationTimeoutMs, signal });
}
