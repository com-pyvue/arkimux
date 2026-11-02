import type { RunEventSink } from "./runLifecycle.ts";
import { getExternalErrorDiagnostic, getFailureRetryability, type ExternalErrorDiagnostic,
  type FailureRetryabilityV1 } from "./externalError.ts";
import type { RunRef } from "../domain/runIdentity.ts";
import type { WorkflowInvocationStoreV1 } from "./durableWorkflowInvocation.ts";
import type {
  ArtifactRefV1,
  CompletedStepV1,
  DeepReadonly,
  EffectSafetyClassV1,
  JsonValue,
  StepDefinitionBindingV1,
  StepDetailsRefV1,
  StepPerformanceV1,
  StepRefV1,
} from "./durableWorkflow.ts";

export type StepCheckpointStateV1 = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "OUTCOME_UNKNOWN";
export interface ClaimTokenV1 {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly fence: number;
  readonly expectedRevision: number;
}
export interface TerminalRecordV1 { readonly code: string; readonly message: string; readonly at: string;
  readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }
export interface RetryAdmissionV1 {
  readonly retryId: string;
  readonly policyId: string;
  readonly fromAttempt: number;
  readonly admittedAt: string;
}
export interface RetryTerminalRequestV1<Ref> {
  readonly ref: Ref;
  readonly retryId: string;
  readonly policyId: string;
  readonly expectedRevision: number;
  readonly expectedAttemptCount: number;
  readonly attemptId: string;
  readonly fence: number;
  readonly at: string;
}
export interface StepCheckpointV1<Input extends JsonValue = JsonValue, Output extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly ref: StepRefV1;
  readonly binding: StepDefinitionBindingV1;
  readonly state: StepCheckpointStateV1;
  readonly revision: number;
  readonly attemptCount: number;
  readonly activeClaim?: ClaimTokenV1;
  readonly completed?: CompletedStepV1<Input, Output>;
  readonly terminal?: TerminalRecordV1;
  readonly retryAdmissions?: readonly RetryAdmissionV1[];
  readonly effectOperationIds: readonly string[];
  readonly agentOperationIds: readonly string[];
  readonly updatedAt: string;
}
export interface StepClaimRequestV1 {
  readonly ref: StepRefV1;
  readonly binding: StepDefinitionBindingV1;
  readonly attemptId: string;
  readonly fence: number;
  readonly expectedRevision: number;
  readonly claimedAt: string;
}
export type StepClaimResultV1<Input extends JsonValue, Output extends JsonValue> =
  | { readonly kind: "claimed"; readonly checkpoint: StepCheckpointV1<Input, Output>; readonly claimToken: ClaimTokenV1 }
  | { readonly kind: "completed"; readonly completed: CompletedStepV1<Input, Output> }
  | { readonly kind: "busy"; readonly checkpoint: StepCheckpointV1<Input, Output> }
  | { readonly kind: "terminal"; readonly checkpoint: StepCheckpointV1<Input, Output> }
  | { readonly kind: "incompatible"; readonly reasonCode: "definition_mismatch" | "input_mismatch" };
export interface ClaimedStepTransitionV1 { readonly ref: StepRefV1; readonly claimToken: ClaimTokenV1; readonly at: string }
export type DurableOperationKindV1 = "agent" | "effect";
export interface RegisterStepOperationRequestV1 extends ClaimedStepTransitionV1 {
  readonly kind: DurableOperationKindV1;
  readonly operationId: string;
}
export interface StepCheckpointStoreV2 {
  read<Input extends JsonValue, Output extends JsonValue>(ref: StepRefV1): Promise<StepCheckpointV1<Input, Output> | undefined>;
  claim<Input extends JsonValue, Output extends JsonValue>(request: StepClaimRequestV1): Promise<StepClaimResultV1<Input, Output>>;
  registerOperation(request: RegisterStepOperationRequestV1): Promise<void>;
  complete<Input extends JsonValue, Output extends JsonValue>(request: ClaimedStepTransitionV1 & { readonly completed: CompletedStepV1<Input, Output> }): Promise<CompletedStepV1<Input, Output>>;
  fail(request: ClaimedStepTransitionV1 & { readonly code: string; readonly message: string;
    readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void>;
  cancel(request: ClaimedStepTransitionV1 & { readonly code: "cancelled" | "deadline_exceeded" | "host_terminated" }): Promise<void>;
  markOutcomeUnknown(request: ClaimedStepTransitionV1 & { readonly code: string; readonly message: string;
    readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void>;
  reopenForRetry<Input extends JsonValue, Output extends JsonValue>(request: RetryTerminalRequestV1<StepRefV1>): Promise<StepCheckpointV1<Input, Output>>;
}

export type EffectOperationStateV1 = "PENDING" | "DISPATCHED" | "COMPLETED" | "FAILED" | "CANCELLED" | "OUTCOME_UNKNOWN";
export interface EffectOperationRefV1 { readonly runRef: RunRef; readonly operationId: string }
export interface EffectDefinitionBindingV1 {
  readonly definitionVersion: string;
  readonly definitionSha256: string;
  readonly inputSha256: string;
  readonly safety: EffectSafetyClassV1;
}
export interface EffectOperationV1<Output extends JsonValue = JsonValue> extends EffectDefinitionBindingV1 {
  readonly schemaVersion: 1;
  readonly ref: EffectOperationRefV1;
  readonly state: EffectOperationStateV1;
  readonly revision: number;
  readonly attemptCount: number;
  readonly adapterConformanceRecorded: boolean;
  readonly activeClaim?: ClaimTokenV1;
  readonly output?: DeepReadonly<Output>;
  readonly terminal?: TerminalRecordV1;
  readonly retryAdmissions?: readonly RetryAdmissionV1[];
  readonly updatedAt: string;
}
export interface EffectOperationStoreV1 {
  read<Output extends JsonValue>(ref: EffectOperationRefV1): Promise<EffectOperationV1<Output> | undefined>;
  claim<Output extends JsonValue>(request: { readonly ref: EffectOperationRefV1; readonly definitionVersion: string; readonly definitionSha256: string; readonly inputSha256: string; readonly safety: EffectSafetyClassV1; readonly adapterConformanceRecorded: boolean; readonly attemptId: string; readonly fence: number; readonly expectedRevision: number; readonly claimedAt: string }): Promise<EffectOperationV1<Output>>;
  markDispatched(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly at: string }): Promise<void>;
  complete<Output extends JsonValue>(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly output: DeepReadonly<Output>; readonly at: string }): Promise<DeepReadonly<Output>>;
  fail(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: string; readonly message: string; readonly at: string;
    readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void>;
  cancel(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: "cancelled" | "deadline_exceeded" | "host_terminated"; readonly at: string }): Promise<void>;
  markOutcomeUnknown(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: string; readonly message: string; readonly at: string;
    readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void>;
  reopenForRetry<Output extends JsonValue>(request: RetryTerminalRequestV1<EffectOperationRefV1>): Promise<EffectOperationV1<Output>>;
}

export type AgentOperationStateV1 = EffectOperationStateV1;
export interface AgentOperationRefV1 { readonly runRef: RunRef; readonly operationId: string }
export interface AgentOperationBindingV1 {
  readonly sourceOperationId: string;
  readonly slotId: string;
  readonly providerId: string;
  readonly authProviderId: string;
  readonly model?: string;
  readonly configurationSha256: string;
  readonly inputSha256: string;
}
export interface AgentOperationV1<Output extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly ref: AgentOperationRefV1;
  readonly binding: AgentOperationBindingV1;
  readonly state: AgentOperationStateV1;
  readonly revision: number;
  readonly attemptCount: number;
  readonly activeClaim?: ClaimTokenV1;
  readonly output?: DeepReadonly<Output>;
  readonly performance?: StepPerformanceV1;
  readonly artifacts?: readonly ArtifactRefV1[];
  readonly detailsRef?: StepDetailsRefV1;
  readonly terminal?: TerminalRecordV1;
  readonly retryAdmissions?: readonly RetryAdmissionV1[];
  readonly updatedAt: string;
}
export interface AgentOperationStoreV1 {
  read<Output extends JsonValue>(ref: AgentOperationRefV1): Promise<AgentOperationV1<Output> | undefined>;
  claim<Output extends JsonValue>(request: { readonly ref: AgentOperationRefV1; readonly binding: AgentOperationBindingV1; readonly attemptId: string; readonly fence: number; readonly expectedRevision: number; readonly claimedAt: string }): Promise<AgentOperationV1<Output>>;
  markDispatched(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly at: string }): Promise<void>;
  complete<Output extends JsonValue>(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly output: DeepReadonly<Output>; readonly performance: StepPerformanceV1; readonly artifacts: readonly ArtifactRefV1[]; readonly detailsRef?: StepDetailsRefV1; readonly at: string }): Promise<DeepReadonly<Output>>;
  fail(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: string; readonly message: string; readonly at: string;
    readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void>;
  cancel(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: "cancelled" | "deadline_exceeded" | "host_terminated"; readonly at: string }): Promise<void>;
  markOutcomeUnknown(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: string; readonly message: string; readonly at: string;
    readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void>;
  reopenForRetry<Output extends JsonValue>(request: RetryTerminalRequestV1<AgentOperationRefV1>): Promise<AgentOperationV1<Output>>;
}

export interface ExecutionEventV1 {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly runRef: RunRef;
  readonly at: string;
  readonly type: "step-claimed" | "step-completed" | "step-failed" | "step-cancelled" | "step-outcome-unknown" | "effect-dispatched" | "effect-completed" | "effect-failed" | "effect-cancelled" | "effect-outcome-unknown";
  readonly stepId?: string;
  readonly operationId?: string;
  readonly code?: string;
}
export interface DurableExecutionEventSinkV1 extends RunEventSink<Omit<ExecutionEventV1, "sequence">> {}
export interface DurableExecutionStorageV2 {
  readonly steps: StepCheckpointStoreV2;
  readonly agents: AgentOperationStoreV1;
  readonly effects: EffectOperationStoreV1;
  readonly events: DurableExecutionEventSinkV1;
}

/** Complete storage composition from the accepted durable-workflow-engine@2 contract. */
export interface ExecutionStorageV2<
  RunStateStore,
  RunEventSink,
  RunPerformanceStore,
  RunArtifactStore,
  PublishedResultStore,
> {
  readonly schemaVersion: 1;
  readonly runState: RunStateStore;
  readonly steps: StepCheckpointStoreV2;
  readonly agents: AgentOperationStoreV1;
  readonly effects: EffectOperationStoreV1;
  readonly events: RunEventSink;
  readonly performance: RunPerformanceStore;
  readonly artifacts: RunArtifactStore;
  readonly results: PublishedResultStore;
}

/** V3 adds the immutable invocation required to reconstruct an interrupted Run. */
export interface ExecutionStorageV3<
  RunStateStore,
  RunEventSink,
  RunPerformanceStore,
  RunArtifactStore,
  PublishedResultStore,
> extends ExecutionStorageV2<RunStateStore, RunEventSink, RunPerformanceStore, RunArtifactStore, PublishedResultStore> {
  readonly invocations: WorkflowInvocationStoreV1;
}

export interface ExecutionAttemptV1 {
  readonly schemaVersion: 1;
  readonly runRef: RunRef;
  readonly attemptId: string;
  readonly fence: number;
  readonly deadlineAt: string;
  readonly finalizationReserveMs: number;
  readonly scratchDirectory: string;
  readonly limits: { readonly maxDurationMs: number; readonly maxScratchBytes: number };
}
export interface ExecutionHostContextV1 extends ExecutionAttemptV1 {
  readonly cancellation: { readonly aborted: boolean; readonly reason?: "cancelled" | "deadline_exceeded" | "host_terminated" };
  readonly heartbeat: () => Promise<void>;
  /** Internal diagnostic-only hooks. Ordinary hosts retain fixed deadlines.
   * Running external operations keep the deadline captured at dispatch. */
  readonly diagnosticClock?: { deadlineAt(): string; remainingMs?(): number };
  readonly diagnosticActivity?: <T>(work: () => T | Promise<T>) => Promise<T>;
  /** Registers newly created framework contexts before project code receives
   * them, so diagnostic readers can exclude their identities and owned graph. */
  readonly diagnosticExclude?: (value: unknown) => void;
}
export type ExecutionHostOutcomeV1<Output extends JsonValue> =
  | { readonly status: "completed"; readonly output: DeepReadonly<Output> }
  | { readonly status: "failed"; readonly code: string; readonly message: string; readonly retryability?: FailureRetryabilityV1;
      readonly externalDiagnostic?: ExternalErrorDiagnostic }
  | { readonly status: "cancelled"; readonly reason: "cancelled" | "deadline_exceeded" | "host_terminated" }
  | { readonly status: "outcome_unknown"; readonly code: string; readonly message: string; readonly retryability?: FailureRetryabilityV1;
      readonly externalDiagnostic?: ExternalErrorDiagnostic };
export interface ExecutionHostV1 {
  executeAttempt<Output extends JsonValue>(attempt: ExecutionAttemptV1, executeWorkflow: (context: ExecutionHostContextV1) => Promise<DeepReadonly<Output>>): Promise<ExecutionHostOutcomeV1<Output>>;
  cancel(runRef: RunRef, reason: "cancelled" | "deadline_exceeded" | "host_terminated"): Promise<void>;
}

export class DurableRecordConflictError extends Error {
  constructor(message: string) { super(message); this.name = "DurableRecordConflictError"; }
}
export class DurableExecutionTerminalError extends Error {
  readonly externalDiagnostic?: ExternalErrorDiagnostic;
  readonly retryability: FailureRetryabilityV1;
  constructor(readonly code: string, message: string, options?: { cause?: unknown; retryability?: FailureRetryabilityV1 }) {
    super(message, options); this.name = "DurableExecutionTerminalError";
    const diagnostic = getExternalErrorDiagnostic(options?.cause);
    if (diagnostic) this.externalDiagnostic = diagnostic;
    this.retryability = options?.retryability ?? getFailureRetryability(options?.cause);
  }
}
export class DurableOutcomeUnknownError extends DurableExecutionTerminalError {
  constructor(message: string, options?: { cause?: unknown; retryability?: FailureRetryabilityV1 }) { super("outcome_unknown", message, options); this.name = "DurableOutcomeUnknownError"; }
}

export function sameStepBinding(left: StepDefinitionBindingV1, right: StepDefinitionBindingV1): boolean {
  return left.workflowContractVersion === right.workflowContractVersion
    && left.stepDefinitionVersion === right.stepDefinitionVersion
    && left.stepDefinitionSha256 === right.stepDefinitionSha256
    && left.inputSha256 === right.inputSha256;
}
export function sameAgentBinding(left: AgentOperationBindingV1, right: AgentOperationBindingV1): boolean {
  return left.sourceOperationId === right.sourceOperationId
    && left.slotId === right.slotId
    && left.providerId === right.providerId
    && left.authProviderId === right.authProviderId
    && left.model === right.model
    && left.configurationSha256 === right.configurationSha256
    && left.inputSha256 === right.inputSha256;
}
export function sameEffectBinding(left: EffectOperationV1 | EffectDefinitionBindingV1, right: EffectDefinitionBindingV1): boolean {
  return left.definitionVersion === right.definitionVersion
    && left.definitionSha256 === right.definitionSha256
    && left.inputSha256 === right.inputSha256
    && left.safety === right.safety;
}
