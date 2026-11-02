/** Private child-process entry point. Never run user workflow code in the API process. */
import { DurableWorkflowEngineV3 } from "../../core/src/application/durableInputWorkflowEngine.ts";
import { DurableWorkflowEngineV2, type DurableEffectOperationExecutorV1 } from "../../core/src/application/durableWorkflowEngine.ts";
import { validateWorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { ExternalProviderError, getExternalErrorDiagnostic, getFailureRetryability,
  readExternalErrorDiagnostic, readFailureRetryability } from "../../core/src/application/externalError.ts";
import { immutableJson, type DurableAgentBindingV1, type DurableAgentOperationExecutorV1, type JsonValue } from "../../core/src/application/durableWorkflow.ts";
import { constructionDescriptorSchema, constructRetainedGraphWorkflow, constructRetainedWorkflow } from "../../core/src/application/retainedWorkflowConstruction.ts";
import { constructRetainedGraphDefinition } from "../../core/src/application/retainedWorkflowConstruction.ts";
import { admitGraphInvocationV1, describeGraphEntryV1, validateGraphEntryBoundaryV1 } from "../../core/src/application/graphInvocation.ts";
import { describeGraphV1, describeGraphEntryPresentationV1 } from "../../core/src/application/graphPresentation.ts";
import { graphInstanceNodeV1 } from "../../core/src/application/graphInstance.ts";
import { graphNodeDetails, type GraphNodeV1 } from "../../core/src/application/graphWorkflow.ts";
import { createGraphAcceptedBoundaryV1, createGraphEntryRequestV1, createGraphRunInvocationV1 } from "../../core/src/application/graphInvocationRecords.ts";
import { executeRetainedGraphWorkflowV1 } from "../../core/src/application/retainedGraphWorkflow.ts";
import { restoreRetainedGraphInputV1, validateRetainedGraphInputV1 } from "../../core/src/application/retainedGraphInput.ts";
import type { ExecutionHostContextV1 } from "../../core/src/application/durableExecution.ts";
import type { RetainedOwnerV1 } from "../../core/src/application/retainedExecution.ts";
import { FileAgentOperationStoreV1, FileEffectOperationStoreV1, FileStepCheckpointStoreV2, FileDurableExecutionEventSinkV1 } from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";
import { RetainedAnswerRejected, validateRetainedAnswer } from "./retainedInputValidation.ts";
import * as inspector from "node:inspector";
import { createHeadlessDebugActivity } from "./headlessDebugActivity.ts";
import { readDiagnosticClock } from "./diagnosticExecutionClock.ts";
import { createHeadlessFixedReader } from "./headlessFixedReader.ts";
import { serializeError } from "./localFrameworkDiagnostics.ts";
import { isExcludedFrameworkError } from "../../core/src/application/frameworkErrors.ts";
import { observeFrameworkStorage } from "./localFrameworkStorageObserver.ts";

// Capture pristine built-ins before any retained project module can execute.
const fixedInspection = createHeadlessFixedReader();

interface ConstructionPayload {
  code: string;
  construction: unknown;
  runConfiguration: JsonValue;
  assets: Record<string, Uint8Array>;
}
type StartMessage = ConstructionPayload & {
  kind: "start"; storageRoot: string; owner: RetainedOwnerV1;
  host: Omit<ExecutionHostContextV1, "heartbeat" | "cancellation">;
  debug?: { clockPath: string; activityPath: string; mock?: never }
    | { mock: true; activityPath: string; clockPath?: never };
} & (
  | { executionKind: "workflow"; invocation: unknown; graphInput?: never }
  | { executionKind: "graph"; graphInput: unknown; invocation?: never }
);
interface ValidationMessage extends ConstructionPayload {
  kind: "validate-construction"; agentSlotIds: string[];
  invocation: unknown;
}
interface PrepareGraphMessage extends ConstructionPayload {
  kind: "prepare-graph-invocation";
  request: unknown;
  identity: {
    runRef: unknown;
    runConfiguration: unknown;
    executableBindingId: string;
    buildSha256: string;
    createdAt: string;
    requestId: string;
  };
  agentSlotIds: string[];
}
interface DescribeGraphMessage extends ConstructionPayload {
  kind: "describe-graph-invocation";
  agentSlotIds: string[];
}
interface ValidateGraphBoundaryMessage extends ConstructionPayload {
  kind: "validate-graph-boundary";
  graphInput: unknown;
  boundary: unknown;
}
class GraphPreparationRejected extends Error {
  constructor(readonly code: "invalid-construction" | "invalid-input" | "invalid-binding" | "slot-mismatch") { super(code); }
}
type ResponseValidationMessage = ConstructionPayload & { invocation: unknown }
  & Omit<Parameters<typeof validateRetainedAnswer>[0], "constructed" | "invocation"> & { kind: "validate-response" };
let sequence = 0, started = false, cancelled = false, debugConnected = false;
const reportedErrors = new WeakSet<Error>();
function reportWorkerFrameworkError(error: unknown): void {
  try {
    if (debugConnected || isExcludedFrameworkError(error)) return;
    if (error instanceof Error) {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    process.send?.({ kind: "framework-diagnostic", frameworkDiagnostic: serializeError(error) }, () => {});
  } catch { /* Reporting cannot replace a worker outcome. */ }
}
const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function call<T>(method: string, args: unknown[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    calls.set(id, { resolve: value => resolve(value as T), reject });
    process.send?.({ kind: "call", id, method, args }, error => { if (error) { calls.delete(id); reject(new Error("Host connection closed.")); } });
  });
}
process.on("message", message => {
  const value = message as Record<string, unknown>;
  if (value.kind === "reply") {
    const pending = calls.get(value.id as number); if (!pending) return;
    calls.delete(value.id as number);
    if (value.ok) pending.resolve(value.value);
    else {
      const diagnostic = readExternalErrorDiagnostic(value.externalDiagnostic);
      pending.reject(diagnostic ? new ExternalProviderError(diagnostic.provider, diagnostic.message, {
        code: diagnostic.code, httpStatus: diagnostic.httpStatus,
        retryability: readFailureRetryability(value.retryability),
      }) : new Error("Host operation failed."));
    }
  } else if (value.kind === "cancel") cancelled = true;
  else if (value.kind === "debug-connect" && !started && !debugConnected) {
    debugConnected = true;
    // Endpoint travels only over the owned IPC channel, never protocol stdout.
    inspector.open(0, "127.0.0.1", false);
    process.send?.({ kind: "debug-endpoint", endpoint: inspector.url() });
  }
  else if (value.kind === "validate-response" && !started) {
    started = true;
    const payload = message as ResponseValidationMessage;
    void loadConstruction(payload).then(constructed => validateRetainedAnswer({ ...payload, constructed,
      invocation: validateWorkflowInvocationV1(payload.invocation) })).then(
      response => process.send?.({ kind: "response-valid", response }),
      error => process.send?.({ kind: "response-invalid", code: error instanceof RetainedAnswerRejected ? "invalid-response" : "validation-unavailable" }),
    );
  }
  else if (value.kind === "validate-construction" && !started) {
    started = true;
    void validateConstruction(message as ValidationMessage).then(result => process.send?.(result), () => process.send?.({ kind: "construction-invalid", code: "invalid-construction" }));
  }
  else if (value.kind === "prepare-graph-invocation" && !started) {
    started = true;
    void prepareGraphInvocation(message as PrepareGraphMessage).then(
      graphInput => process.send?.({ kind: "graph-invocation-valid", graphInput }),
      error => process.send?.({ kind: "construction-invalid",
        code: error instanceof GraphPreparationRejected ? error.code : "invalid-construction" }),
    );
  }
  else if (value.kind === "describe-graph-invocation" && !started) {
    started = true;
    void describeGraphInvocation(message as DescribeGraphMessage).then(
      description => process.send?.({ kind: "graph-invocation-described", ...description }),
      error => process.send?.({ kind: "construction-invalid",
        code: error instanceof GraphPreparationRejected ? error.code : "invalid-construction" }),
    );
  }
  else if (value.kind === "validate-graph-boundary" && !started) {
    started = true;
    void validateGraphBoundary(message as ValidateGraphBoundaryMessage).then(
      boundary => process.send?.({ kind: "graph-boundary-valid", boundary }),
      () => process.send?.({ kind: "graph-boundary-invalid" }),
    );
  }
  else if (value.kind === "start" && !started) {
    started = true;
    void execute(message as StartMessage).then(result => process.send?.({ kind: "result", result }), error => {
      const externalDiagnostic = getExternalErrorDiagnostic(error);
      reportWorkerFrameworkError(error);
      process.send?.({ kind: "error", retryability: getFailureRetryability(error),
        ...(externalDiagnostic ? { externalDiagnostic } : {}) });
    });
  }
});
process.on("disconnect", () => process.exit(1));

async function execute(message: StartMessage) {
  if (!!message.debug !== debugConnected) throw new Error("Debugger handshake does not match execution.");
  if (message.debug) {
    arkimuxHeadlessReaderGate(fixedInspection.reader, fixedInspection.entry);
    fixedInspection.block(message); fixedInspection.block(message.host);
  }
  const activity = message.debug ? createHeadlessDebugActivity(message.debug.activityPath, message.owner) : undefined;
  try { return await executeRetained(message, activity); }
  finally { activity?.close(); }
}

/** This stop precedes all project imports. Only trusted helper handles exist in
 * its local scope; the controller pins them without inspecting project values. */
function arkimuxHeadlessReaderGate(privateReader: unknown, privateEntry: unknown) {
  debugger;
  void privateReader; void privateEntry;
}

/** A trusted internal stop lets the controller obtain the execute function's
 * inspector handle without evaluating any caller expression. This is not the
 * user-visible entry stop; the controller installs a function breakpoint. */
function arkimuxHeadlessEntryGate(workflowExecute: unknown) {
  debugger;
  void workflowExecute;
}

async function executeRetained(message: StartMessage, activity?: ReturnType<typeof createHeadlessDebugActivity>) {
  if (message.executionKind === "graph") return executeRetainedGraph(message, activity);
  return executeRetainedWorkflow(message, activity);
}

async function executeRetainedWorkflow(message: Extract<StartMessage, { executionKind: "workflow" }>, activity?: ReturnType<typeof createHeadlessDebugActivity>) {
  const invocation = validateWorkflowInvocationV1(message.invocation);
  const constructed = await (activity ? activity.workflow(() => loadConstruction(message)) : loadConstruction(message));
  const definition = constructed.workflow;
  const input = immutableJson(activity ? await activity.operation(() => definition.input.parse(invocation.input))
    : definition.input.parse(invocation.input), "Retained workflow input");
  const agents = await call<Record<string, DurableAgentBindingV1>>("agents.prepare", [constructed.agentPrompts]);
  const engine = new DurableWorkflowEngineV3({
    storage: durableStorage(message.storageRoot),
    input: { read: () => call("input.read"), openRequest: (_ref, _owner, options) => call("input.open", [options]),
      completeInput: (_ref, _owner, requestId) => call("input.complete", [requestId]) },
    agents: retainedAgents(agents),
    ...(message.debug?.mock === true || constructionDescriptorSchema.parse(message.construction).schemaVersion === 2
      ? { effects: retainedHostEffects() }
      : {}),
  });
  const host = hostContext(message, activity);
  if (message.debug) { fixedInspection.block(host); fixedInspection.block(engine); }
  if (message.debug) arkimuxHeadlessEntryGate(definition.execute);
  return engine.execute({ workflowContractVersion: invocation.workflowContractVersion, host, owner: message.owner,
    execute: async context => {
      if (message.debug) fixedInspection.block(context);
      const result = await (activity ? activity.workflow(() => definition.execute(context, input)) : definition.execute(context, input));
      return activity ? activity.operation(() => definition.output.parse(result)) : definition.output.parse(result);
    } });
}

async function executeRetainedGraph(message: Extract<StartMessage, { executionKind: "graph" }>, activity?: ReturnType<typeof createHeadlessDebugActivity>) {
  const stored = validateRetainedGraphInputV1(message.graphInput);
  const module = await import(`data:text/javascript;base64,${Buffer.from(message.code).toString("base64")}`) as Record<string, unknown>;
  const constructed = await (activity ? activity.workflow(() => constructRetainedGraphWorkflow({ module,
    descriptor: message.construction, invocation: stored.invocation,
    runConfiguration: message.runConfiguration, assets: message.assets })) : constructRetainedGraphWorkflow({ module,
    descriptor: message.construction, invocation: stored.invocation,
    runConfiguration: message.runConfiguration, assets: message.assets }));
  const graphInput = restoreRetainedGraphInputV1(constructed.graph, stored);
  if (!graphInput.accepted) throw new Error("Retained graph input has not been accepted.");
  const agents = await call<Record<string, DurableAgentBindingV1>>("agents.prepare", [constructed.agentPrompts]);
  const host = hostContext(message, activity);
  const engine = new DurableWorkflowEngineV2({
    storage: durableStorage(message.storageRoot),
    agents: retainedAgents(agents),
    ...(message.debug?.mock === true || constructionDescriptorSchema.parse(message.construction).schemaVersion === 2
      ? { effects: retainedHostEffects() }
      : {}),
  });
  if (message.debug) fixedInspection.block(engine);
  if (message.debug) arkimuxHeadlessEntryGate(graphDebugEntryTarget(constructed.graph,
    graphInput.invocation.entryPlan.entry));
  const output = await executeRetainedGraphWorkflowV1({ graph: constructed.graph, invocation: graphInput.invocation,
    ...(graphInput.requestState ? { request: graphInput.requestState.request } : {}), accepted: graphInput.accepted,
    host, engine });
  return { status: "completed" as const, output };
}

/** Selects the first project callback reached by the chosen graph entry. The
 * debugger pauses in retained project source, never in scheduler plumbing. */
function graphDebugEntryTarget(graph: Parameters<typeof graphInstanceNodeV1>[0],
  address: Parameters<typeof graphInstanceNodeV1>[1]): unknown {
  return graphNodeDebugTarget(graphInstanceNodeV1(graph, address));
}

function graphNodeDebugTarget(node: GraphNodeV1): unknown {
  const details = graphNodeDetails(node);
  if (details.kind === "step") return details.step.execute;
  if (details.kind === "choice") return details.select;
  if (details.kind === "loop") return details.while;
  return graphNodeDebugTarget(details.body.entry);
}

function durableStorage(root: string) {
  return { steps: observeFrameworkStorage(new FileStepCheckpointStoreV2({ root }), reportWorkerFrameworkError),
    agents: observeFrameworkStorage(new FileAgentOperationStoreV1({ root }), reportWorkerFrameworkError),
    effects: observeFrameworkStorage(new FileEffectOperationStoreV1({ root }), reportWorkerFrameworkError),
    events: observeFrameworkStorage(new FileDurableExecutionEventSinkV1({ root }), reportWorkerFrameworkError) };
}

function retainedAgents(agents: Record<string, DurableAgentBindingV1>): DurableAgentOperationExecutorV1 {
  return {
    resolve: operation => {
      const binding = agents[operation.slotId];
      if (!Object.hasOwn(agents, operation.slotId) || !binding) throw new Error("Run has no binding for this agent slot.");
      return binding;
    },
    invoke: request => call("agent.invoke", [{ stableOperationId: request.stableOperationId, stepId: request.stepId,
      operation: { schemaVersion: request.operation.schemaVersion, operationId: request.operation.operationId, slotId: request.operation.slotId },
      input: inputWaitJsonSnapshot(request.input) }]),
  };
}

function retainedHostEffects(): DurableEffectOperationExecutorV1 {
  return {
    execute<Input extends JsonValue, Output extends JsonValue>(request: Parameters<DurableEffectOperationExecutorV1["execute"]>[0]) {
      return call<Output>("effect.invoke", [{ stableOperationId: request.stableOperationId,
        operationId: request.definition.operationId, definitionVersion: request.definition.definitionVersion,
        safety: request.definition.safety, phase: "execute", input: inputWaitJsonSnapshot(request.input) }]);
    },
    async reconcile<Input extends JsonValue, Output extends JsonValue>(request: Parameters<DurableEffectOperationExecutorV1["reconcile"]>[0]) {
      return call("effect.invoke", [{ stableOperationId: request.stableOperationId,
        operationId: request.definition.operationId, definitionVersion: request.definition.definitionVersion,
        safety: request.definition.safety, phase: "reconcile", input: inputWaitJsonSnapshot(request.input) }]);
    },
  };
}

function hostContext(message: StartMessage, activity?: ReturnType<typeof createHeadlessDebugActivity>): ExecutionHostContextV1 {
  const debug = message.debug;
  return { ...message.host,
    ...(debug ? { diagnosticClock: debug.mock ? {
      deadlineAt: () => message.host.deadlineAt,
      remainingMs: () => Math.max(0, Date.parse(message.host.deadlineAt) - Date.now()),
    } : { deadlineAt: () => readDiagnosticClock(debug.clockPath, message.owner).deadlineAt,
      remainingMs: () => readDiagnosticClock(debug.clockPath, message.owner).remainingMs },
      diagnosticExclude: fixedInspection.blockGraph,
      diagnosticActivity: <T>(work: () => T | Promise<T>) => activity!.operation(work) } : {}),
    cancellation: { get aborted() { return cancelled; }, get reason() { return cancelled ? "host_terminated" as const : undefined; } },
    heartbeat: () => call("heartbeat") };
}

async function loadConstruction(message: Extract<StartMessage, { executionKind: "workflow" }> | ValidationMessage | ResponseValidationMessage) {
  const invocation = validateWorkflowInvocationV1(message.invocation);
  const module = await import(`data:text/javascript;base64,${Buffer.from(message.code).toString("base64")}`) as Record<string, unknown>;
  return constructRetainedWorkflow({ module, descriptor: message.construction, invocation,
    runConfiguration: message.runConfiguration, assets: message.assets });
}

async function validateConstruction(message: ValidationMessage) {
  const constructed = await loadConstruction(message);
  try {
    // Do not return this value: storing it would apply transforming validators twice.
    inputWaitJsonSnapshot(constructed.workflow.input.parse(validateWorkflowInvocationV1(message.invocation).input));
  } catch { return { kind: "construction-invalid", code: "invalid-input" }; }
  if (JSON.stringify(Object.keys(constructed.agentPrompts).sort()) !== JSON.stringify([...message.agentSlotIds].sort())) {
    return { kind: "construction-invalid", code: "slot-mismatch" };
  }
  return { kind: "construction-valid" };
}

async function prepareGraphInvocation(message: PrepareGraphMessage) {
  const module = await import(`data:text/javascript;base64,${Buffer.from(message.code).toString("base64")}`) as Record<string, unknown>;
  let constructed;
  try { constructed = await constructRetainedGraphDefinition({ module, descriptor: message.construction,
    runConfiguration: message.runConfiguration, assets: message.assets }); }
  catch { throw new GraphPreparationRejected("invalid-construction"); }
  if (JSON.stringify(Object.keys(constructed.agentPrompts).sort()) !== JSON.stringify([...message.agentSlotIds].sort())) {
    throw new GraphPreparationRejected("slot-mismatch");
  }
  let admission;
  try { admission = admitGraphInvocationV1(constructed.graph, message.request); }
  catch { throw new GraphPreparationRejected("invalid-input"); }
  let invocation;
  try { invocation = createGraphRunInvocationV1({ graph: constructed.graph, admission,
    runRef: message.identity.runRef as never, runConfiguration: message.identity.runConfiguration as never,
    executableBindingId: message.identity.executableBindingId, buildSha256: message.identity.buildSha256,
    createdAt: message.identity.createdAt }); }
  catch { throw new GraphPreparationRejected("invalid-binding"); }
  if (admission.acquisition === "supplied") {
    const accepted = createGraphAcceptedBoundaryV1({ graph: constructed.graph, invocation,
      boundary: admission.boundary, acceptanceId: `${message.identity.requestId}-supplied`, acceptedAt: message.identity.createdAt });
    try { return validateRetainedGraphInputV1({ schemaVersion: 1, invocation, accepted }); }
    catch { throw new GraphPreparationRejected("invalid-binding"); }
  }
  try {
    const request = createGraphEntryRequestV1(constructed.graph, invocation, { requestId: message.identity.requestId });
    return validateRetainedGraphInputV1({ schemaVersion: 1, invocation,
    requestState: { schemaVersion: 1, request, revision: 1, status: "pending", updatedAt: message.identity.createdAt } }); }
  catch { throw new GraphPreparationRejected("invalid-binding"); }
}

async function describeGraphInvocation(message: DescribeGraphMessage) {
  const module = await import(`data:text/javascript;base64,${Buffer.from(message.code).toString("base64")}`) as Record<string, unknown>;
  let constructed;
  try { constructed = await constructRetainedGraphDefinition({ module, descriptor: message.construction,
    runConfiguration: message.runConfiguration, assets: message.assets }); }
  catch { throw new GraphPreparationRejected("invalid-construction"); }
  if (JSON.stringify(Object.keys(constructed.agentPrompts).sort()) !== JSON.stringify([...message.agentSlotIds].sort())) {
    throw new GraphPreparationRejected("slot-mismatch");
  }
  const graph = constructed.graph;
  const describe = (id: string, label: string, entry: { kind: "default" } | { kind: "selected"; address: {
    schemaVersion: 1; path: { nodeId: string; occurrence?: { kind: "map" | "reduce"; index: number }
      | { kind: "loop"; iteration: number } | { kind: "choice"; case: string } | { kind: "subgraph" } }[];
  } }) => {
    const plan = describeGraphEntryV1(graph, entry);
    const nodeKind = entry.kind === "default" ? graph.entry.kind : graphInstanceNodeV1(graph, entry.address).kind;
    return inputWaitJsonSnapshot({ id, label, nodeKind, entry, requirements: plan.requirements,
      presentation: describeGraphEntryPresentationV1(graph, entry) });
  };
  if (graph.invocationEntries) {
    return { graph: describeGraphV1(graph), entries: graph.invocationEntries.map(({ id, label, entry }) => describe(id, label, entry)) };
  }
  return { graph: describeGraphV1(graph), entries: [
    describe("default", `${humanizeNodeId(graph.entry.id)} (default)`, { kind: "default" }),
    ...graph.nodes.filter(node => node !== graph.entry).map(node => describe(node.id, humanizeNodeId(node.id),
      { kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: node.id }] } })),
  ] };
}

function humanizeNodeId(value: string): string {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Step";
}

async function validateGraphBoundary(message: ValidateGraphBoundaryMessage) {
  const stored = validateRetainedGraphInputV1(message.graphInput);
  const module = await import(`data:text/javascript;base64,${Buffer.from(message.code).toString("base64")}`) as Record<string, unknown>;
  const constructed = await constructRetainedGraphWorkflow({ module, descriptor: message.construction,
    invocation: stored.invocation,
    runConfiguration: message.runConfiguration, assets: message.assets });
  const restored = restoreRetainedGraphInputV1(constructed.graph, stored);
  return validateGraphEntryBoundaryV1(restored.invocation.entryPlan, message.boundary);
}
