/**
 * Private attachment contract for retained graph failure policies. It stays out
 * of Core's public root until the retained scheduler executes every advertised
 * capability.
 */
import {
  assertGraphPolicyCapabilitiesV1,
  assertGraphFailurePolicyDefinedV1,
  graphPolicyCapabilitiesV1,
  type GraphCatchPolicyV1,
  type GraphCleanupPolicyV1,
  type GraphRetryPolicyV1,
  type GraphRetryScopeV1,
} from "./graphFailurePolicy.ts";
import { graphPrivateWeakMap, graphPrivateWeakSet } from "./graphPrivateRegistry.ts";
import { graphNodeDetails, type GraphNodeV1, type GraphValueContractV1 } from "./graphWorkflow.ts";
import { defineStep, hashJson, stepDefinitionHash, type JsonValue, type StepDefinitionV1 } from "./durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "./inputWait.ts";
import { assertExactKeys } from "../domain/validation.ts";

export type GraphFailureBoundaryScopeV1 = GraphRetryScopeV1;

export interface GraphCatchHandlerInputV1<Input extends JsonValue = JsonValue> {
  readonly failure: import("./graphFailurePolicy.ts").GraphFailureEnvelopeV1;
  readonly scope: {
    readonly address: import("./graphInstance.ts").GraphInstanceAddressV1;
    readonly input: Input;
  };
}

export interface GraphCleanupHandlerInputV1<Input extends JsonValue = JsonValue> {
  readonly scope: {
    readonly address: import("./graphInstance.ts").GraphInstanceAddressV1;
    readonly input: Input;
  };
  readonly original: import("./graphFailurePolicy.ts").GraphOriginalOutcomeV1;
}

export interface GraphCatchHandlerV1<HandlerInput extends JsonValue = JsonValue,
  HandlerOutput extends JsonValue = JsonValue> {
  readonly policy: GraphCatchPolicyV1;
  readonly handler: StepDefinitionV1<HandlerInput, HandlerOutput>;
}

export interface GraphCleanupHandlerV1<HandlerInput extends JsonValue = JsonValue,
  HandlerOutput extends JsonValue = JsonValue> {
  readonly policy: GraphCleanupPolicyV1;
  readonly handler: StepDefinitionV1<HandlerInput, HandlerOutput>;
}

export interface GraphFailureBoundaryV1 {
  readonly placement: GraphNodeV1;
  readonly scope: GraphFailureBoundaryScopeV1;
  readonly retries: readonly GraphRetryPolicyV1[];
  readonly catches: readonly GraphCatchHandlerV1[];
  readonly cleanup: readonly GraphCleanupHandlerV1[];
}

export interface GraphFailureBoundaryOptionsV1<CatchInput extends JsonValue = JsonValue,
  CatchOutput extends JsonValue = JsonValue, CleanupInput extends JsonValue = JsonValue,
  CleanupOutput extends JsonValue = JsonValue> {
  readonly placement: GraphNodeV1;
  readonly scope: GraphFailureBoundaryScopeV1;
  readonly retries?: readonly GraphRetryPolicyV1[];
  readonly catches?: readonly GraphCatchHandlerV1<CatchInput, CatchOutput>[];
  readonly cleanup?: readonly GraphCleanupHandlerV1<CleanupInput, CleanupOutput>[];
}

const boundaries = graphPrivateWeakMap<readonly GraphFailureBoundaryV1[]>("failure-boundaries");
const snapshottedPlacements = graphPrivateWeakSet("failure-boundary-snapshots");

/** Attach policies before defineGraph/defineWorkflow snapshots the declaration. */
export function graphFailureBoundaryV1<CatchInput extends JsonValue, CatchOutput extends JsonValue,
  CleanupInput extends JsonValue, CleanupOutput extends JsonValue>(
  options: GraphFailureBoundaryOptionsV1<CatchInput, CatchOutput, CleanupInput, CleanupOutput>,
): GraphFailureBoundaryV1 {
  assertExactKeys(options as unknown as Record<string, unknown>, ["placement", "scope"], "Graph failure boundary",
    ["placement", "scope", "retries", "catches", "cleanup"]);
  if (!options.placement || typeof options.placement !== "object" || typeof options.placement.id !== "string") {
    throw new Error("Graph failure boundary requires a graph placement.");
  }
  if (snapshottedPlacements.has(options.placement)) {
    throw new Error("Graph failure policies must be attached before graph construction.");
  }
  assertScopeMatchesPlacement(options.scope, options.placement);
  const retries = Object.freeze([...(options.retries ?? [])]);
  retries.forEach(assertGraphFailurePolicyDefinedV1);
  const catches = Object.freeze([...(options.catches ?? [])].map((candidate) => {
    assertExactKeys(candidate as unknown as Record<string, unknown>, ["policy", "handler"], "Graph catch attachment");
    assertGraphFailurePolicyDefinedV1(candidate.policy);
    return Object.freeze({ policy: candidate.policy, handler: defineStep(candidate.handler) });
  })) as unknown as readonly GraphCatchHandlerV1[];
  const cleanup = Object.freeze([...(options.cleanup ?? [])].map((candidate) => {
    assertExactKeys(candidate as unknown as Record<string, unknown>, ["policy", "handler"], "Graph cleanup attachment");
    assertGraphFailurePolicyDefinedV1(candidate.policy);
    return Object.freeze({ policy: candidate.policy, handler: defineStep(candidate.handler) });
  })) as unknown as readonly GraphCleanupHandlerV1[];
  if (retries.length + catches.length + cleanup.length === 0) {
    throw new Error("Graph failure boundary requires at least one policy.");
  }
  for (const policy of retries) {
    if (policy.scope !== options.scope) throw new Error("Graph retry policy scope differs from its attachment scope.");
  }
  for (const candidate of catches) {
    if (candidate.policy.handlerDefinitionId !== candidate.handler.id) {
      throw new Error("Graph catch handler definition ID differs from its attached step.");
    }
    const output = boundaryOutputContract(options.scope, options.placement);
    if (candidate.policy.output.contractVersion !== output.version
      || hashJson(candidate.policy.output.schema as JsonValue) !== hashJson(output.schema as JsonValue)) {
      throw new Error("Graph catch output contract differs from its attachment output.");
    }
  }
  for (const candidate of cleanup) {
    if (candidate.policy.handlerDefinitionId !== candidate.handler.id) {
      throw new Error("Graph cleanup handler definition ID differs from its attached step.");
    }
  }
  const existing = boundaries.get(options.placement) ?? [];
  if (existing.some((boundary) => boundary.scope === options.scope)) {
    throw new Error(`Graph placement ${options.placement.id} already has a ${options.scope} failure boundary.`);
  }
  const ids = new Set(existing.flatMap(policyIds));
  for (const id of [...retries.map(item => item.policyId), ...catches.map(item => item.policy.policyId),
    ...cleanup.map(item => item.policy.policyId)]) {
    if (ids.has(id)) throw new Error(`Duplicate graph policy ID ${id} on placement ${options.placement.id}.`);
    ids.add(id);
  }
  const boundary = Object.freeze({ placement: options.placement, scope: options.scope, retries, catches, cleanup });
  boundaries.set(options.placement, Object.freeze([...existing, boundary]));
  return boundary;
}

export function graphFailureBoundariesV1(placement: GraphNodeV1): readonly GraphFailureBoundaryV1[] {
  return boundaries.get(placement) ?? Object.freeze([]);
}

export function graphFailureBoundaryCapabilitiesV1(placement: GraphNodeV1): readonly string[] {
  return Object.freeze([...new Set(graphFailureBoundariesV1(placement).flatMap((boundary) => [
    ...boundary.retries.flatMap(graphPolicyCapabilitiesV1),
    ...boundary.catches.flatMap(item => graphPolicyCapabilitiesV1(item.policy)),
    ...boundary.cleanup.flatMap(item => graphPolicyCapabilitiesV1(item.policy)),
  ]))].sort());
}

export function graphFailureBoundaryRecordV1(placement: GraphNodeV1): JsonValue {
  const record = inputWaitJsonSnapshot(graphFailureBoundariesV1(placement).map((boundary) => ({
    scope: boundary.scope,
    retries: boundary.retries,
    catches: boundary.catches.map(item => ({ policy: item.policy,
      handler: { id: item.handler.id, version: item.handler.definitionVersion,
        definitionSha256: stepDefinitionHash(item.handler) } })),
    cleanup: boundary.cleanup.map(item => ({ policy: item.policy,
      handler: { id: item.handler.id, version: item.handler.definitionVersion,
        definitionSha256: stepDefinitionHash(item.handler) } })),
  })));
  snapshottedPlacements.add(placement);
  return record;
}

export function assertGraphFailureBoundaryCapabilitiesV1(placement: GraphNodeV1, supported: readonly string[]): void {
  for (const boundary of graphFailureBoundariesV1(placement)) {
    boundary.retries.forEach(policy => assertGraphPolicyCapabilitiesV1(policy, supported));
    boundary.catches.forEach(item => assertGraphPolicyCapabilitiesV1(item.policy, supported));
    boundary.cleanup.forEach(item => assertGraphPolicyCapabilitiesV1(item.policy, supported));
  }
}

function policyIds(boundary: GraphFailureBoundaryV1): string[] {
  return [...boundary.retries.map(item => item.policyId), ...boundary.catches.map(item => item.policy.policyId),
    ...boundary.cleanup.map(item => item.policy.policyId)];
}

function assertScopeMatchesPlacement(scope: GraphFailureBoundaryScopeV1, placement: GraphNodeV1): void {
  let expected: GraphNodeV1["kind"] | undefined;
  if (scope === "node-instance") expected = "step";
  else if (scope === "subgraph-instance") expected = "subgraph";
  else if (scope === "map-item" || scope === "map-instance") expected = "map";
  else if (scope === "reduce-iteration" || scope === "reduce-instance") expected = "reduce";
  else if (scope === "loop-iteration" || scope === "loop-instance") expected = "loop";
  if (expected && placement.kind !== expected) {
    throw new Error(`Graph failure scope ${scope} requires a ${expected} placement.`);
  }
}

function boundaryOutputContract(scope: GraphFailureBoundaryScopeV1, placement: GraphNodeV1): GraphValueContractV1<JsonValue> {
  if (scope === "map-item" || scope === "reduce-iteration" || scope === "loop-iteration") {
    const data = graphNodeDetails(placement);
    if (data.kind === "step" || data.kind === "choice" || data.kind === "subgraph") {
      throw new Error(`Graph failure scope ${scope} requires a repeated control placement.`);
    }
    return data.body.output;
  }
  return placement.outputContract;
}
