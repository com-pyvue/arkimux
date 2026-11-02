import { validateRunConfigurationReference } from "../domain/runConfigurationReference.ts";
import { validateRunRef } from "../domain/runIdentity.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";
import { validateWorkflowIdentity } from "../domain/workflowIdentity.ts";
import { assertDurableIdentifier, hashJson, immutableJson, type JsonValue } from "./durableWorkflow.ts";
import {
  projectGraphInvocationReadV1,
  validateGraphAcceptedBoundaryV1,
  validateGraphEntryRequestStateV1,
  validateGraphRunInvocationV1,
  type GraphAcceptedBoundaryV1,
  type GraphEntryRequestStateV1,
  type GraphRunInvocationV1,
} from "./graphInvocationRecords.ts";
import type { GraphWorkflowV1 } from "./graphWorkflow.ts";
import { inputWaitJsonSnapshot, parseInputWaitDurationV1 } from "./inputWait.ts";
import { canonicalTimestamp } from "./recordValidation.ts";

const digest = /^[a-f0-9]{64}$/;
const maximumRequestMs = 366 * 24 * 60 * 60 * 1000;

export interface RetainedGraphInputV1 {
  readonly schemaVersion: 1;
  readonly invocation: GraphRunInvocationV1;
  readonly requestState?: GraphEntryRequestStateV1;
  readonly accepted?: GraphAcceptedBoundaryV1;
}

/** Storage-level validation does not execute project validators. The retained
 * graph is required later to restore the plan and accepted values exactly. */
export function validateRetainedGraphInputV1(value: unknown): RetainedGraphInputV1 {
  const record = snapshotRecord(value, "Retained graph input");
  assertExactKeys(record, ["schemaVersion", "invocation"], "Retained graph input",
    ["schemaVersion", "invocation", "requestState", "accepted"]);
  if (record.schemaVersion !== 1) throw new Error("Retained graph input.schemaVersion must be 1.");
  const invocation = invocationRecord(record.invocation);
  const requestState = record.requestState === undefined ? undefined : requestStateRecord(record.requestState);
  const accepted = record.accepted === undefined ? undefined : acceptedRecord(record.accepted);

  if (invocation.acquisition === "supplied") {
    if (requestState || !accepted || accepted.source !== "supplied-invocation" || accepted.acceptedAt !== invocation.createdAt) {
      throw new Error("Supplied retained graph input requires its accepted boundary and no request.");
    }
  } else {
    if (!requestState || (requestState.status === "submitted") !== !!accepted
      || (accepted && accepted.source !== "deferred-submission")) {
      throw new Error("Deferred retained graph input state is inconsistent.");
    }
  }
  const plan = snapshotRecord(invocation.entryPlan, "Retained graph entry plan");
  sha256(plan.planSha256, "Retained graph entry plan digest");
  if (requestState) {
    const request = requestState.request;
    if (request.runRef.executionId !== invocation.runRef.executionId
      || request.executableBindingId !== invocation.executableBindingId
      || request.planSha256 !== plan.planSha256 || request.createdAt !== invocation.createdAt) {
      throw new Error("Retained graph request differs from its invocation.");
    }
  }
  if (accepted) {
    if (accepted.runRef.executionId !== invocation.runRef.executionId || accepted.planSha256 !== plan.planSha256
      || accepted.acceptedBodySha256 !== hashJson(accepted.boundary as unknown as JsonValue)
      || (accepted.source === "deferred-submission" && (accepted.requestId !== requestState?.request.requestId
        || accepted.acceptedAt !== requestState.updatedAt))) {
      throw new Error("Retained accepted graph boundary differs from its invocation or request.");
    }
  }
  return immutableJson({ schemaVersion: 1, invocation,
    ...(requestState ? { requestState } : {}), ...(accepted ? { accepted } : {}) } as unknown as JsonValue) as unknown as RetainedGraphInputV1;
}

/** Rebinds persisted records to validators reconstructed from the retained build. */
export function restoreRetainedGraphInputV1(graph: GraphWorkflowV1, value: unknown): RetainedGraphInputV1 {
  const stored = validateRetainedGraphInputV1(value);
  const invocation = validateGraphRunInvocationV1(graph, stored.invocation);
  const requestState = stored.requestState && validateGraphEntryRequestStateV1(graph, invocation, stored.requestState);
  const accepted = stored.accepted && validateGraphAcceptedBoundaryV1(graph, invocation, requestState?.request, stored.accepted);
  projectGraphInvocationReadV1({ graph, invocation, ...(requestState ? { requestState } : {}), ...(accepted ? { accepted } : {}) });
  return Object.freeze({ schemaVersion: 1, invocation, ...(requestState ? { requestState } : {}), ...(accepted ? { accepted } : {}) });
}

function invocationRecord(value: unknown): GraphRunInvocationV1 {
  const record = snapshotRecord(value, "Retained graph invocation");
  const required = ["schemaVersion", "runRef", "workflow", "workflowContractVersion", "resultKind", "runConfiguration",
    "executableBindingId", "buildSha256", "graphDeclarationSha256", "acquisition", "entryPlan", "createdAt"];
  assertExactKeys(record, record.acquisition === "deferred" ? [...required, "wait"] : required, "Retained graph invocation");
  if (record.schemaVersion !== 1) throw new Error("Retained graph invocation.schemaVersion must be 1.");
  const runRef = validateRunRef(record.runRef), workflow = validateWorkflowIdentity(record.workflow);
  identifier(record.workflowContractVersion, "Retained graph workflow contract version");
  identifier(record.resultKind, "Retained graph result kind");
  identifier(record.executableBindingId, "Retained graph executable binding ID");
  sha256(record.buildSha256, "Retained graph build digest");
  sha256(record.graphDeclarationSha256, "Retained graph declaration digest");
  if (record.acquisition !== "supplied" && record.acquisition !== "deferred") throw new Error("Retained graph acquisition is invalid.");
  if (record.acquisition === "deferred") {
    const wait = snapshotRecord(record.wait, "Retained graph invocation wait");
    assertExactKeys(wait, ["duration"], "Retained graph invocation wait");
    parseInputWaitDurationV1(wait.duration);
  }
  canonicalTimestamp(record.createdAt, "Retained graph invocation creation");
  const entryPlan = inputWaitJsonSnapshot(record.entryPlan);
  return { schemaVersion: 1, runRef, workflow, workflowContractVersion: record.workflowContractVersion,
    resultKind: record.resultKind, runConfiguration: validateRunConfigurationReference(record.runConfiguration),
    executableBindingId: record.executableBindingId, buildSha256: record.buildSha256,
    graphDeclarationSha256: record.graphDeclarationSha256, acquisition: record.acquisition,
    ...(record.acquisition === "deferred" ? { wait: inputWaitJsonSnapshot(record.wait) } : {}),
    entryPlan, createdAt: record.createdAt } as unknown as GraphRunInvocationV1;
}

function requestStateRecord(value: unknown): GraphEntryRequestStateV1 {
  const state = snapshotRecord(value, "Retained graph request state");
  assertExactKeys(state, ["schemaVersion", "request", "revision", "status", "updatedAt"], "Retained graph request state");
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || (state.revision as number) < 1
    || !["pending", "submitted", "cancelled", "expired"].includes(state.status as string)) {
    throw new Error("Retained graph request state is invalid.");
  }
  const request = snapshotRecord(state.request, "Retained graph request");
  assertExactKeys(request, ["schemaVersion", "requestId", "runRef", "executableBindingId", "planSha256", "createdAt", "expiresAt"], "Retained graph request");
  if (request.schemaVersion !== 1) throw new Error("Retained graph request.schemaVersion must be 1.");
  identifier(request.requestId, "Retained graph request ID"); identifier(request.executableBindingId, "Retained graph request binding ID");
  sha256(request.planSha256, "Retained graph request plan digest");
  canonicalTimestamp(request.createdAt, "Retained graph request creation"); canonicalTimestamp(request.expiresAt, "Retained graph request expiry");
  canonicalTimestamp(state.updatedAt, "Retained graph request update");
  const duration = Date.parse(request.expiresAt) - Date.parse(request.createdAt);
  const updated = Date.parse(state.updatedAt), expires = Date.parse(request.expiresAt);
  if (duration <= 0 || duration > maximumRequestMs || updated < Date.parse(request.createdAt)
    || (state.status === "submitted" && updated >= expires) || (state.status === "expired" && updated < expires)) {
    throw new Error("Retained graph request timing is invalid.");
  }
  return { schemaVersion: 1, request: { schemaVersion: 1, requestId: request.requestId,
    runRef: validateRunRef(request.runRef), executableBindingId: request.executableBindingId,
    planSha256: request.planSha256, createdAt: request.createdAt, expiresAt: request.expiresAt },
  revision: state.revision as number, status: state.status as GraphEntryRequestStateV1["status"], updatedAt: state.updatedAt };
}

function acceptedRecord(value: unknown): GraphAcceptedBoundaryV1 {
  const record = snapshotRecord(value, "Retained accepted graph boundary");
  const common = ["schemaVersion", "acceptanceId", "runRef", "planSha256", "boundary", "acceptedBodySha256", "acceptedAt", "source"];
  assertExactKeys(record, record.source === "deferred-submission" ? [...common, "requestId"] : common, "Retained accepted graph boundary");
  if (record.schemaVersion !== 1 || (record.source !== "supplied-invocation" && record.source !== "deferred-submission")) {
    throw new Error("Retained accepted graph boundary is invalid.");
  }
  identifier(record.acceptanceId, "Retained graph acceptance ID"); sha256(record.planSha256, "Retained accepted graph plan digest");
  sha256(record.acceptedBodySha256, "Retained accepted graph body digest"); canonicalTimestamp(record.acceptedAt, "Retained graph acceptance");
  if (record.source === "deferred-submission") identifier(record.requestId, "Retained graph accepted request ID");
  return { schemaVersion: 1, acceptanceId: record.acceptanceId, runRef: validateRunRef(record.runRef),
    planSha256: record.planSha256, boundary: inputWaitJsonSnapshot(record.boundary) as unknown as GraphAcceptedBoundaryV1["boundary"],
    acceptedBodySha256: record.acceptedBodySha256, acceptedAt: record.acceptedAt, source: record.source,
    ...(record.source === "deferred-submission" ? { requestId: record.requestId as string } : {}) } as GraphAcceptedBoundaryV1;
}

function snapshotRecord(value: unknown, location: string): Record<string, unknown> {
  const snapshot = inputWaitJsonSnapshot(value);
  if (!isRecord(snapshot)) throw new Error(`${location} must be an object.`);
  return snapshot;
}
function identifier(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${location} must be a string.`);
  assertDurableIdentifier(value, location);
}
function sha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !digest.test(value)) throw new Error(`${location} must be a lowercase SHA-256 digest.`);
}
