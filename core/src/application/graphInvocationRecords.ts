import type { RunConfigurationReference } from "../domain/runConfigurationReference.ts";
import { validateRunConfigurationReference } from "../domain/runConfigurationReference.ts";
import type { RunRef } from "../domain/runIdentity.ts";
import { validateRunRef } from "../domain/runIdentity.ts";
import type { WorkflowIdentity } from "../domain/workflowIdentity.ts";
import { validateWorkflowIdentity } from "../domain/workflowIdentity.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";
import { canonicalTimestamp } from "./recordValidation.ts";
import { assertDurableIdentifier, hashJson, immutableJson, type JsonValue } from "./durableWorkflow.ts";
import { inputWaitJsonSnapshot, parseInputWaitDurationV1, type InputWaitDurationV1 } from "./inputWait.ts";
import type {
  GraphBoundaryRequirementV1,
  GraphEntryBoundaryV1,
  GraphEntryPlanV1,
  GraphInvocationAdmissionV1,
} from "./graphInvocation.ts";
import { restoreGraphEntryPlanV1, validateGraphEntryBoundaryV1 } from "./graphInvocation.ts";
import type { GraphWorkflowV1 } from "./graphWorkflow.ts";

const maximumRequestMs = 366 * 24 * 60 * 60 * 1000;
const digest = /^[a-f0-9]{64}$/;

export interface GraphRunInvocationV1 {
  readonly schemaVersion: 1;
  readonly runRef: RunRef;
  readonly workflow: WorkflowIdentity;
  readonly workflowContractVersion: string;
  readonly resultKind: string;
  readonly runConfiguration: RunConfigurationReference;
  readonly executableBindingId: string;
  readonly buildSha256: string;
  readonly graphDeclarationSha256: string;
  readonly acquisition: "supplied" | "deferred";
  readonly wait?: { readonly duration: InputWaitDurationV1 };
  readonly entryPlan: GraphEntryPlanV1;
  readonly createdAt: string;
}

/** Fixed request definition. Mutable status is kept in GraphEntryRequestStateV1. */
export interface GraphEntryRequestV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly runRef: RunRef;
  readonly executableBindingId: string;
  readonly planSha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface GraphEntryRequestStateV1 {
  readonly schemaVersion: 1;
  readonly request: GraphEntryRequestV1;
  readonly revision: number;
  readonly status: "pending" | "submitted" | "cancelled" | "expired";
  readonly updatedAt: string;
}

export type GraphAcceptedBoundaryV1 = {
  readonly schemaVersion: 1;
  readonly acceptanceId: string;
  readonly runRef: RunRef;
  readonly planSha256: string;
  readonly boundary: GraphEntryBoundaryV1;
  readonly acceptedBodySha256: string;
  readonly acceptedAt: string;
} & (
  | { readonly source: "supplied-invocation" }
  | { readonly source: "deferred-submission"; readonly requestId: string }
);

export type GraphInvocationInputReadV1 =
  | { readonly status: "waiting_for_input"; readonly requestId: string; readonly createdAt: string; readonly expiresAt: string }
  | { readonly status: "input_accepted"; readonly source: "supplied-invocation" | "deferred-submission";
      readonly acceptanceId: string; readonly requestId?: string; readonly acceptedAt: string }
  | { readonly status: "cancelled" | "expired"; readonly requestId: string; readonly updatedAt: string };

/** Public-safe entry projection. Accepted values remain in the private immutable boundary record. */
export interface GraphInvocationReadV1 {
  readonly schemaVersion: 1;
  readonly runRef: RunRef;
  readonly workflow: WorkflowIdentity;
  readonly acquisition: "supplied" | "deferred";
  readonly entry: GraphEntryPlanV1["entry"];
  readonly planSha256: string;
  readonly requirements: readonly GraphBoundaryRequirementV1[];
  readonly createdAt: string;
  readonly input: GraphInvocationInputReadV1;
}

export function createGraphRunInvocationV1(options: {
  readonly graph: GraphWorkflowV1;
  readonly admission: GraphInvocationAdmissionV1;
  readonly runRef: RunRef;
  readonly runConfiguration: RunConfigurationReference;
  readonly executableBindingId: string;
  readonly buildSha256: string;
  readonly createdAt: string;
}): GraphRunInvocationV1 {
  const invocation = validateGraphRunInvocationV1(options.graph, {
    schemaVersion: 1,
    runRef: options.runRef,
    workflow: options.graph.workflow,
    workflowContractVersion: options.graph.workflowContractVersion,
    resultKind: options.graph.resultKind,
    runConfiguration: options.runConfiguration,
    executableBindingId: options.executableBindingId,
    buildSha256: options.buildSha256,
    graphDeclarationSha256: options.graph.declarationSha256,
    acquisition: options.admission.acquisition,
    ...(options.admission.acquisition === "deferred" ? { wait: options.admission.wait } : {}),
    entryPlan: options.admission.plan,
    createdAt: options.createdAt,
  });
  if (options.admission.acquisition === "supplied") {
    validateGraphEntryBoundaryV1(invocation.entryPlan, options.admission.boundary);
  }
  return invocation;
}

export function validateGraphRunInvocationV1(graph: GraphWorkflowV1, value: unknown): GraphRunInvocationV1 {
  const record = snapshotRecord(value, "Graph Run invocation");
  const required = ["schemaVersion", "runRef", "workflow", "workflowContractVersion", "resultKind",
    "runConfiguration", "executableBindingId", "buildSha256", "graphDeclarationSha256", "acquisition", "entryPlan", "createdAt"];
  assertExactKeys(record, record.acquisition === "deferred" ? [...required, "wait"] : required, "Graph Run invocation");
  if (record.schemaVersion !== 1) throw new Error("Graph Run invocation.schemaVersion must be 1.");
  const workflow = validateWorkflowIdentity(record.workflow);
  if (workflow.kind !== graph.workflow.kind || workflow.version !== graph.workflow.version) {
    throw new Error("Graph Run invocation workflow differs from the retained graph.");
  }
  if (record.workflowContractVersion !== graph.workflowContractVersion || record.resultKind !== graph.resultKind) {
    throw new Error("Graph Run invocation contract differs from the retained graph.");
  }
  if (record.graphDeclarationSha256 !== graph.declarationSha256) {
    throw new Error("Graph Run invocation declaration differs from the retained graph.");
  }
  identifier(record.executableBindingId, "Graph Run executable binding ID");
  sha256(record.buildSha256, "Graph Run build digest");
  sha256(record.graphDeclarationSha256, "Graph declaration digest");
  if (record.acquisition !== "supplied" && record.acquisition !== "deferred") {
    throw new Error("Graph Run invocation acquisition must be supplied or deferred.");
  }
  let wait: GraphRunInvocationV1["wait"];
  if (record.acquisition === "deferred") {
    if (!isRecord(record.wait)) throw new Error("Deferred Graph Run invocation needs wait settings.");
    assertExactKeys(record.wait, ["duration"], "Graph Run invocation wait");
    parseInputWaitDurationV1(record.wait.duration);
    wait = Object.freeze({ duration: record.wait.duration as InputWaitDurationV1 });
  }
  canonicalTimestamp(record.createdAt, "Graph Run invocation creation");
  const entryPlan = restoreGraphEntryPlanV1(graph, record.entryPlan);
  return Object.freeze({
    schemaVersion: 1,
    runRef: Object.freeze(validateRunRef(record.runRef)),
    workflow: Object.freeze(workflow),
    workflowContractVersion: graph.workflowContractVersion,
    resultKind: graph.resultKind,
    runConfiguration: Object.freeze(validateRunConfigurationReference(record.runConfiguration)),
    executableBindingId: record.executableBindingId,
    buildSha256: record.buildSha256,
    graphDeclarationSha256: record.graphDeclarationSha256,
    acquisition: record.acquisition,
    ...(wait ? { wait } : {}),
    entryPlan,
    createdAt: record.createdAt,
  });
}

export function createGraphEntryRequestV1(graph: GraphWorkflowV1, invocationValue: GraphRunInvocationV1, options: {
  readonly requestId: string;
}): GraphEntryRequestV1 {
  const invocation = validateGraphRunInvocationV1(graph, invocationValue);
  if (invocation.acquisition !== "deferred") throw new Error("Only a deferred graph invocation can create an input request.");
  return validateGraphEntryRequestV1(graph, invocation, {
    schemaVersion: 1,
    requestId: options.requestId,
    runRef: invocation.runRef,
    executableBindingId: invocation.executableBindingId,
    planSha256: invocation.entryPlan.planSha256,
    createdAt: invocation.createdAt,
    expiresAt: new Date(Date.parse(invocation.createdAt) + parseInputWaitDurationV1(invocation.wait?.duration)).toISOString(),
  });
}

export function validateGraphEntryRequestV1(graph: GraphWorkflowV1, invocationValue: GraphRunInvocationV1,
  value: unknown): GraphEntryRequestV1 {
  const invocation = validateGraphRunInvocationV1(graph, invocationValue);
  if (invocation.acquisition !== "deferred") throw new Error("A supplied graph invocation cannot retain an input request.");
  const record = snapshotRecord(value, "Graph entry request");
  assertExactKeys(record, ["schemaVersion", "requestId", "runRef", "executableBindingId", "planSha256", "createdAt", "expiresAt"],
    "Graph entry request");
  if (record.schemaVersion !== 1) throw new Error("Graph entry request.schemaVersion must be 1.");
  identifier(record.requestId, "Graph entry request ID");
  identifier(record.executableBindingId, "Graph entry request executable binding ID");
  sha256(record.planSha256, "Graph entry request plan digest");
  canonicalTimestamp(record.createdAt, "Graph entry request creation");
  canonicalTimestamp(record.expiresAt, "Graph entry request expiry");
  const runRef = validateRunRef(record.runRef);
  if (runRef.executionId !== invocation.runRef.executionId
    || record.executableBindingId !== invocation.executableBindingId
    || record.planSha256 !== invocation.entryPlan.planSha256
    || record.createdAt !== invocation.createdAt) {
    throw new Error("Graph entry request differs from its immutable invocation.");
  }
  const duration = Date.parse(record.expiresAt) - Date.parse(record.createdAt);
  if (duration <= 0 || duration > maximumRequestMs) {
    throw new Error("Graph entry request expiry must be positive and at most 366 days after creation.");
  }
  return Object.freeze({ schemaVersion: 1, requestId: record.requestId,
    runRef: Object.freeze(runRef), executableBindingId: record.executableBindingId,
    planSha256: record.planSha256, createdAt: record.createdAt, expiresAt: record.expiresAt });
}

export function validateGraphEntryRequestStateV1(graph: GraphWorkflowV1, invocationValue: GraphRunInvocationV1,
  value: unknown): GraphEntryRequestStateV1 {
  const invocation = validateGraphRunInvocationV1(graph, invocationValue);
  const record = snapshotRecord(value, "Graph entry request state");
  assertExactKeys(record, ["schemaVersion", "request", "revision", "status", "updatedAt"], "Graph entry request state");
  if (record.schemaVersion !== 1) throw new Error("Graph entry request state.schemaVersion must be 1.");
  const request = validateGraphEntryRequestV1(graph, invocation, record.request);
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) <= 0) {
    throw new Error("Graph entry request revision must be a positive safe integer.");
  }
  if (!["pending", "submitted", "cancelled", "expired"].includes(record.status as string)) {
    throw new Error("Graph entry request status is invalid.");
  }
  canonicalTimestamp(record.updatedAt, "Graph entry request update");
  const updated = Date.parse(record.updatedAt), created = Date.parse(request.createdAt), expires = Date.parse(request.expiresAt);
  if (updated < created || (record.status === "submitted" && updated >= expires)
    || (record.status === "expired" && updated < expires)) {
    throw new Error("Graph entry request transition time is invalid.");
  }
  return Object.freeze({ schemaVersion: 1, request, revision: record.revision as number,
    status: record.status as GraphEntryRequestStateV1["status"], updatedAt: record.updatedAt });
}

export function createGraphAcceptedBoundaryV1(options: {
  readonly graph: GraphWorkflowV1;
  readonly invocation: GraphRunInvocationV1;
  readonly boundary: GraphEntryBoundaryV1;
  readonly acceptanceId: string;
  readonly acceptedAt: string;
  readonly request?: GraphEntryRequestV1;
}): GraphAcceptedBoundaryV1 {
  const invocation = validateGraphRunInvocationV1(options.graph, options.invocation);
  const boundary = validateGraphEntryBoundaryV1(invocation.entryPlan, options.boundary);
  const source = invocation.acquisition === "supplied" ? "supplied-invocation" : "deferred-submission";
  if (source === "deferred-submission" && !options.request) {
    throw new Error("Deferred graph input requires its fixed request.");
  }
  return validateGraphAcceptedBoundaryV1(options.graph, invocation, options.request, {
    schemaVersion: 1,
    acceptanceId: options.acceptanceId,
    runRef: invocation.runRef,
    planSha256: invocation.entryPlan.planSha256,
    boundary,
    acceptedBodySha256: hashJson(boundary as unknown as JsonValue),
    acceptedAt: options.acceptedAt,
    source,
    ...(source === "deferred-submission" ? { requestId: options.request?.requestId } : {}),
  });
}

export function validateGraphAcceptedBoundaryV1(graph: GraphWorkflowV1, invocationValue: GraphRunInvocationV1,
  requestValue: GraphEntryRequestV1 | undefined, value: unknown): GraphAcceptedBoundaryV1 {
  const invocation = validateGraphRunInvocationV1(graph, invocationValue);
  const record = snapshotRecord(value, "Accepted graph entry boundary");
  if (record.source === "supplied-invocation") {
    assertExactKeys(record, ["schemaVersion", "acceptanceId", "runRef", "planSha256", "boundary", "acceptedBodySha256", "acceptedAt", "source"],
      "Accepted graph entry boundary");
  } else if (record.source === "deferred-submission") {
    assertExactKeys(record, ["schemaVersion", "acceptanceId", "runRef", "planSha256", "boundary", "acceptedBodySha256", "acceptedAt", "source", "requestId"],
      "Accepted graph entry boundary");
  } else throw new Error("Accepted graph entry boundary source is invalid.");
  if (record.schemaVersion !== 1) throw new Error("Accepted graph entry boundary.schemaVersion must be 1.");
  identifier(record.acceptanceId, "Graph entry acceptance ID");
  sha256(record.planSha256, "Accepted graph entry plan digest");
  sha256(record.acceptedBodySha256, "Accepted graph entry body digest");
  canonicalTimestamp(record.acceptedAt, "Graph entry acceptance");
  const runRef = validateRunRef(record.runRef);
  if (runRef.executionId !== invocation.runRef.executionId || record.planSha256 !== invocation.entryPlan.planSha256) {
    throw new Error("Accepted graph entry boundary differs from its immutable invocation.");
  }
  if (record.source === "supplied-invocation") {
    if (invocation.acquisition !== "supplied" || requestValue !== undefined || record.acceptedAt !== invocation.createdAt) {
      throw new Error("Supplied graph input must be accepted with its invocation and without a request.");
    }
  } else {
    if (invocation.acquisition !== "deferred" || !requestValue) throw new Error("Deferred graph input requires its fixed request.");
    const request = validateGraphEntryRequestV1(graph, invocation, requestValue);
    if (record.requestId !== request.requestId || Date.parse(record.acceptedAt) < Date.parse(request.createdAt)
      || Date.parse(record.acceptedAt) >= Date.parse(request.expiresAt)) {
      throw new Error("Deferred graph input acceptance differs from its request or deadline.");
    }
  }
  const boundary = validateGraphEntryBoundaryV1(invocation.entryPlan, record.boundary);
  if (record.acceptedBodySha256 !== hashJson(boundary as unknown as JsonValue)) {
    throw new Error("Accepted graph entry body digest differs.");
  }
  return Object.freeze({ schemaVersion: 1, acceptanceId: record.acceptanceId,
    runRef: Object.freeze(runRef), planSha256: record.planSha256, boundary,
    acceptedBodySha256: record.acceptedBodySha256, acceptedAt: record.acceptedAt,
    source: record.source, ...(record.source === "deferred-submission" ? { requestId: record.requestId as string } : {}) }) as GraphAcceptedBoundaryV1;
}

export function projectGraphInvocationReadV1(options: {
  readonly graph: GraphWorkflowV1;
  readonly invocation: GraphRunInvocationV1;
  readonly requestState?: GraphEntryRequestStateV1;
  readonly accepted?: GraphAcceptedBoundaryV1;
}): GraphInvocationReadV1 {
  const invocation = validateGraphRunInvocationV1(options.graph, options.invocation);
  let input: GraphInvocationInputReadV1;
  if (invocation.acquisition === "supplied") {
    if (options.requestState || !options.accepted) throw new Error("Supplied graph invocation requires one accepted boundary and no input request.");
    const accepted = validateGraphAcceptedBoundaryV1(options.graph, invocation, undefined, options.accepted);
    input = { status: "input_accepted", source: accepted.source, acceptanceId: accepted.acceptanceId, acceptedAt: accepted.acceptedAt };
  } else {
    if (!options.requestState) throw new Error("Deferred graph invocation requires its input request state.");
    const state = validateGraphEntryRequestStateV1(options.graph, invocation, options.requestState);
    if (state.status === "submitted") {
      if (!options.accepted) throw new Error("Submitted graph input requires its immutable accepted boundary.");
      const accepted = validateGraphAcceptedBoundaryV1(options.graph, invocation, state.request, options.accepted);
      if (accepted.acceptedAt !== state.updatedAt) throw new Error("Accepted graph input time differs from its submitted request state.");
      input = { status: "input_accepted", source: accepted.source, acceptanceId: accepted.acceptanceId,
        requestId: state.request.requestId, acceptedAt: accepted.acceptedAt };
    } else {
      if (options.accepted) throw new Error("Only a submitted graph input can have an accepted boundary.");
      input = state.status === "pending"
        ? { status: "waiting_for_input", requestId: state.request.requestId, createdAt: state.request.createdAt, expiresAt: state.request.expiresAt }
        : { status: state.status, requestId: state.request.requestId, updatedAt: state.updatedAt };
    }
  }
  return Object.freeze({ schemaVersion: 1, runRef: invocation.runRef, workflow: invocation.workflow,
    acquisition: invocation.acquisition, entry: invocation.entryPlan.entry,
    planSha256: invocation.entryPlan.planSha256, requirements: invocation.entryPlan.requirements,
    createdAt: invocation.createdAt, input: immutableJson(input as unknown as JsonValue) as unknown as GraphInvocationInputReadV1 });
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
