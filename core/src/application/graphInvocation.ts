import {
  hashJson, immutableJson, type DeepReadonly, type JsonValue, type ValueValidatorV1,
} from "./durableWorkflow.ts";
import { inputWaitJsonSnapshot, parseInputWaitDurationV1, type InputWaitDurationV1 } from "./inputWait.ts";
import { graphBindingExpression, type GraphBindingV1, type GraphReferenceNodeV1 } from "./graphBindings.ts";
import {
  graphNodeDetails, type GraphDefinitionV1, type GraphNodeV1, type GraphValueContractV1,
} from "./graphWorkflow.ts";
import {
  validateGraphInstanceAddressV1, type GraphInstanceAddressV1, type GraphInstanceSegmentV1,
} from "./graphInstance.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";

export type GraphEntrySelectionV1 =
  | { readonly kind: "default" }
  | { readonly kind: "selected"; readonly address: GraphInstanceAddressV1 };

export type GraphBoundaryRequirementRoleV1 =
  | "entry-input"
  | "root-scope-input"
  | "skipped-node-input"
  | "skipped-node-output"
  | "control-input"
  | "map-completed-outputs"
  | "reduce-accumulator"
  | "loop-iteration";

export interface GraphBoundaryRequirementV1 {
  readonly id: string;
  readonly role: GraphBoundaryRequirementRoleV1;
  readonly address?: DeepReadonly<GraphInstanceAddressV1>;
  readonly contractVersion: string;
  readonly schema: Readonly<Record<string, JsonValue>>;
  readonly provenance: "caller-supplied";
}

export interface GraphContinuationScopeV1 {
  /** Empty for the root graph; otherwise the enclosing control occurrence path. */
  readonly scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[];
  readonly nodeIds: readonly string[];
}

export interface GraphEntryPlanV1 {
  readonly schemaVersion: 1;
  readonly entry: DeepReadonly<GraphInstanceAddressV1>;
  readonly entryKind: "default" | "selected";
  readonly requirements: readonly GraphBoundaryRequirementV1[];
  readonly continuation: readonly GraphContinuationScopeV1[];
  readonly planSha256: string;
}

export interface GraphEntryBoundaryV1 {
  readonly schemaVersion: 1;
  readonly planSha256: string;
  readonly values: Readonly<Record<string, DeepReadonly<JsonValue>>>;
}

export type GraphInvocationRequestV1 =
  | { readonly schemaVersion: 1; readonly acquisition: "supplied"; readonly entry: GraphEntrySelectionV1;
      readonly values: Readonly<Record<string, JsonValue>> }
  | { readonly schemaVersion: 1; readonly acquisition: "deferred"; readonly entry: GraphEntrySelectionV1;
      readonly wait: { readonly duration: InputWaitDurationV1 } };

export type GraphInvocationAdmissionV1 =
  | { readonly schemaVersion: 1; readonly acquisition: "supplied"; readonly plan: GraphEntryPlanV1;
      readonly boundary: GraphEntryBoundaryV1 }
  | { readonly schemaVersion: 1; readonly acquisition: "deferred"; readonly plan: GraphEntryPlanV1;
      readonly wait: { readonly duration: InputWaitDurationV1 } };

type RequirementRuntime = {
  readonly descriptor: GraphBoundaryRequirementV1;
  readonly parse: (value: unknown) => JsonValue;
};
const plans = new WeakMap<object, readonly RequirementRuntime[]>();

/**
 * Builds a readable, retained entry boundary without executing graph callbacks.
 * The plan describes only caller values. Runtime-derived values are not accepted.
 */
export function describeGraphEntryV1(graph: GraphDefinitionV1, selection: GraphEntrySelectionV1): GraphEntryPlanV1 {
  const entryKind = validateSelection(selection);
  const entry = selection.kind === "default"
    ? validateGraphInstanceAddressV1(graph, { schemaVersion: 1, path: [{ nodeId: graph.entry.id }] })
    : validateGraphInstanceAddressV1(graph, selection.address);
  const resolved = resolveAddress(graph, entry);
  const requirements = new Map<string, RequirementRuntime>();
  const continuation: GraphContinuationScopeV1[] = [];

  if (entryKind === "default") {
    addContract(requirements, "entry", "entry-input", graph.input);
  } else {
    addContract(requirements, "entry", "entry-input", resolved.node.inputContract, entry);
    addControlRequirements(requirements, resolved.frames);
  }

  // Continue the selected scope to its result, then treat each enclosing control
  // as the completed origin in its parent scope.
  collectScopeBoundary({
    graph: resolved.scope,
    origin: resolved.node,
    scopePath: resolved.scopePath,
    bypassOriginBinding: entryKind === "selected",
    rootScopeInput: entryKind === "default" ? "entry" : undefined,
    includeAllRequired: entryKind === "default",
    requirements,
    continuation,
  });
  for (let index = resolved.frames.length - 1; index >= 0; index--) {
    const frame = resolved.frames[index];
    collectScopeBoundary({
      graph: frame.parent,
      origin: frame.node,
      scopePath: frame.parentScopePath,
      bypassOriginBinding: true,
      rootScopeInput: undefined,
      includeAllRequired: false,
      requirements,
      continuation,
    });
  }

  const descriptors = Object.freeze([...requirements.values()].map((item) => item.descriptor)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const continuationSnapshot = immutableJson(continuation as unknown as JsonValue) as unknown as readonly GraphContinuationScopeV1[];
  const planSha256 = hashJson({ schemaVersion: 1, declarationSha256: graph.declarationSha256,
    entryKind, entry, requirements: descriptors, continuation: continuationSnapshot } as unknown as JsonValue);
  const plan = Object.freeze({ schemaVersion: 1 as const, entry, entryKind,
    requirements: descriptors, continuation: continuationSnapshot, planSha256 });
  plans.set(plan, Object.freeze([...requirements.values()]));
  return plan;
}

/** Rebuilds validator bindings from the retained graph after process restart. */
export function restoreGraphEntryPlanV1(graph: GraphDefinitionV1, value: unknown): GraphEntryPlanV1 {
  const saved = inputWaitJsonSnapshot(value);
  if (!isRecord(saved)) throw new Error("Retained graph entry plan must be an object.");
  assertExactKeys(saved, ["schemaVersion", "entry", "entryKind", "requirements", "continuation", "planSha256"], "Retained graph entry plan");
  if (saved.schemaVersion !== 1) throw new Error("Retained graph entry plan.schemaVersion must be 1.");
  if (saved.entryKind !== "default" && saved.entryKind !== "selected") throw new Error("Retained graph entry plan.entryKind is invalid.");
  if (typeof saved.planSha256 !== "string") throw new Error("Retained graph entry plan.planSha256 must be a string.");
  const selection: GraphEntrySelectionV1 = saved.entryKind === "default"
    ? { kind: "default" }
    : { kind: "selected", address: saved.entry as unknown as GraphInstanceAddressV1 };
  const restored = describeGraphEntryV1(graph, selection);
  if (restored.planSha256 !== saved.planSha256) throw new Error("Retained graph entry plan does not match the retained graph declaration.");
  return restored;
}

/** Supplied and deferred submission call this exact validator. */
export function validateGraphEntryBoundaryV1(plan: GraphEntryPlanV1, value: unknown): GraphEntryBoundaryV1 {
  const runtime = plans.get(plan);
  if (!runtime) throw new Error("Use describeGraphEntryV1 to obtain the retained entry plan.");
  const boundary = inputWaitJsonSnapshot(value);
  if (!isRecord(boundary)) throw new Error("Graph entry boundary must be an object.");
  assertExactKeys(boundary, ["schemaVersion", "planSha256", "values"], "Graph entry boundary");
  if (boundary.schemaVersion !== 1) throw new Error("Graph entry boundary.schemaVersion must be 1.");
  if (boundary.planSha256 !== plan.planSha256) throw new Error("Graph entry boundary does not match the retained entry plan.");
  if (!isRecord(boundary.values)) throw new Error("Graph entry boundary.values must be an object.");
  const expected = runtime.map((item) => item.descriptor.id).sort();
  assertExactKeys(boundary.values, expected, "Graph entry boundary values");
  const values: Record<string, JsonValue> = {};
  for (const requirement of runtime) {
    try {
      values[requirement.descriptor.id] = requirement.parse(boundary.values[requirement.descriptor.id]);
    } catch (cause) {
      throw new Error(`Graph entry value ${requirement.descriptor.id} is invalid.`, { cause });
    }
  }
  validateControlProgress(plan, values);
  return Object.freeze({ schemaVersion: 1, planSha256: plan.planSha256,
    values: immutableJson(values) as Readonly<Record<string, DeepReadonly<JsonValue>>> });
}

export function admitGraphInvocationV1(graph: GraphDefinitionV1, value: unknown): GraphInvocationAdmissionV1 {
  const request = inputWaitJsonSnapshot(value);
  if (!isRecord(request)) throw new Error("Graph invocation request must be an object.");
  if (request.acquisition === "deferred") {
    assertExactKeys(request, ["schemaVersion", "acquisition", "entry", "wait"], "Graph invocation request");
  } else if (request.acquisition === "supplied") {
    assertExactKeys(request, ["schemaVersion", "acquisition", "entry", "values"], "Graph invocation request");
  } else throw new Error("Graph invocation acquisition must be supplied or deferred.");
  if (request.schemaVersion !== 1) throw new Error("Graph invocation request.schemaVersion must be 1.");
  const entry = parseSelection(request.entry);
  const plan = describeGraphEntryV1(graph, entry);
  if (request.acquisition === "deferred") {
    if (!isRecord(request.wait)) throw new Error("Graph invocation wait must be an object.");
    assertExactKeys(request.wait, ["duration"], "Graph invocation wait");
    parseInputWaitDurationV1(request.wait.duration);
    return Object.freeze({ schemaVersion: 1, acquisition: "deferred", plan,
      wait: Object.freeze({ duration: request.wait.duration as InputWaitDurationV1 }) });
  }
  const boundary = validateGraphEntryBoundaryV1(plan, { schemaVersion: 1, planSha256: plan.planSha256, values: request.values });
  return Object.freeze({ schemaVersion: 1, acquisition: "supplied", plan, boundary });
}

type Frame = {
  readonly parent: GraphDefinitionV1;
  readonly parentScopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[];
  readonly node: GraphNodeV1;
  readonly occurrence: NonNullable<DeepReadonly<GraphInstanceSegmentV1>["occurrence"]>;
  readonly address: DeepReadonly<GraphInstanceAddressV1>;
};
function resolveAddress(graph: GraphDefinitionV1, address: DeepReadonly<GraphInstanceAddressV1>): {
  readonly scope: GraphDefinitionV1;
  readonly scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[];
  readonly node: GraphNodeV1;
  readonly frames: readonly Frame[];
} {
  let scope = graph;
  const scopePath: DeepReadonly<GraphInstanceSegmentV1>[] = [];
  const frames: Frame[] = [];
  for (const segment of address.path) {
    const node = scope.nodes.find((item) => item.id === segment.nodeId)!;
    if (!segment.occurrence) return { scope, scopePath: Object.freeze([...scopePath]), node, frames: Object.freeze(frames) };
    const data = graphNodeDetails(node);
    const frameAddress = immutableJson({ schemaVersion: 1, path: [...scopePath, segment] }) as DeepReadonly<GraphInstanceAddressV1>;
    frames.push({ parent: scope, parentScopePath: Object.freeze([...scopePath]), node, occurrence: segment.occurrence, address: frameAddress });
    scopePath.push(segment);
    if (data.kind === "choice" && segment.occurrence.kind === "choice") scope = data.cases[segment.occurrence.case];
    else if (data.kind !== "step" && data.kind !== "choice") scope = data.body;
  }
  throw new Error("Graph entry address has no target node.");
}

function addControlRequirements(requirements: Map<string, RequirementRuntime>, frames: readonly Frame[]): void {
  for (const frame of frames) {
    const data = graphNodeDetails(frame.node), prefix = `control/${pathId(frame.address)}`;
    addContract(requirements, `${prefix}/input`, "control-input", frame.node.inputContract, frame.address);
    if (data.kind === "map" && frame.occurrence.kind === "map") {
      const selectedIndex = frame.occurrence.index;
      addRuntime(requirements, `${prefix}/completed`, "map-completed-outputs", frame.address,
        arraySchema(data.body.output.schema, selectedIndex), {
          parse(value) {
            if (!Array.isArray(value) || value.length !== selectedIndex) throw new Error("Completed map outputs must match the selected item index.");
            return value.map((item) => data.body.output.validator.parse(item));
          },
        }, `map-prefix-${data.body.output.version}`);
    } else if (data.kind === "reduce" && frame.occurrence.kind === "reduce") {
      addContract(requirements, `${prefix}/accumulator`, "reduce-accumulator", data.body.output, frame.address);
    } else if (data.kind === "loop" && frame.occurrence.kind === "loop") {
      addRuntime(requirements, `${prefix}/iteration`, "loop-iteration", frame.address,
        { type: "integer", minimum: 0, title: "Current loop iteration",
          description: "Zero-based iteration number of the selected loop execution.", examples: [frame.occurrence.iteration] },
        { parse: nonNegativeInteger }, "non-negative-integer@1");
    }
  }
}

function collectScopeBoundary(options: {
  graph: GraphDefinitionV1;
  origin: GraphNodeV1;
  scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[];
  bypassOriginBinding: boolean;
  rootScopeInput?: string;
  includeAllRequired: boolean;
  requirements: Map<string, RequirementRuntime>;
  continuation: GraphContinuationScopeV1[];
}): void {
  const { graph, origin, scopePath, requirements } = options;
  const dependencies = new Map<GraphNodeV1, ReturnType<typeof dependencyUses>>();
  const dependents = new Map<GraphNodeV1, GraphNodeV1[]>();
  for (const node of graph.nodes) {
    const uses = dependencyUses(node);
    dependencies.set(node, uses);
    for (const dependency of uses.nodes.keys()) {
      const list = dependents.get(dependency) ?? [];
      list.push(node); dependents.set(dependency, list);
    }
  }
  const downstream = closure([origin], (node) => dependents.get(node) ?? []);
  const requiredAncestors = closure(graph.required, (node) => [...dependencies.get(node)!.nodes.keys()]);
  const active = options.includeAllRequired
    ? requiredAncestors
    : new Set([...downstream].filter((node) => requiredAncestors.has(node)));
  if (!active.has(graph.result)) throw new Error(`Selected entry ${origin.id} cannot reach this scope's result.`);
  options.continuation.push({ scopePath: immutableJson(scopePath as unknown as JsonValue) as unknown as readonly DeepReadonly<GraphInstanceSegmentV1>[],
    nodeIds: Object.freeze(graph.nodes.filter((node) => active.has(node)).map((node) => node.id)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) });

  for (const node of active) {
    const uses = dependencies.get(node)!;
    if (node === origin && options.bypassOriginBinding) continue;
    if (uses.scopeInput && !options.rootScopeInput && scopePath.length === 0) {
      addContract(requirements, "scope/root", "root-scope-input", graph.input);
    }
    for (const [dependency, kinds] of uses.nodes) {
      if (active.has(dependency)) continue;
      if (kinds.has("after")) throw new Error(`Selected entry would fabricate successful ordering dependency ${dependency.id}.`);
      const address = nodeAddress(scopePath, dependency.id);
      if (kinds.has("input")) addContract(requirements, `node/${pathId(address)}/input`, "skipped-node-input", dependency.inputContract, address);
      if (kinds.has("output")) addContract(requirements, `node/${pathId(address)}/output`, "skipped-node-output", dependency.outputContract, address);
    }
  }
}

function dependencyUses(node: GraphNodeV1): {
  readonly nodes: Map<GraphNodeV1, Set<"input" | "output" | "after">>;
  readonly scopeInput: boolean;
} {
  const nodes = new Map<GraphNodeV1, Set<"input" | "output" | "after">>();
  const add = (target: GraphReferenceNodeV1<JsonValue, JsonValue>, kind: "input" | "output" | "after") => {
    const values = nodes.get(target as GraphNodeV1) ?? new Set(); values.add(kind); nodes.set(target as GraphNodeV1, values);
  };
  for (const after of graphNodeDetails(node).after) add(after, "after");
  let scopeInput = false;
  const visit = (binding: GraphBindingV1<JsonValue>) => {
    const expression = graphBindingExpression(binding);
    switch (expression.kind) {
      case "scope-input": scopeInput = true; break;
      case "node-input": add(expression.node, "input"); break;
      case "node-output": add(expression.node, "output"); break;
      case "field": visit(expression.source); break;
      case "object": Object.values(expression.fields).forEach(visit); break;
      case "array": expression.items.forEach(visit); break;
    }
  };
  visit(graphNodeDetails(node).binding);
  return { nodes, scopeInput };
}

function validateControlProgress(plan: GraphEntryPlanV1, values: Record<string, JsonValue>): void {
  for (const requirement of plan.requirements.filter((item) => item.role === "control-input")) {
    const prefix = requirement.id.slice(0, -"/input".length), address = requirement.address!;
    const last = address.path.at(-1)!;
    if (!last.occurrence) throw new Error("Control requirement has no occurrence.");
    const input = values[requirement.id];
    if ((last.occurrence.kind === "map" || last.occurrence.kind === "reduce")) {
      if (!isRecord(input)) throw new Error(`Control input ${requirement.id} must be an object.`);
      if (!Array.isArray(input.items) || last.occurrence.index >= input.items.length) {
        throw new Error(`Selected ${last.occurrence.kind} index is outside the supplied collection.`);
      }
      if (last.occurrence.kind === "map" && !Array.isArray(values[`${prefix}/completed`])) {
        throw new Error("Selected map entry requires completed output prefix.");
      }
      if (last.occurrence.kind === "reduce" && last.occurrence.index === 0
        && hashJson(values[`${prefix}/accumulator`]) !== hashJson(input.initial)) {
        throw new Error("The first reduce item must use the declared initial accumulator.");
      }
    } else if (last.occurrence.kind === "loop") {
      if (!isRecord(input)) throw new Error(`Control input ${requirement.id} must be an object.`);
      if (values[`${prefix}/iteration`] !== last.occurrence.iteration) {
        throw new Error("Loop iteration value must match the selected instance address.");
      }
    }
  }
}

function addContract(requirements: Map<string, RequirementRuntime>, id: string, role: GraphBoundaryRequirementRoleV1,
  contract: GraphValueContractV1<JsonValue>, address?: DeepReadonly<GraphInstanceAddressV1>): void {
  addRuntime(requirements, id, role, address, contract.schema, contract.validator, contract.version);
}
function addRuntime(requirements: Map<string, RequirementRuntime>, id: string, role: GraphBoundaryRequirementRoleV1,
  address: DeepReadonly<GraphInstanceAddressV1> | undefined, schema: Readonly<Record<string, JsonValue>>,
  validator: ValueValidatorV1<JsonValue>, contractVersion: string): void {
  const existing = requirements.get(id);
  if (existing) {
    if (existing.descriptor.role !== role || hashJson(existing.descriptor.schema as JsonValue) !== hashJson(schema as JsonValue)) {
      throw new Error(`Graph entry requirement ${id} is ambiguous.`);
    }
    return;
  }
  const descriptor = Object.freeze({ id, role, ...(address ? { address } : {}), contractVersion,
    schema: immutableJson(schema as Record<string, JsonValue>) as Readonly<Record<string, JsonValue>>,
    provenance: "caller-supplied" as const });
  requirements.set(id, { descriptor, parse: (value) => immutableJson(inputWaitJsonSnapshot(validator.parse(inputWaitJsonSnapshot(value)))) as JsonValue });
}
function arraySchema(items: Readonly<Record<string, JsonValue>>, length: number): Readonly<Record<string, JsonValue>> {
  const itemExamples = Array.isArray(items.examples) ? items.examples : [];
  return { type: "array", items: items as JsonValue, minItems: length, maxItems: length,
    title: "Earlier map outputs", description: "Outputs already produced before the selected map item.",
    ...(itemExamples.length ? { examples: [Array.from({ length }, (_, index) => itemExamples[index % itemExamples.length])] } : {}) };
}
function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Value must be a non-negative safe integer.");
  return value as number;
}
function closure(seed: readonly GraphNodeV1[], next: (node: GraphNodeV1) => readonly GraphNodeV1[]): Set<GraphNodeV1> {
  const result = new Set<GraphNodeV1>(), pending = [...seed];
  while (pending.length) { const node = pending.pop()!; if (result.has(node)) continue; result.add(node); pending.push(...next(node)); }
  return result;
}
function nodeAddress(scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[], nodeId: string): DeepReadonly<GraphInstanceAddressV1> {
  return immutableJson({ schemaVersion: 1, path: [...scopePath, { nodeId }] }) as DeepReadonly<GraphInstanceAddressV1>;
}
function pathId(address: DeepReadonly<GraphInstanceAddressV1>): string {
  return address.path.map((segment) => {
    const occurrence = segment.occurrence;
    if (!occurrence) return segment.nodeId;
    if (occurrence.kind === "subgraph") return `${segment.nodeId}@subgraph`;
    if (occurrence.kind === "choice") return `${segment.nodeId}@choice=${occurrence.case}`;
    if (occurrence.kind === "loop") return `${segment.nodeId}@loop=${occurrence.iteration}`;
    return `${segment.nodeId}@${occurrence.kind}=${occurrence.index}`;
  }).join("/");
}
function validateSelection(value: GraphEntrySelectionV1): "default" | "selected" {
  if (!isRecord(value)) throw new Error("Graph entry selection must be an object.");
  if (value.kind === "default") { assertExactKeys(value, ["kind"], "Graph entry selection"); return "default"; }
  if (value.kind === "selected") { assertExactKeys(value, ["kind", "address"], "Graph entry selection"); return "selected"; }
  throw new Error("Graph entry selection.kind must be default or selected.");
}
function parseSelection(value: unknown): GraphEntrySelectionV1 {
  if (!isRecord(value)) throw new Error("Graph entry selection must be an object.");
  if (value.kind === "default") { assertExactKeys(value, ["kind"], "Graph entry selection"); return { kind: "default" }; }
  if (value.kind === "selected") {
    assertExactKeys(value, ["kind", "address"], "Graph entry selection");
    return { kind: "selected", address: value.address as GraphInstanceAddressV1 };
  }
  throw new Error("Graph entry selection.kind must be default or selected.");
}
