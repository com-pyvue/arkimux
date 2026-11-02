import {
  assertDurableIdentifier, defineStep, hashJson, immutableJson,
  type DeepReadonly, type JsonValue, type StepDefinitionV1, type ValueValidatorV1,
} from "./durableWorkflow.ts";
import { validateWorkflowIdentity, type WorkflowIdentity } from "../domain/workflowIdentity.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";
import { graphBindingExpression, type GraphBindingV1, type GraphReferenceNodeV1 } from "./graphBindings.ts";
import { inputWaitJsonSnapshot } from "./inputWait.ts";
import type { GraphInstanceAddressV1 } from "./graphInstance.ts";
import { graphPrivateWeakMap, graphPrivateWeakSet } from "./graphPrivateRegistry.ts";
import {
  graphFailureBoundaryCapabilitiesV1,
  graphFailureBoundaryRecordV1,
} from "./graphFailureBoundary.ts";

export interface GraphValueContractV1<T extends JsonValue> {
  readonly version: string;
  readonly schema: Readonly<Record<string, JsonValue>>;
  readonly validator: ValueValidatorV1<T>;
}
export interface GraphNodeV1<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue>
  extends GraphReferenceNodeV1<I, O> {
  readonly kind: "step" | "subgraph" | "map" | "reduce" | "loop" | "choice";
  readonly inputContract: GraphValueContractV1<I>;
  readonly outputContract: GraphValueContractV1<O>;
}
interface NodeOptions<I extends JsonValue> {
  readonly id: string;
  readonly input: GraphBindingV1<NoInfer<I>>;
  readonly after?: readonly GraphNodeV1[];
}
interface ControlOptions<I extends JsonValue, O extends JsonValue> extends NodeOptions<I> {
  readonly inputContract: GraphValueContractV1<I>;
  readonly outputContract: GraphValueContractV1<O>;
}
export interface GraphDefinitionV1<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly kind: "graph-definition";
  readonly id: string;
  readonly definitionVersion: string;
  readonly input: GraphValueContractV1<I>;
  readonly output: GraphValueContractV1<O>;
  readonly nodes: readonly GraphNodeV1[];
  readonly entry: GraphNodeV1;
  readonly result: GraphNodeV1<JsonValue, O>;
  readonly required: readonly GraphNodeV1[];
  readonly capabilities: readonly string[];
  /** Metadata fingerprint only. Callback code must also be pinned by retained build. */
  readonly declarationSha256: string;
}
export interface GraphWorkflowV1<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue>
  extends GraphDefinitionV1<I, O> {
  readonly workflow: Readonly<WorkflowIdentity>;
  readonly workflowContractVersion: string;
  readonly resultKind: string;
  readonly scheduling: "serial";
  /** Finite user-facing entry catalog. Omit to expose the default and root nodes. */
  readonly invocationEntries?: readonly GraphInvocationEntryDeclarationV1[];
}

export interface GraphInvocationEntryDeclarationV1 {
  readonly id: string;
  readonly label: string;
  readonly entry: { readonly kind: "default" }
    | { readonly kind: "selected"; readonly address: GraphInstanceAddressV1 };
}

export type GraphNodeDetailsV1 = {
  readonly binding: GraphBindingV1<JsonValue>;
  readonly after: readonly GraphNodeV1[];
} & (
  | { readonly kind: "step"; readonly step: StepDefinitionV1<JsonValue, JsonValue> }
  | { readonly kind: "subgraph" | "map" | "reduce"; readonly body: GraphDefinitionV1 }
  | { readonly kind: "loop"; readonly body: GraphDefinitionV1; readonly conditionVersion: string;
      readonly while: (input: DeepReadonly<JsonValue>) => boolean }
  | { readonly kind: "choice"; readonly selectionVersion: string;
      readonly select: (input: DeepReadonly<JsonValue>) => string;
      readonly cases: Readonly<Record<string, GraphDefinitionV1>> }
);
const details = graphPrivateWeakMap<GraphNodeDetailsV1>("node-details");
const definitions = graphPrivateWeakSet("definitions");
const contracts = graphPrivateWeakSet("value-contracts");
const sourceValidator = Symbol.for("arkimux.graph.source-validator@1");

/** The readable schema and validator share a version; retained code pins the parser. */
export function defineGraphValue<T extends JsonValue>(value: Omit<GraphValueContractV1<T>, "schema"> & {
  readonly schema: Readonly<Record<string, unknown>>;
}): GraphValueContractV1<T> {
  assertExactKeys(value as unknown as Record<string, unknown>, ["version", "schema", "validator"], "Graph value contract");
  assertDurableIdentifier(value.version, "Graph value contract version");
  if (typeof value.validator?.parse !== "function") throw new Error("Graph value contract requires a validator.");
  if (!value.schema || Array.isArray(value.schema) || typeof value.schema !== "object") throw new Error("Graph schema must be an object.");
  const schema = immutableJson(inputWaitJsonSnapshot(schemaWireValue(value.schema))) as Readonly<Record<string, JsonValue>>;
  checkSchemaReferences(schema);
  const parse = value.validator.parse.bind(value.validator);
  const result = { version: value.version, schema, validator: Object.freeze({
    parse: (input: unknown): T => immutableJson(inputWaitJsonSnapshot(parse(inputWaitJsonSnapshot(input)))) as T,
  }) };
  Object.defineProperty(result, sourceValidator, { value: value.validator, enumerable: false });
  Object.freeze(result);
  contracts.add(result);
  return result;
}

export function graphStep<I extends JsonValue, O extends JsonValue>(options: NodeOptions<I> & {
  readonly step: StepDefinitionV1<I, O>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}): GraphNodeV1<I, O> {
  exact(options, ["id", "step", "input", "inputSchema", "outputSchema"], ["after"]);
  const step = defineStep(options.step);
  // Reuse the step's actual validators. No second registration validator.
  return node(options, defineGraphValue({ version: step.definitionVersion, schema: options.inputSchema, validator: step.input }),
    defineGraphValue({ version: step.definitionVersion, schema: options.outputSchema, validator: step.output }),
    { kind: "step", step: step as StepDefinitionV1<JsonValue, JsonValue> });
}

export function graphSubgraph<I extends JsonValue, O extends JsonValue>(options: NodeOptions<I> & {
  readonly body: GraphDefinitionV1<I, O>;
}): GraphNodeV1<I, O> {
  exact(options, ["id", "input", "body"], ["after"]);
  requireDefinition(options.body);
  return node(options, options.body.input, options.body.output, { kind: "subgraph", body: options.body });
}

export type GraphMapInputV1<T extends JsonValue, C extends JsonValue> = { items: T[]; context: C };
export type GraphMapBodyInputV1<T extends JsonValue, C extends JsonValue> = { item: T; index: number; context: C };
export function graphMap<T extends JsonValue, C extends JsonValue, O extends JsonValue>(
  options: ControlOptions<GraphMapInputV1<T, C>, O[]> & { readonly body: GraphDefinitionV1<GraphMapBodyInputV1<T, C>, O> },
): GraphNodeV1<GraphMapInputV1<T, C>, O[]> {
  exact(options, ["id", "input", "inputContract", "outputContract", "body"], ["after"]);
  requireDefinition(options.body);
  return node(options, options.inputContract, options.outputContract, { kind: "map", body: options.body });
}

export type GraphReduceInputV1<T extends JsonValue, A extends JsonValue, C extends JsonValue> = { items: T[]; initial: A; context: C };
export type GraphReduceBodyInputV1<T extends JsonValue, A extends JsonValue, C extends JsonValue> = { item: T; index: number; accumulator: A; context: C };
export function graphReduce<T extends JsonValue, A extends JsonValue, C extends JsonValue>(
  options: ControlOptions<GraphReduceInputV1<T, A, C>, A> & { readonly body: GraphDefinitionV1<GraphReduceBodyInputV1<T, A, C>, A> },
): GraphNodeV1<GraphReduceInputV1<T, A, C>, A> {
  exact(options, ["id", "input", "inputContract", "outputContract", "body"], ["after"]);
  requireDefinition(options.body);
  return node(options, options.inputContract, options.outputContract, { kind: "reduce", body: options.body });
}

export type GraphLoopInputV1<S extends JsonValue, C extends JsonValue> = { state: S; context: C };
export type GraphLoopBodyInputV1<S extends JsonValue, C extends JsonValue> = { state: S; iteration: number; context: C };
export function graphLoop<S extends JsonValue, C extends JsonValue>(options: ControlOptions<GraphLoopInputV1<S, C>, S> & {
  readonly body: GraphDefinitionV1<GraphLoopBodyInputV1<S, C>, S>;
  readonly conditionVersion: string;
  readonly while: (input: DeepReadonly<GraphLoopBodyInputV1<S, C>>) => boolean;
}): GraphNodeV1<GraphLoopInputV1<S, C>, S> {
  exact(options, ["id", "input", "inputContract", "outputContract", "body", "conditionVersion", "while"], ["after"]);
  requireDefinition(options.body);
  assertDurableIdentifier(options.conditionVersion, "Loop condition version");
  if (typeof options.while !== "function") throw new Error("Loop requires a condition callback.");
  return node(options, options.inputContract, options.outputContract, { kind: "loop", body: options.body,
    conditionVersion: options.conditionVersion, while: options.while as (input: DeepReadonly<JsonValue>) => boolean });
}

/** One selected subgraph, one typed result. Not a race or an all-branch join. */
export function graphChoice<I extends JsonValue, O extends JsonValue>(options: ControlOptions<I, O> & {
  readonly selectionVersion: string;
  readonly select: (input: DeepReadonly<I>) => string;
  readonly cases: Readonly<Record<string, GraphDefinitionV1<I, O>>>;
}): GraphNodeV1<I, O> {
  exact(options, ["id", "input", "inputContract", "outputContract", "selectionVersion", "select", "cases"], ["after"]);
  assertDurableIdentifier(options.selectionVersion, "Choice selection version");
  if (typeof options.select !== "function") throw new Error("Choice requires a selection callback.");
  if (!options.cases || Object.keys(options.cases).length === 0) throw new Error("Choice requires named cases.");
  for (const [key, body] of Object.entries(options.cases)) { assertDurableIdentifier(key, "Choice case"); requireDefinition(body); }
  return node(options, options.inputContract, options.outputContract, { kind: "choice",
    selectionVersion: options.selectionVersion, select: options.select as (input: DeepReadonly<JsonValue>) => string,
    cases: Object.freeze({ ...options.cases }) });
}

type DetailsWithoutBinding = GraphNodeDetailsV1 extends infer D ? D extends GraphNodeDetailsV1 ? Omit<D, "binding" | "after"> : never : never;
function node<I extends JsonValue, O extends JsonValue>(options: NodeOptions<I>, input: GraphValueContractV1<I>,
  output: GraphValueContractV1<O>, body: DetailsWithoutBinding): GraphNodeV1<I, O> {
  assertDurableIdentifier(options.id, "Graph node ID");
  requireContract(input); requireContract(output); graphBindingExpression(options.input);
  const after = Object.freeze([...(options.after ?? [])]);
  after.forEach(graphNodeDetails);
  const result = Object.freeze({ id: options.id, kind: body.kind, input: input.validator, output: output.validator,
    inputContract: input, outputContract: output });
  details.set(result, Object.freeze({ ...body, binding: options.input, after } as GraphNodeDetailsV1));
  return result;
}
export function graphNodeDetails(value: GraphNodeV1): GraphNodeDetailsV1 {
  const result = value && details.get(value);
  if (!result) throw new Error("Use graph node helpers to declare nodes.");
  return result;
}

/** Structural address validation shared by declarations and retained execution. */
export function validateGraphInstanceAddressStructureV1(graph: GraphDefinitionV1, value: unknown): DeepReadonly<GraphInstanceAddressV1> {
  requireDefinition(graph);
  const address = inputWaitJsonSnapshot(value);
  if (!isRecord(address)) throw new Error("Graph instance address must be an object.");
  assertExactKeys(address, ["schemaVersion", "path"], "Graph instance address");
  if (address.schemaVersion !== 1 || !Array.isArray(address.path) || address.path.length === 0) {
    throw new Error("Graph instance address requires schemaVersion 1 and a nonempty path.");
  }
  let scope = graph;
  for (let index = 0; index < address.path.length; index++) {
    const segment: unknown = address.path[index];
    if (!isRecord(segment)) throw new Error("Graph instance segment must be an object.");
    const last = index === address.path.length - 1;
    const hasOccurrence = Object.hasOwn(segment, "occurrence");
    assertExactKeys(segment, hasOccurrence ? ["nodeId", "occurrence"] : ["nodeId"], "Graph instance segment");
    const node = scope.nodes.find((item) => item.id === segment.nodeId);
    if (!node) throw new Error("Graph instance node is outside the declared scope.");
    if (last && !hasOccurrence) continue;
    if (!hasOccurrence) throw new Error("Nested graph instances need an enclosing occurrence.");
    const occurrence: unknown = segment.occurrence;
    if (!isRecord(occurrence)) throw new Error("Nested graph instances need an enclosing occurrence.");
    const data = graphNodeDetails(node);
    if (data.kind === "step" || occurrence.kind !== data.kind) throw new Error("Graph occurrence does not match its control node.");
    if (data.kind === "choice") {
      assertExactKeys(occurrence, ["kind", "case"], "Choice occurrence");
      if (typeof occurrence.case !== "string" || !Object.hasOwn(data.cases, occurrence.case)) throw new Error("Unknown choice case.");
      if (!last) scope = data.cases[occurrence.case]!;
    } else {
      if (data.kind === "subgraph") assertExactKeys(occurrence, ["kind"], "Subgraph occurrence");
      else {
        const counter = data.kind === "loop" ? "iteration" : "index";
        assertExactKeys(occurrence, ["kind", counter], "Repeated occurrence");
        if (!Number.isSafeInteger(occurrence[counter]) || (occurrence[counter] as number) < 0) {
          throw new Error("Graph occurrence index must be a non-negative safe integer.");
        }
      }
      if (!last) scope = data.body;
    }
  }
  return immutableJson(address) as DeepReadonly<GraphInstanceAddressV1>;
}

export interface GraphDefinitionOptionsV1<I extends JsonValue, O extends JsonValue> {
  readonly id: string;
  readonly definitionVersion: string;
  readonly input: GraphValueContractV1<I>;
  readonly nodes: readonly GraphNodeV1[];
  readonly entry: GraphNodeV1;
  readonly result: GraphNodeV1<JsonValue, O>;
  /** Additional required side-effect roots not contributing to the result. */
  readonly required?: readonly GraphNodeV1[];
}
export function defineGraph<I extends JsonValue, O extends JsonValue>(options: GraphDefinitionOptionsV1<I, O>): GraphDefinitionV1<I, O> {
  exact(options, ["id", "definitionVersion", "input", "nodes", "entry", "result"], ["required"]);
  assertDurableIdentifier(options.id, "Graph definition ID");
  assertDurableIdentifier(options.definitionVersion, "Graph definition version");
  requireContract(options.input);
  const nodes = [...options.nodes], byId = new Map<string, GraphNodeV1>();
  for (const item of nodes) {
    graphNodeDetails(item);
    if (byId.has(item.id)) throw new Error(`Duplicate graph node ID ${item.id}.`);
    byId.set(item.id, item);
  }
  const requireMember = (item: GraphReferenceNodeV1<JsonValue, JsonValue>) => {
    if (byId.get(item.id) !== item) throw new Error(`Graph reference ${item.id} is outside this scope.`);
  };
  requireMember(options.entry); requireMember(options.result);
  const dependencies = new Map<GraphNodeV1, readonly GraphNodeV1[]>();
  for (const item of nodes) {
    const data = graphNodeDetails(item);
    const refs = new Set<GraphReferenceNodeV1<JsonValue, JsonValue>>(data.after);
    visitBinding(data.binding, (ref) => refs.add(ref));
    refs.forEach(requireMember);
    dependencies.set(item, [...refs] as GraphNodeV1[]);
  }
  if (dependencies.get(options.entry)!.length) throw new Error("Default graph entry must not depend on other nodes.");
  const visited = new Set<GraphNodeV1>(), active = new Set<GraphNodeV1>();
  const walk = (item: GraphNodeV1) => {
    if (active.has(item)) throw new Error(`Graph dependency cycle at ${item.id}; use an explicit loop.`);
    if (visited.has(item)) return;
    active.add(item); dependencies.get(item)!.forEach(walk); active.delete(item); visited.add(item);
  };
  const required = [...new Set([options.result, ...(options.required ?? [])])];
  required.forEach(requireMember); required.forEach(walk);
  if (visited.size !== nodes.length) throw new Error("Graph contains unused nodes; connect them to the result or declare them required.");
  const capabilities = new Set<string>(["graph.serial@1", "graph.bindings@1"]);
  for (const item of nodes) {
    const data = graphNodeDetails(item);
    capabilities.add(`graph.${data.kind}@1`);
    graphFailureBoundaryCapabilitiesV1(item).forEach((capability) => capabilities.add(capability));
    for (const body of bodies(data)) body.capabilities.forEach((capability) => capabilities.add(capability));
  }
  const result = Object.freeze({ schemaVersion: 1 as const, kind: "graph-definition" as const,
    id: options.id, definitionVersion: options.definitionVersion, input: options.input, output: options.result.outputContract,
    nodes: Object.freeze(nodes), entry: options.entry, result: options.result, required: Object.freeze(required),
    capabilities: Object.freeze([...capabilities].sort()),
    declarationSha256: hashJson({ id: options.id, version: options.definitionVersion, input: contractRecord(options.input),
      nodes: nodes.map(nodeRecord).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), entry: options.entry.id,
      result: options.result.id, required: required.map((item) => item.id).sort() }),
  });
  definitions.add(result);
  return result;
}

/** Declaration only: deliberately has no execute() until the host adapter exists. */
export function defineWorkflow<I extends JsonValue, O extends JsonValue>(options: Omit<GraphDefinitionOptionsV1<I, O>, "id" | "definitionVersion"> & {
  readonly workflow: WorkflowIdentity;
  readonly workflowContractVersion: string;
  readonly resultKind: string;
  readonly scheduling?: "serial";
  readonly invocationEntries?: readonly GraphInvocationEntryDeclarationV1[];
}): GraphWorkflowV1<I, O> {
  exact(options, ["workflow", "workflowContractVersion", "resultKind", "input", "nodes", "entry", "result"], ["required", "scheduling", "invocationEntries"]);
  if (options.scheduling !== undefined && options.scheduling !== "serial") throw new Error("Unsupported graph scheduling policy; Local V2 supports serial only.");
  const workflow = Object.freeze(validateWorkflowIdentity(options.workflow));
  assertDurableIdentifier(options.workflowContractVersion, "Workflow contract version");
  assertDurableIdentifier(options.resultKind, "Workflow result kind");
  const graph = defineGraph({ id: workflow.kind, definitionVersion: options.workflowContractVersion,
    input: options.input, nodes: options.nodes, entry: options.entry, result: options.result,
    ...(options.required ? { required: options.required } : {}) });
  const invocationEntries = options.invocationEntries === undefined
    ? undefined
    : normalizeInvocationEntries(graph, options.invocationEntries);
  const result = Object.freeze({ ...graph, workflow, workflowContractVersion: options.workflowContractVersion,
    resultKind: options.resultKind, scheduling: "serial" as const,
    ...(invocationEntries ? { invocationEntries } : {}),
    declarationSha256: hashJson({ graph: graph.declarationSha256, workflow, resultKind: options.resultKind, scheduling: "serial",
      ...(invocationEntries ? { invocationEntries: invocationEntries as unknown as JsonValue } : {}) }),
  });
  definitions.add(result);
  return result;
}

function normalizeInvocationEntries(graph: GraphDefinitionV1,
  values: readonly GraphInvocationEntryDeclarationV1[]): readonly GraphInvocationEntryDeclarationV1[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error("Workflow invocation entries must be a nonempty array.");
  const ids = new Set<string>();
  const entries = values.map((value) => {
    assertExactKeys(value as unknown as Record<string, unknown>, ["id", "label", "entry"], "Workflow invocation entry");
    assertDurableIdentifier(value.id, "Workflow invocation entry ID");
    if (ids.has(value.id)) throw new Error(`Duplicate workflow invocation entry ID ${value.id}.`);
    ids.add(value.id);
    if (typeof value.label !== "string" || value.label.trim() !== value.label || value.label.length === 0 || value.label.length > 200) {
      throw new Error("Workflow invocation entry label must be 1 to 200 trimmed characters.");
    }
    if (!value.entry || typeof value.entry !== "object") throw new Error("Workflow invocation entry selection must be an object.");
    if (value.entry.kind === "default") {
      assertExactKeys(value.entry as unknown as Record<string, unknown>, ["kind"], "Workflow invocation entry selection");
      return Object.freeze({ id: value.id, label: value.label, entry: Object.freeze({ kind: "default" as const }) });
    }
    if (value.entry.kind !== "selected") throw new Error("Workflow invocation entry selection.kind must be default or selected.");
    assertExactKeys(value.entry as unknown as Record<string, unknown>, ["kind", "address"], "Workflow invocation entry selection");
    const address = validateGraphInstanceAddressStructureV1(graph, value.entry.address) as GraphInstanceAddressV1;
    return Object.freeze({ id: value.id, label: value.label,
      entry: Object.freeze({ kind: "selected" as const, address }) });
  });
  return Object.freeze(entries);
}

export function assertGraphCapabilitiesV1(graph: GraphDefinitionV1, supported: readonly string[]): void {
  requireDefinition(graph);
  const missing = graph.capabilities.filter((capability) => !supported.includes(capability));
  if (missing.length) throw new Error(`Unsupported graph capabilities: ${missing.join(", ")}.`);
}
export function graphDependenciesV1(graph: GraphDefinitionV1, node: GraphNodeV1): readonly GraphNodeV1[] {
  requireDefinition(graph);
  if (!graph.nodes.includes(node)) throw new Error("Node is outside this graph scope.");
  const data = graphNodeDetails(node), refs = new Set<GraphReferenceNodeV1<JsonValue, JsonValue>>(data.after);
  visitBinding(data.binding, (ref) => refs.add(ref));
  return Object.freeze([...refs] as GraphNodeV1[]);
}
function visitBinding(value: GraphBindingV1<JsonValue>, visit: (node: GraphReferenceNodeV1<JsonValue, JsonValue>) => void): void {
  const expression = graphBindingExpression(value);
  switch (expression.kind) {
    case "node-input": case "node-output": visit(expression.node); break;
    case "field": visitBinding(expression.source, visit); break;
    case "object": Object.values(expression.fields).forEach((item) => visitBinding(item, visit)); break;
    case "array": expression.items.forEach((item) => visitBinding(item, visit)); break;
  }
}
function requireDefinition(value: GraphDefinitionV1): void {
  if (!value || !definitions.has(value)) throw new Error("Use defineGraph or defineWorkflow for graph bodies.");
}
function requireContract(value: GraphValueContractV1<JsonValue>): void {
  if (!value || !contracts.has(value)) throw new Error("Use defineGraphValue for graph value contracts.");
}
function bodies(value: GraphNodeDetailsV1): readonly GraphDefinitionV1[] {
  return value.kind === "step" ? [] : value.kind === "choice" ? Object.values(value.cases) : [value.body];
}
function exact(value: object, required: string[], optional: string[] = []): void {
  assertExactKeys(value as Record<string, unknown>, required, "Graph declaration", [...required, ...optional]);
}
function contractRecord(value: GraphValueContractV1<JsonValue>): JsonValue {
  return { version: value.version, schema: value.schema as JsonValue };
}
function bindingRecord(value: GraphBindingV1<JsonValue>): JsonValue {
  const expression = graphBindingExpression(value);
  switch (expression.kind) {
    case "literal": return { kind: expression.kind, value: expression.value as JsonValue };
    case "scope-input": return { kind: expression.kind };
    case "node-input": case "node-output": return { kind: expression.kind, node: expression.node.id };
    case "field": return { kind: expression.kind, source: bindingRecord(expression.source), key: expression.key,
      ...(Object.hasOwn(expression, "fallback") ? { fallback: expression.fallback as JsonValue } : {}) };
    case "object": return { kind: expression.kind, fields: Object.fromEntries(Object.entries(expression.fields).map(([key, item]) => [key, bindingRecord(item)])) };
    case "array": return { kind: expression.kind, items: expression.items.map(bindingRecord) };
  }
}
function nodeRecord(value: GraphNodeV1): { id: string; [key: string]: JsonValue } {
  const data = graphNodeDetails(value);
  return { id: value.id, kind: value.kind, input: contractRecord(value.inputContract), output: contractRecord(value.outputContract),
    binding: bindingRecord(data.binding), after: data.after.map((item) => item.id).sort(),
    failureBoundaries: graphFailureBoundaryRecordV1(value),
    ...(data.kind === "step" ? { definition: { id: data.step.id, version: data.step.definitionVersion } }
      : data.kind === "choice" ? { selectionVersion: data.selectionVersion,
        cases: Object.fromEntries(Object.entries(data.cases).map(([key, body]) => [key, body.declarationSha256])) }
      : { body: data.body.declarationSha256, ...(data.kind === "loop" ? { conditionVersion: data.conditionVersion } : {}) }),
  };
}
function checkSchemaReferences(schema: Readonly<Record<string, JsonValue>>): void {
  const walk = (value: JsonValue) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      for (const name of ["$ref", "$dynamicRef", "$recursiveRef"]) {
        if (Object.hasOwn(value, name)) {
          const ref = value[name];
          if (typeof ref !== "string" || !ref.startsWith("#")) throw new Error("Graph schemas must be self-contained; external references are not supported.");
        }
      }
    }
    Object.values(value).forEach(walk);
  };
  walk(schema as JsonValue);
}

/** Ignore non-wire metadata such as Zod's non-enumerable ~standard helpers. */
function schemaWireValue(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (active.has(value)) throw new Error("Graph schema must not contain object cycles; use a local $ref.");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Graph schema must use plain objects.");
  active.add(value);
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, descriptor]) => descriptor.enumerable);
  const values = entries.map(([key, descriptor]) => {
    if (!Object.hasOwn(descriptor, "value")) throw new Error("Graph schema must not contain accessors.");
    return [key, schemaWireValue(descriptor.value, active)] as const;
  });
  active.delete(value);
  if (Array.isArray(value)) {
    if (values.length !== value.length || values.some(([key], index) => key !== String(index))) throw new Error("Graph schema arrays must be dense.");
    return values.map(([, item]) => item);
  }
  return Object.fromEntries(values);
}
