/**
 * Retained graph failure-policy contract. Intentionally not exported from Core's
 * public root until a graph runtime implements the advertised capabilities.
 */
import {
  graphInstanceNodeV1, validateGraphInstanceAddressV1, type GraphInstanceAddressV1,
} from "./graphInstance.ts";
import type { GraphDefinitionV1, GraphValueContractV1 } from "./graphWorkflow.ts";
import { readExternalErrorDiagnostic, type ExternalErrorDiagnostic, type FailureRetryabilityV1 } from "./externalError.ts";
import { assertDurableIdentifier, immutableJson, type JsonValue } from "./durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "./inputWait.ts";
import { graphPrivateWeakMap, graphPrivateWeakSet } from "./graphPrivateRegistry.ts";
import { canonicalTimestamp } from "./recordValidation.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";

export type GraphFailureClassV1 = "workflow" | "external-provider" | "platform";
export type GraphFailureRetryabilityV1 = FailureRetryabilityV1;

export interface GraphFailureEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly failureId: string;
  readonly class: GraphFailureClassV1;
  readonly code: string;
  readonly message: string;
  readonly retryability: GraphFailureRetryabilityV1;
  readonly instance: {
    readonly address: GraphInstanceAddressV1;
    readonly attempt: number;
  };
  readonly occurredAt: string;
  readonly externalDiagnostic?: ExternalErrorDiagnostic;
}

export type GraphRetryScopeV1 =
  | "node-instance"
  | "subgraph-instance"
  | "map-item"
  | "map-instance"
  | "reduce-iteration"
  | "reduce-instance"
  | "loop-iteration"
  | "loop-instance";

export interface GraphRetryPolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "retry";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly scope: GraphRetryScopeV1;
  /** Includes the initial attempt. */
  readonly maxAttempts: number;
  readonly retryOn: readonly GraphFailureClassV1[];
  readonly exhaustion: "propagate-failure";
}

export interface GraphCatchPolicyV1<Output extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly kind: "catch";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly handlerDefinitionId: string;
  readonly failures: readonly {
    readonly class: GraphFailureClassV1;
    readonly codes?: readonly string[];
  }[];
  readonly output: {
    readonly contractVersion: string;
    readonly schema: Readonly<Record<string, JsonValue>>;
  };
  readonly afterRetry: "exhausted-or-not-retryable";
  readonly cancellation: "propagate";
}

export interface GraphCleanupPolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "cleanup";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly handlerDefinitionId: string;
  readonly triggers: readonly ("success" | "failure" | "cancellation")[];
  readonly execution: "once-per-scope-outcome";
  readonly failureMode: "fail-run-preserve-original" | "record-only-preserve-original";
}

export type GraphOriginalOutcomeV1 =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly failure: GraphFailureEnvelopeV1 }
  | { readonly status: "cancelled"; readonly reason: "cancelled" | "deadline_exceeded" | "host_terminated" };

export type GraphCleanupOutcomeV1 =
  | { readonly status: "completed"; readonly completedAt: string }
  | { readonly status: "failed"; readonly failure: GraphFailureEnvelopeV1 };

export interface GraphCleanupRecordV1 {
  readonly schemaVersion: 1;
  readonly policyId: string;
  /** Stable identity of the scope outcome. The store must admit this pair once. */
  readonly scopeOutcomeId: string;
  readonly scopeAddress: GraphInstanceAddressV1;
  readonly original: GraphOriginalOutcomeV1;
  readonly cleanup: GraphCleanupOutcomeV1;
}

export interface GraphRecoveryRecordV1<Output extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly status: "recovered";
  readonly policyId: string;
  readonly originalFailure: GraphFailureEnvelopeV1;
  readonly output: Output;
  readonly recoveredAt: string;
}

export type GraphFailureActionV1 =
  | {
      readonly kind: "retry";
      readonly policyId: string;
      readonly scope: GraphRetryScopeV1;
      readonly scopeAddress: GraphInstanceAddressV1;
      readonly nextAttempt: number;
    }
  | {
      readonly kind: "catch";
      readonly policyId: string;
      readonly handlerDefinitionId: string;
      readonly scopeAddress: GraphInstanceAddressV1;
    }
  | { readonly kind: "propagate" };

export interface GraphApplicableRetryV1 {
  /** Applicable policies are ordered from the closest scope to the outermost scope. */
  readonly policy: GraphRetryPolicyV1;
  readonly scopeAddress: GraphInstanceAddressV1;
  /** Attempt count for that policy's scope, including the current attempt. */
  readonly currentAttempt: number;
}

export interface GraphApplicableCatchV1 {
  /** Applicable policies are ordered from the closest scope to the outermost scope. */
  readonly policy: GraphCatchPolicyV1;
  readonly scopeAddress: GraphInstanceAddressV1;
}

export interface GraphCleanupResolutionV1 {
  readonly runStatus: "succeeded" | "failed" | "cancelled";
  readonly cleanupFailureAffectsRun: boolean;
  readonly original: GraphOriginalOutcomeV1;
  readonly cleanup: GraphCleanupOutcomeV1;
}

type CatchRuntime = { readonly parse: (value: unknown) => JsonValue };
const catches = graphPrivateWeakMap<CatchRuntime>("catch-runtimes");
const policies = graphPrivateWeakSet("failure-policies");

export function validateGraphFailureEnvelopeV1(graph: GraphDefinitionV1, value: unknown): GraphFailureEnvelopeV1 {
  const record = object(value, "Graph failure");
  const keys = ["schemaVersion", "failureId", "class", "code", "message", "retryability", "instance", "occurredAt"];
  assertExactKeys(record, record.class === "external-provider" ? [...keys, "externalDiagnostic"] : keys, "Graph failure");
  if (record.schemaVersion !== 1) throw new Error("Graph failure.schemaVersion must be 1.");
  identifier(record.failureId, "Graph failure ID");
  if (!["workflow", "external-provider", "platform"].includes(record.class as string)) throw new Error("Graph failure class is invalid.");
  identifier(record.code, "Graph failure code");
  if (typeof record.message !== "string" || record.message.length === 0) throw new Error("Graph failure message must be nonempty.");
  if (!["retryable", "not-retryable", "unknown"].includes(record.retryability as string)) throw new Error("Graph failure retryability is invalid.");
  const instance = object(record.instance, "Graph failure instance");
  assertExactKeys(instance, ["address", "attempt"], "Graph failure instance");
  if (!Number.isSafeInteger(instance.attempt) || (instance.attempt as number) <= 0) throw new Error("Graph failure attempt must be positive.");
  canonicalTimestamp(record.occurredAt, "Graph failure occurrence");
  let externalDiagnostic: ExternalErrorDiagnostic | undefined;
  if (record.class === "external-provider") {
    externalDiagnostic = exactExternalDiagnostic(record.externalDiagnostic);
    if (externalDiagnostic.message !== record.message) throw new Error("Graph external failure message differs from its provider diagnostic.");
  }
  return Object.freeze({ schemaVersion: 1, failureId: record.failureId, class: record.class as GraphFailureClassV1,
    code: record.code, message: record.message, retryability: record.retryability as GraphFailureRetryabilityV1,
    instance: Object.freeze({ address: validateGraphInstanceAddressV1(graph, instance.address) as GraphInstanceAddressV1,
      attempt: instance.attempt as number }), occurredAt: record.occurredAt,
    ...(externalDiagnostic ? { externalDiagnostic: Object.freeze(externalDiagnostic) } : {}) });
}

export function defineGraphRetryPolicyV1(value: unknown): GraphRetryPolicyV1 {
  const record = object(value, "Graph retry policy");
  assertExactKeys(record, ["schemaVersion", "kind", "policyId", "policyVersion", "scope", "maxAttempts", "retryOn", "exhaustion"],
    "Graph retry policy");
  if (record.schemaVersion !== 1 || record.kind !== "retry") throw new Error("Graph retry policy identity is invalid.");
  identifier(record.policyId, "Graph retry policy ID"); identifier(record.policyVersion, "Graph retry policy version");
  const scopes: GraphRetryScopeV1[] = ["node-instance", "subgraph-instance", "map-item", "map-instance",
    "reduce-iteration", "reduce-instance", "loop-iteration", "loop-instance"];
  if (!scopes.includes(record.scope as GraphRetryScopeV1)) throw new Error("Graph retry scope is invalid.");
  if (!Number.isSafeInteger(record.maxAttempts) || (record.maxAttempts as number) <= 1) {
    throw new Error("Graph retry maxAttempts must be a safe integer greater than one.");
  }
  const retryOn = failureClasses(record.retryOn, "Graph retry policy");
  if (record.exhaustion !== "propagate-failure") throw new Error("Graph retry exhaustion must propagate the failure.");
  const result = Object.freeze({ schemaVersion: 1 as const, kind: "retry" as const, policyId: record.policyId, policyVersion: record.policyVersion,
    scope: record.scope as GraphRetryScopeV1, maxAttempts: record.maxAttempts as number,
    retryOn, exhaustion: "propagate-failure" });
  policies.add(result);
  return result;
}

export function defineGraphCatchPolicyV1<Output extends JsonValue>(value: {
  readonly schemaVersion: 1;
  readonly kind: "catch";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly handlerDefinitionId: string;
  readonly failures: readonly { readonly class: GraphFailureClassV1; readonly codes?: readonly string[] }[];
  readonly output: GraphValueContractV1<Output>;
  readonly afterRetry: "exhausted-or-not-retryable";
  readonly cancellation: "propagate";
}): GraphCatchPolicyV1<Output> {
  assertExactKeys(value as unknown as Record<string, unknown>, ["schemaVersion", "kind", "policyId", "policyVersion",
    "handlerDefinitionId", "failures", "output", "afterRetry", "cancellation"], "Graph catch policy");
  if (value.schemaVersion !== 1 || value.kind !== "catch") throw new Error("Graph catch policy identity is invalid.");
  identifier(value.policyId, "Graph catch policy ID"); identifier(value.policyVersion, "Graph catch policy version");
  identifier(value.handlerDefinitionId, "Graph catch handler definition ID");
  if (value.afterRetry !== "exhausted-or-not-retryable") throw new Error("Graph catch policy must run after retry handling.");
  if (value.cancellation !== "propagate") throw new Error("Graph catch policy cannot convert cancellation to success.");
  if (typeof value.output?.validator?.parse !== "function") throw new Error("Graph catch policy requires an output validator.");
  identifier(value.output.version, "Graph catch output contract version");
  const outputSchema = object(value.output.schema, "Graph catch output schema");
  const failures = failureMatches(value.failures);
  const result = Object.freeze({ schemaVersion: 1 as const, kind: "catch" as const, policyId: value.policyId,
    policyVersion: value.policyVersion, handlerDefinitionId: value.handlerDefinitionId, failures,
    output: Object.freeze({ contractVersion: value.output.version,
      schema: immutableJson(outputSchema as Record<string, JsonValue>) as Readonly<Record<string, JsonValue>> }),
    afterRetry: "exhausted-or-not-retryable" as const, cancellation: "propagate" as const });
  catches.set(result, { parse: (input) => immutableJson(inputWaitJsonSnapshot(value.output.validator.parse(inputWaitJsonSnapshot(input)))) as JsonValue });
  policies.add(result);
  return result;
}

export function defineGraphCleanupPolicyV1(value: unknown): GraphCleanupPolicyV1 {
  const record = object(value, "Graph cleanup policy");
  assertExactKeys(record, ["schemaVersion", "kind", "policyId", "policyVersion", "handlerDefinitionId",
    "triggers", "execution", "failureMode"], "Graph cleanup policy");
  if (record.schemaVersion !== 1 || record.kind !== "cleanup") throw new Error("Graph cleanup policy identity is invalid.");
  identifier(record.policyId, "Graph cleanup policy ID"); identifier(record.policyVersion, "Graph cleanup policy version");
  identifier(record.handlerDefinitionId, "Graph cleanup handler definition ID");
  if (!Array.isArray(record.triggers) || record.triggers.length === 0
    || record.triggers.some((item) => !["success", "failure", "cancellation"].includes(item as string))
    || new Set(record.triggers).size !== record.triggers.length) throw new Error("Graph cleanup triggers must be unique and nonempty.");
  if (record.execution !== "once-per-scope-outcome") throw new Error("Graph cleanup execution identity is invalid.");
  if (record.failureMode !== "fail-run-preserve-original" && record.failureMode !== "record-only-preserve-original") {
    throw new Error("Graph cleanup failure mode is invalid.");
  }
  const result = Object.freeze({ schemaVersion: 1 as const, kind: "cleanup" as const, policyId: record.policyId,
    policyVersion: record.policyVersion, handlerDefinitionId: record.handlerDefinitionId,
    triggers: Object.freeze([...(record.triggers as GraphCleanupPolicyV1["triggers"])].sort()),
    execution: "once-per-scope-outcome", failureMode: record.failureMode });
  policies.add(result);
  return result;
}

export function assertGraphFailurePolicyDefinedV1(
  value: GraphRetryPolicyV1 | GraphCatchPolicyV1 | GraphCleanupPolicyV1,
): void {
  if (!value || !policies.has(value)) throw new Error("Use graph failure-policy helpers to define policies.");
}

export function validateGraphRecoveryRecordV1<Output extends JsonValue>(graph: GraphDefinitionV1,
  policy: GraphCatchPolicyV1<Output>, value: unknown): GraphRecoveryRecordV1<Output> {
  const runtime = catches.get(policy);
  if (!runtime) throw new Error("Use defineGraphCatchPolicyV1 to define the retained catch policy.");
  const record = object(value, "Graph recovery record");
  assertExactKeys(record, ["schemaVersion", "status", "policyId", "originalFailure", "output", "recoveredAt"], "Graph recovery record");
  if (record.schemaVersion !== 1 || record.status !== "recovered" || record.policyId !== policy.policyId) {
    throw new Error("Graph recovery record differs from its catch policy.");
  }
  canonicalTimestamp(record.recoveredAt, "Graph recovery");
  const failure = validateGraphFailureEnvelopeV1(graph, record.originalFailure);
  if (!matchesFailure(policy.failures, failure)) throw new Error("Graph catch policy does not match the original failure.");
  return Object.freeze({ schemaVersion: 1, status: "recovered", policyId: policy.policyId,
    originalFailure: failure, output: runtime.parse(record.output) as Output, recoveredAt: record.recoveredAt });
}

export function validateGraphCleanupRecordV1(graph: GraphDefinitionV1, policy: GraphCleanupPolicyV1,
  value: unknown): GraphCleanupRecordV1 {
  const record = object(value, "Graph cleanup record");
  assertExactKeys(record, ["schemaVersion", "policyId", "scopeOutcomeId", "scopeAddress", "original", "cleanup"], "Graph cleanup record");
  if (record.schemaVersion !== 1 || record.policyId !== policy.policyId) throw new Error("Graph cleanup record differs from its policy.");
  identifier(record.scopeOutcomeId, "Graph cleanup scope outcome ID");
  const scopeAddress = validateGraphInstanceAddressV1(graph, record.scopeAddress) as GraphInstanceAddressV1;
  const original = originalOutcome(graph, record.original);
  let trigger: "success" | "failure" | "cancellation";
  if (original.status === "succeeded") trigger = "success";
  else if (original.status === "failed") trigger = "failure";
  else trigger = "cancellation";
  if (!policy.triggers.includes(trigger)) throw new Error("Graph cleanup policy does not cover the original outcome.");
  const cleanupRecord = object(record.cleanup, "Graph cleanup outcome");
  let cleanup: GraphCleanupOutcomeV1;
  if (cleanupRecord.status === "completed") {
    assertExactKeys(cleanupRecord, ["status", "completedAt"], "Graph cleanup outcome");
    canonicalTimestamp(cleanupRecord.completedAt, "Graph cleanup completion");
    cleanup = Object.freeze({ status: "completed", completedAt: cleanupRecord.completedAt });
  } else if (cleanupRecord.status === "failed") {
    assertExactKeys(cleanupRecord, ["status", "failure"], "Graph cleanup outcome");
    cleanup = Object.freeze({ status: "failed", failure: validateGraphFailureEnvelopeV1(graph, cleanupRecord.failure) });
  } else throw new Error("Graph cleanup outcome status is invalid.");
  return Object.freeze({ schemaVersion: 1, policyId: policy.policyId, scopeOutcomeId: record.scopeOutcomeId,
    scopeAddress, original, cleanup });
}

/**
 * Deterministic policy precedence. Callers pass only policies applicable to the
 * failed instance, ordered from its closest scope to the outermost scope.
 */
export function selectGraphFailureActionV1(graph: GraphDefinitionV1, failure: GraphFailureEnvelopeV1,
  retries: readonly GraphApplicableRetryV1[],
  catchesInScopeOrder: readonly GraphApplicableCatchV1[]): GraphFailureActionV1 {
  const retainedFailure = validateGraphFailureEnvelopeV1(graph, failure);
  const retryIds = new Set<string>();
  for (const candidate of retries) {
    if (retryIds.has(candidate.policy.policyId)) throw new Error("Applicable graph retry policy IDs must be unique.");
    retryIds.add(candidate.policy.policyId);
    if (!Number.isSafeInteger(candidate.currentAttempt) || candidate.currentAttempt <= 0) {
      throw new Error("Applicable graph retry attempt must be a positive safe integer.");
    }
    const scopeAddress = validatePolicyScope(graph, retainedFailure, candidate.scopeAddress, candidate.policy.scope);
    if (retainedFailure.retryability === "retryable" && candidate.policy.retryOn.includes(retainedFailure.class)
      && candidate.currentAttempt < candidate.policy.maxAttempts) {
      return Object.freeze({ kind: "retry", policyId: candidate.policy.policyId,
        scope: candidate.policy.scope, scopeAddress,
        nextAttempt: candidate.currentAttempt + 1 });
    }
  }
  const catchIds = new Set<string>();
  for (const candidate of catchesInScopeOrder) {
    const policy = candidate.policy;
    if (catchIds.has(policy.policyId)) throw new Error("Applicable graph catch policy IDs must be unique.");
    catchIds.add(policy.policyId);
    const scopeAddress = validatePolicyScope(graph, retainedFailure, candidate.scopeAddress);
    if (matchesFailure(policy.failures, retainedFailure)) {
      return Object.freeze({ kind: "catch", policyId: policy.policyId,
        handlerDefinitionId: policy.handlerDefinitionId, scopeAddress });
    }
  }
  return Object.freeze({ kind: "propagate" });
}

/** Resolve the Run status without discarding either the original or cleanup outcome. */
export function resolveGraphCleanupOutcomeV1(policy: GraphCleanupPolicyV1,
  record: GraphCleanupRecordV1): GraphCleanupResolutionV1 {
  if (record.policyId !== policy.policyId) throw new Error("Graph cleanup record differs from its policy.");
  const cleanupFailureAffectsRun = record.cleanup.status === "failed" && policy.failureMode === "fail-run-preserve-original";
  let runStatus: GraphCleanupResolutionV1["runStatus"];
  if (cleanupFailureAffectsRun || record.original.status === "failed") runStatus = "failed";
  else if (record.original.status === "succeeded") runStatus = "succeeded";
  else runStatus = "cancelled";
  return Object.freeze({ runStatus, cleanupFailureAffectsRun, original: record.original, cleanup: record.cleanup });
}

export function graphPolicyCapabilitiesV1(value: GraphRetryPolicyV1 | GraphCatchPolicyV1 | GraphCleanupPolicyV1): readonly string[] {
  if (value.kind === "retry") return Object.freeze(["graph.failure-envelope@1", `graph.retry.${value.scope}@1`]);
  if (value.kind === "catch") return Object.freeze(["graph.failure-envelope@1", "graph.catch.after-retry@1",
    "graph.catch.recovery-output@1"]);
  return Object.freeze(["graph.failure-envelope@1", "graph.cleanup.once-per-scope-outcome@1",
    "graph.cleanup.outcome-trigger@1"]);
}

export function assertGraphPolicyCapabilitiesV1(value: GraphRetryPolicyV1 | GraphCatchPolicyV1 | GraphCleanupPolicyV1,
  supported: readonly string[]): void {
  const missing = graphPolicyCapabilitiesV1(value).filter((capability) => !supported.includes(capability));
  if (missing.length) throw new Error(`Unsupported graph policy capabilities: ${missing.join(", ")}.`);
}

function originalOutcome(graph: GraphDefinitionV1, value: unknown): GraphOriginalOutcomeV1 {
  const record = object(value, "Graph original outcome");
  if (record.status === "succeeded") {
    assertExactKeys(record, ["status"], "Graph original outcome"); return Object.freeze({ status: "succeeded" });
  }
  if (record.status === "failed") {
    assertExactKeys(record, ["status", "failure"], "Graph original outcome");
    return Object.freeze({ status: "failed", failure: validateGraphFailureEnvelopeV1(graph, record.failure) });
  }
  if (record.status === "cancelled") {
    assertExactKeys(record, ["status", "reason"], "Graph original outcome");
    if (!["cancelled", "deadline_exceeded", "host_terminated"].includes(record.reason as string)) throw new Error("Graph cancellation reason is invalid.");
    return Object.freeze({ status: "cancelled", reason: record.reason as "cancelled" | "deadline_exceeded" | "host_terminated" });
  }
  throw new Error("Graph original outcome status is invalid.");
}

function failureClasses(value: unknown, location: string): readonly GraphFailureClassV1[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => !["workflow", "external-provider", "platform"].includes(item as string))
    || new Set(value).size !== value.length) throw new Error(`${location} failure classes must be unique and nonempty.`);
  return Object.freeze([...(value as GraphFailureClassV1[])].sort());
}

function failureMatches(value: unknown): readonly { readonly class: GraphFailureClassV1; readonly codes?: readonly string[] }[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Graph catch policy failures must be nonempty.");
  const seen = new Set<string>();
  const result = value.map((item) => {
    const record = object(item, "Graph catch failure match");
    assertExactKeys(record, record.codes === undefined ? ["class"] : ["class", "codes"], "Graph catch failure match");
    if (!["workflow", "external-provider", "platform"].includes(record.class as string) || seen.has(record.class as string)) {
      throw new Error("Graph catch failure classes must be valid and unique.");
    }
    seen.add(record.class as string);
    if (record.codes === undefined) return Object.freeze({ class: record.class as GraphFailureClassV1 });
    if (!Array.isArray(record.codes) || record.codes.length === 0 || new Set(record.codes).size !== record.codes.length) {
      throw new Error("Graph catch failure codes must be unique and nonempty.");
    }
    for (const code of record.codes) identifier(code, "Graph catch failure code");
    return Object.freeze({ class: record.class as GraphFailureClassV1,
      codes: Object.freeze([...(record.codes as string[])].sort()) });
  });
  return Object.freeze(result.sort((left, right) => left.class.localeCompare(right.class)));
}

function matchesFailure(matches: GraphCatchPolicyV1["failures"], failure: GraphFailureEnvelopeV1): boolean {
  const match = matches.find((item) => item.class === failure.class);
  return !!match && (!match.codes || match.codes.includes(failure.code));
}

function validatePolicyScope(graph: GraphDefinitionV1, failure: GraphFailureEnvelopeV1,
  value: GraphInstanceAddressV1, retryScope?: GraphRetryScopeV1): GraphInstanceAddressV1 {
  const scope = validateGraphInstanceAddressV1(graph, value) as GraphInstanceAddressV1;
  if (!addressEncloses(scope, failure.instance.address)) {
    throw new Error("Graph failure policy scope does not enclose the failed instance.");
  }
  const node = graphInstanceNodeV1(graph, scope);
  let requiredKind: "subgraph" | "map" | "reduce" | "loop" | undefined;
  if (retryScope === "subgraph-instance") requiredKind = "subgraph";
  else if (retryScope === "map-item" || retryScope === "map-instance") requiredKind = "map";
  else if (retryScope === "reduce-iteration" || retryScope === "reduce-instance") requiredKind = "reduce";
  else if (retryScope === "loop-iteration" || retryScope === "loop-instance") requiredKind = "loop";
  if (requiredKind && node.kind !== requiredKind) {
    throw new Error(`Graph retry scope ${retryScope} requires a ${requiredKind} placement.`);
  }
  const occurrence = scope.path.at(-1)?.occurrence;
  if ((retryScope === "map-item" && occurrence?.kind !== "map")
    || (retryScope === "reduce-iteration" && occurrence?.kind !== "reduce")
    || (retryScope === "loop-iteration" && occurrence?.kind !== "loop")) {
    throw new Error(`Graph retry scope ${retryScope} requires an exact repeated occurrence.`);
  }
  if ((retryScope === "map-instance" || retryScope === "reduce-instance" || retryScope === "loop-instance"
    || retryScope === "subgraph-instance") && occurrence !== undefined) {
    throw new Error(`Graph retry scope ${retryScope} requires the whole control instance.`);
  }
  if (retryScope === "node-instance" && JSON.stringify(scope) !== JSON.stringify(failure.instance.address)) {
    throw new Error("A node-instance retry must target the failed instance.");
  }
  return scope;
}

function addressEncloses(scope: GraphInstanceAddressV1, target: GraphInstanceAddressV1): boolean {
  if (scope.path.length > target.path.length) return false;
  return scope.path.every((segment, index) => {
    const targetSegment = target.path[index];
    if (!targetSegment || segment.nodeId !== targetSegment.nodeId) return false;
    if (segment.occurrence !== undefined
      && JSON.stringify(segment.occurrence) !== JSON.stringify(targetSegment.occurrence)) return false;
    return index === scope.path.length - 1 || segment.occurrence !== undefined;
  });
}

function exactExternalDiagnostic(value: unknown): ExternalErrorDiagnostic {
  const record = object(value, "Graph external diagnostic");
  const keys = ["origin", "provider", "message", ...(record.code === undefined ? [] : ["code"]),
    ...(record.httpStatus === undefined ? [] : ["httpStatus"])];
  assertExactKeys(record, keys, "Graph external diagnostic");
  const diagnostic = readExternalErrorDiagnostic(record);
  if (!diagnostic) throw new Error("Graph external diagnostic is invalid.");
  return diagnostic;
}

function object(value: unknown, location: string): Record<string, unknown> {
  const snapshot = inputWaitJsonSnapshot(value);
  if (!isRecord(snapshot)) throw new Error(`${location} must be an object.`);
  return snapshot;
}

function identifier(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${location} must be a string.`);
  assertDurableIdentifier(value, location);
}
