import type { ExecutionHostContextV1, StepCheckpointV1 } from "./durableExecution.ts";
import {
  defineStep,
  hashJson,
  immutableJson,
  type DeepReadonly,
  type JsonValue,
  type StepDefinitionV1,
  type ValueValidatorV1,
} from "./durableWorkflow.ts";
import { DurableWorkflowEngineV2 } from "./durableWorkflowEngine.ts";
import { graphFailureBoundariesV1, type GraphFailureBoundaryV1 } from "./graphFailureBoundary.ts";
import { resolveGraphCleanupOutcomeV1, selectGraphFailureActionV1, validateGraphCleanupRecordV1,
  validateGraphFailureEnvelopeV1, validateGraphRecoveryRecordV1,
  type GraphFailureEnvelopeV1, type GraphOriginalOutcomeV1 } from "./graphFailurePolicy.ts";
import { resolveGraphBindingV1 } from "./graphBindings.ts";
import { graphInstanceKeyV1, type GraphInstanceAddressV1, type GraphInstanceSegmentV1 } from "./graphInstance.ts";
import {
  restoreGraphEntryPlanV1,
  validateGraphEntryBoundaryV1,
  type GraphEntryBoundaryV1,
  type GraphEntryPlanV1,
} from "./graphInvocation.ts";
import { inputWaitJsonSnapshot } from "./inputWait.ts";
import {
  assertGraphCapabilitiesV1,
  graphDependenciesV1,
  graphNodeDetails,
  type GraphDefinitionV1,
  type GraphNodeV1,
  type GraphWorkflowV1,
} from "./graphWorkflow.ts";
import { assertExactKeys } from "../domain/validation.ts";

const supportedCapabilities = Object.freeze([
  "graph.bindings@1",
  "graph.catch.after-retry@1",
  "graph.catch.recovery-output@1",
  "graph.choice@1",
  "graph.cleanup.once-per-scope-outcome@1",
  "graph.cleanup.outcome-trigger@1",
  "graph.failure-envelope@1",
  "graph.loop@1",
  "graph.map@1",
  "graph.reduce@1",
  "graph.retry.loop-instance@1",
  "graph.retry.loop-iteration@1",
  "graph.retry.map-instance@1",
  "graph.retry.map-item@1",
  "graph.retry.node-instance@1",
  "graph.retry.reduce-instance@1",
  "graph.retry.reduce-iteration@1",
  "graph.retry.subgraph-instance@1",
  "graph.serial@1",
  "graph.step@1",
  "graph.subgraph@1",
]);

export interface DurableGraphSchedulerV1Options {
  /** The accepted durable engine remains the only leaf execution engine. */
  readonly engine: DurableWorkflowEngineV2;
}

export interface DurableGraphExecutionV1<Input extends JsonValue, Output extends JsonValue> {
  readonly graph: GraphWorkflowV1<Input, Output>;
  readonly host: ExecutionHostContextV1;
  readonly input: DeepReadonly<Input>;
}

export interface DurableGraphEntryExecutionV1<Input extends JsonValue, Output extends JsonValue> {
  readonly graph: GraphWorkflowV1<Input, Output>;
  readonly host: ExecutionHostContextV1;
  readonly plan: GraphEntryPlanV1;
  readonly boundary: GraphEntryBoundaryV1;
}

type CompletedNodeValue = { readonly input?: JsonValue; readonly output?: JsonValue };
type ScopeExecutionOptions = {
  readonly activeNodeIds?: readonly string[];
  readonly scopeInput?: DeepReadonly<JsonValue>;
  readonly scopeInputValidated?: boolean;
  readonly directEntry?: { readonly nodeId: string; readonly input: DeepReadonly<JsonValue> };
  readonly completed?: ReadonlyMap<string, CompletedNodeValue>;
};

type SelectedFrame = {
  readonly parent: GraphDefinitionV1;
  readonly parentScopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[];
  readonly node: GraphNodeV1;
  readonly occurrence: NonNullable<DeepReadonly<GraphInstanceSegmentV1>["occurrence"]>;
  readonly address: DeepReadonly<GraphInstanceAddressV1>;
};

type RetryTarget = {
  readonly stepInstanceId: string;
  readonly step: StepDefinitionV1<JsonValue, JsonValue>;
  readonly input: DeepReadonly<JsonValue>;
  readonly checkpoint: StepCheckpointV1;
};

type ControlRetryAdmission = {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly scopeAddress: GraphInstanceAddressV1;
  readonly scopeAttempt: number;
  readonly failureId: string;
  readonly target: {
    readonly stepInstanceId: string;
    readonly fromAttempt: number;
  };
};

type ControlRetryState = {
  readonly policy: GraphFailureBoundaryV1["retries"][number];
  readonly currentAttempt: number;
  readonly latest?: ControlRetryAdmission;
};

class GraphExecutionFailure extends Error {
  readonly original: unknown;
  readonly outcome: GraphOriginalOutcomeV1 | "outcome-unknown";
  readonly retryTarget?: RetryTarget;

  constructor(original: unknown, outcome: GraphOriginalOutcomeV1 | "outcome-unknown", retryTarget?: RetryTarget) {
    super(errorMessage(original), { cause: original });
    this.name = "GraphExecutionFailure";
    this.original = original;
    this.outcome = outcome;
    this.retryTarget = retryTarget;
  }
}

/** Serial graph scheduling adapter. It plans graph/control instances, while the
 * existing durable engine owns every executable checkpoint and external call. */
export class DurableGraphSchedulerV1 {
  readonly #engine: DurableWorkflowEngineV2;

  constructor(options: DurableGraphSchedulerV1Options) {
    this.#engine = options.engine;
  }

  async execute<Input extends JsonValue, Output extends JsonValue>(
    execution: DurableGraphExecutionV1<Input, Output>,
  ): Promise<DeepReadonly<Output>> {
    assertGraphCapabilitiesV1(execution.graph, supportedCapabilities);
    const input = immutableJson(execution.graph.input.validator.parse(execution.input), "Graph workflow input");
    try {
      const output = await this.#executeScope(execution.graph, execution.graph, execution.host, input, []);
      return immutableJson(execution.graph.output.validator.parse(output), "Graph workflow output");
    } catch (error) {
      throw originalGraphError(error);
    }
  }

  /** Executes an already accepted supplied/deferred boundary. The scheduler
   * never creates checkpoints for caller-supplied skipped history. */
  async executeEntry<Input extends JsonValue, Output extends JsonValue>(
    execution: DurableGraphEntryExecutionV1<Input, Output>,
  ): Promise<DeepReadonly<Output>> {
    assertGraphCapabilitiesV1(execution.graph, supportedCapabilities);
    const plan = restoreGraphEntryPlanV1(execution.graph, execution.plan);
    const boundary = validateGraphEntryBoundaryV1(plan, execution.boundary);
    try {
      if (plan.entryKind === "default") {
        const input = boundaryValue(boundary, "entry");
        const output = await this.#executeScope(execution.graph, execution.graph, execution.host, input, []);
        return immutableJson(execution.graph.output.validator.parse(output), "Graph workflow output");
      }

      const resolved = resolveSelectedAddress(execution.graph, plan.entry);
      const selectedScope = continuationFor(plan, resolved.scopePath);
      const selectedCompleted = skippedValuesForScope(plan, boundary, resolved.scopePath);
      const selectedScopeInput = scopeInputFor(resolved.frames, plan, boundary, resolved.scopePath);
      let resume = () => this.#executeScope(execution.graph, resolved.scope, execution.host,
        selectedScopeInput, resolved.scopePath, {
          activeNodeIds: selectedScope.nodeIds,
          scopeInput: selectedScopeInput,
          scopeInputValidated: resolved.scopePath.length === 0,
          directEntry: { nodeId: resolved.node.id, input: boundaryValue(boundary, "entry") },
          completed: selectedCompleted,
        });

      // Rebuild the selected path from the inside out. Each enclosing control
      // owns its occurrence/instance policies, then its parent continuation.
      // Caller-supplied skipped values remain in memory at every layer.
      for (let index = resolved.frames.length - 1; index >= 0; index--) {
        const frame = resolved.frames[index];
        const selectedBody = resume;
        const controlInput = controlBoundaryValue(plan, boundary, frame.address, "control-input");
        const selectedBodyInput = scopeInputFor(resolved.frames, plan, boundary, frame.address.path);
        resume = async () => {
          const controlOutput = await this.#continueSelectedControl(execution.graph, execution.host, frame,
            controlInput, selectedBodyInput, selectedBody, plan, boundary);
          const parentContinuation = continuationFor(plan, frame.parentScopePath);
          const parentCompleted = skippedValuesForScope(plan, boundary, frame.parentScopePath);
          parentCompleted.set(frame.node.id, { input: controlInput as JsonValue, output: controlOutput as JsonValue });
          const parentScopeInput = scopeInputFor(resolved.frames, plan, boundary, frame.parentScopePath);
          return this.#executeScope(execution.graph, frame.parent, execution.host,
            parentScopeInput, frame.parentScopePath, {
            activeNodeIds: parentContinuation.nodeIds,
            scopeInput: parentScopeInput,
            scopeInputValidated: frame.parentScopePath.length === 0,
            completed: parentCompleted,
          });
        };
      }
      const output = await resume();
      return immutableJson(execution.graph.output.validator.parse(output), "Graph workflow output");
    } catch (error) {
      throw originalGraphError(error);
    }
  }

  async #executeScope(
    root: GraphWorkflowV1,
    graph: GraphDefinitionV1,
    host: ExecutionHostContextV1,
    input: DeepReadonly<JsonValue>,
    scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[],
    options: ScopeExecutionOptions = {},
  ): Promise<DeepReadonly<JsonValue>> {
    const scopeInput = options.scopeInput === undefined || !options.scopeInputValidated
      ? immutableJson(graph.input.validator.parse(options.scopeInput ?? input), `Graph ${graph.id} input`)
      : options.scopeInput;
    const completed = new Map<string, CompletedNodeValue>(options.completed ?? []);
    const active = options.activeNodeIds
      ? options.activeNodeIds.map(id => {
          const node = graph.nodes.find(candidate => candidate.id === id);
          if (!node) throw new Error(`Graph continuation contains unknown node ${id}.`);
          return node;
        })
      : [...graph.nodes];
    const pending = new Set(active.filter(node => !completed.has(node.id)));

    const run = async (node: GraphNodeV1, directInput?: DeepReadonly<JsonValue>): Promise<void> => {
      const boundInput = directInput ?? resolveGraphBindingV1(graphNodeDetails(node).binding, {
        input: scopeInput as JsonValue, completed,
      });
      const nodeInput = immutableJson(node.inputContract.validator.parse(boundInput), `Graph node ${node.id} input`);
      const output = await this.#executeNode(root, graph, node, host, nodeInput, scopePath);
      completed.set(node.id, {
        input: nodeInput as JsonValue,
        output: immutableJson(node.outputContract.validator.parse(output)) as JsonValue,
      });
      pending.delete(node);
    };

    if (options.directEntry) {
      const origin = graph.nodes.find(node => node.id === options.directEntry?.nodeId);
      if (!origin || !pending.has(origin)) throw new Error("Selected graph entry is outside its continuation scope.");
      await run(origin, options.directEntry.input);
    } else if (!options.activeNodeIds) {
      // Entry is an explicit semantic root. Array position is never scheduling policy.
      await run(graph.entry);
    }
    while (pending.size > 0) {
      const ready = [...pending]
        .filter((node) => graphDependenciesV1(graph, node).every((dependency) => completed.has(dependency.id)))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      if (ready.length === 0) throw new Error(`Graph ${graph.id} has no ready node.`);
      await run(ready[0]);
    }
    const result = completed.get(graph.result.id);
    if (!result) throw new Error(`Graph ${graph.id} did not produce its result node.`);
    return immutableJson(graph.output.validator.parse(result.output), `Graph ${graph.id} output`);
  }

  async #continueSelectedControl(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    frame: SelectedFrame,
    input: DeepReadonly<JsonValue>,
    selectedBodyInput: DeepReadonly<JsonValue>,
    selectedBody: () => Promise<DeepReadonly<JsonValue>>,
    plan: GraphEntryPlanV1,
    boundary: GraphEntryBoundaryV1,
  ): Promise<DeepReadonly<JsonValue>> {
    const data = graphNodeDetails(frame.node);
    const address = nodeAddress(frame.parentScopePath, frame.node.id);
    const instanceScope = controlInstanceScope(data.kind);
    const instanceBoundary = instanceScope === undefined ? undefined
      : graphFailureBoundariesV1(frame.node).find(candidate => candidate.scope === instanceScope);
    return this.#executeFailureBoundary(root, host, address, input, instanceBoundary,
      frame.node.outputContract.validator, async () => {
        let output: DeepReadonly<JsonValue>;
        if (data.kind === "map" && frame.occurrence.kind === "map") {
          const itemBoundary = graphFailureBoundariesV1(frame.node).find(candidate => candidate.scope === "map-item");
          const selectedOutput = await this.#executeFailureBoundary(root, host, frame.address, selectedBodyInput,
            itemBoundary, data.body.output.validator, selectedBody);
          const value = mapInput(input, frame.node.id);
          const prior = controlBoundaryValue(plan, boundary, frame.address, "map-completed-outputs");
          if (!Array.isArray(prior)) throw new Error("Selected map progress must be an output array.");
          const outputs: JsonValue[] = [...prior, selectedOutput as JsonValue];
          for (let index = frame.occurrence.index + 1; index < value.items.length; index++) {
            const itemInput = immutableJson({ item: value.items[index], index, context: value.context });
            const itemAddress = controlOccurrenceAddress(frame.parentScopePath, frame.node.id, { kind: "map", index });
            outputs.push(await this.#executeFailureBoundary(root, host, itemAddress, itemInput, itemBoundary,
              data.body.output.validator, () => this.#executeScope(root, data.body, host, itemInput,
                [...frame.parentScopePath, { nodeId: frame.node.id, occurrence: { kind: "map", index } }])) as JsonValue);
          }
          output = immutableJson(outputs);
        } else if (data.kind === "reduce" && frame.occurrence.kind === "reduce") {
          const iterationBoundary = graphFailureBoundariesV1(frame.node).find(candidate => candidate.scope === "reduce-iteration");
          let accumulator = await this.#executeFailureBoundary(root, host, frame.address, selectedBodyInput,
            iterationBoundary, data.body.output.validator, selectedBody);
          const value = reduceInput(input, frame.node.id);
          for (let index = frame.occurrence.index + 1; index < value.items.length; index++) {
            const iterationInput = immutableJson({ item: value.items[index], index,
              accumulator: accumulator as JsonValue, context: value.context });
            const iterationAddress = controlOccurrenceAddress(frame.parentScopePath, frame.node.id, { kind: "reduce", index });
            accumulator = await this.#executeFailureBoundary(root, host, iterationAddress, iterationInput, iterationBoundary,
              data.body.output.validator, () => this.#executeScope(root, data.body, host, iterationInput,
                [...frame.parentScopePath, { nodeId: frame.node.id, occurrence: { kind: "reduce", index } }]));
          }
          output = accumulator;
        } else if (data.kind === "loop" && frame.occurrence.kind === "loop" && "while" in data) {
          const iterationBoundary = graphFailureBoundariesV1(frame.node).find(candidate => candidate.scope === "loop-iteration");
          let state = await this.#executeFailureBoundary(root, host, frame.address, selectedBodyInput,
            iterationBoundary, data.body.output.validator, selectedBody);
          const value = loopInput(input, frame.node.id);
          let iteration = frame.occurrence.iteration + 1;
          while (await this.#durableControlValue(root, host, address, `loop-condition-${iteration}`,
            { state, iteration, context: value.context }, booleanValue,
            conditionInput => data.while(conditionInput))) {
            const iterationInput = immutableJson({ state: state as JsonValue, iteration, context: value.context });
            const iterationAddress = controlOccurrenceAddress(frame.parentScopePath, frame.node.id, { kind: "loop", iteration });
            state = await this.#executeFailureBoundary(root, host, iterationAddress, iterationInput, iterationBoundary,
              data.body.output.validator, () => this.#executeScope(root, data.body, host, iterationInput,
                [...frame.parentScopePath, { nodeId: frame.node.id, occurrence: { kind: "loop", iteration } }]));
            iteration++;
          }
          output = state;
        } else if (data.kind === "subgraph" || (data.kind === "choice" && frame.occurrence.kind === "choice")) {
          output = await selectedBody();
        } else if (data.kind === "choice") {
          throw new Error("Selected choice occurrence is invalid.");
        } else {
          throw new Error("A selected control frame cannot be a step.");
        }
        return this.#durableControlValue(root, host, address,
          `selected-${data.kind}-${hashJson(frame.occurrence as unknown as JsonValue)}-output`,
          { input: input as JsonValue, output: output as JsonValue }, frame.node.outputContract.validator,
          value => (value as { output: JsonValue }).output);
      });
  }

  async #executeNode(
    root: GraphWorkflowV1,
    graph: GraphDefinitionV1,
    node: GraphNodeV1,
    host: ExecutionHostContextV1,
    input: DeepReadonly<JsonValue>,
    scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[],
  ): Promise<DeepReadonly<JsonValue>> {
    const address = nodeAddress(scopePath, node.id);
    const data = graphNodeDetails(node);
    if (data.kind === "step") {
      const stepInstanceId = graphExecutionCheckpointIdV1(root, address, "step");
      const execution = { workflowContractVersion: root.workflowContractVersion, host,
        stepInstanceId, step: data.step, input };
      const boundary = graphFailureBoundariesV1(node).find(candidate => candidate.scope === "node-instance");
      let retry: { readonly policyId: string; readonly expectedAttempt: number } | undefined;
      const selected = new Set<string>();
      while (true) {
        let completed: Awaited<ReturnType<DurableWorkflowEngineV2["executeStepInstance"]>>;
        try {
          completed = retry
            ? await this.#engine.retryStepInstance({ ...execution, ...retry })
            : await this.#engine.executeStepInstance(execution);
        } catch (error) {
          const checkpoint = await this.#engine.readStepInstance(host.runRef, stepInstanceId);
          if (!checkpoint?.terminal) throw error;
          const retryTarget: RetryTarget = { stepInstanceId, step: data.step, input, checkpoint };
          if (checkpoint.state === "CANCELLED") {
            const original = cancelledOutcome(checkpoint);
            const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
              original, checkpoint.terminal.at);
            if (cleanupError) throw cleanupError;
            throw new GraphExecutionFailure(error, original, retryTarget);
          }
          if (checkpoint.state !== "FAILED") {
            throw new GraphExecutionFailure(error, "outcome-unknown", retryTarget);
          }
          const failure = graphFailure(root, address, checkpoint);
          if (boundary) {
            const action = selectGraphFailureActionV1(root, failure,
              boundary.retries.map(policy => ({ policy, scopeAddress: address as GraphInstanceAddressV1,
                currentAttempt: checkpoint.attemptCount })), boundary.catches.map(candidate => ({
                policy: candidate.policy, scopeAddress: address as GraphInstanceAddressV1,
              })));
            if (action.kind === "catch") {
              let recovered: { readonly output: DeepReadonly<JsonValue>; readonly recoveredAt: string } | undefined;
              try {
                recovered = await this.#recoverCaughtFailure(root, host, address, input, failure, boundary, action.policyId);
              } catch (recoveryError) {
                await this.#cleanupAfterCatchFailure(root, host, address, input, failure, boundary, action.policyId, recoveryError);
              }
              if (!recovered) throw new Error("Graph catch handler completed without a recovery output.");
              const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
                { status: "succeeded" }, recovered.recoveredAt);
              if (cleanupError) throw cleanupError;
              return recovered.output;
            }
            if (action.kind === "retry") {
              const selection = `${action.policyId}:${checkpoint.attemptCount}`;
              if (selected.has(selection)) throw error;
              selected.add(selection);
              retry = { policyId: action.policyId, expectedAttempt: checkpoint.attemptCount };
              continue;
            }
            const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
              { status: "failed", failure }, failure.occurredAt);
            if (cleanupError) throw cleanupError;
          }
          throw new GraphExecutionFailure(error, { status: "failed", failure }, retryTarget);
        }
        const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
          { status: "succeeded" }, completed.execution.completedAt);
        if (cleanupError) throw cleanupError;
        return completed.output;
      }
    }

    const instanceScope = controlInstanceScope(data.kind);
    const instanceBoundary = instanceScope === undefined ? undefined
      : graphFailureBoundariesV1(node).find(candidate => candidate.scope === instanceScope);
    return this.#executeFailureBoundary(root, host, address, input, instanceBoundary,
      node.outputContract.validator, async () => {
        let output: DeepReadonly<JsonValue>;
        if (data.kind === "subgraph") {
          output = await this.#executeScope(root, data.body, host, input,
            [...scopePath, { nodeId: node.id, occurrence: { kind: "subgraph" } }]);
        } else if (data.kind === "choice") {
          const selected = await this.#durableControlValue(root, host, address, "choice-selection", input, stringValue,
            () => {
              const result = data.select(input);
              if (typeof result !== "string" || !Object.hasOwn(data.cases, result)) {
                throw new Error(`Choice ${node.id} selected an undeclared case.`);
              }
              return result;
            });
          output = await this.#executeScope(root, data.cases[selected], host, input,
            [...scopePath, { nodeId: node.id, occurrence: { kind: "choice", case: selected } }]);
        } else if (data.kind === "map") {
          const value = mapInput(input, node.id);
          const itemBoundary = graphFailureBoundariesV1(node).find(candidate => candidate.scope === "map-item");
          const outputs: JsonValue[] = [];
          for (let index = 0; index < value.items.length; index++) {
            const itemInput = immutableJson({ item: value.items[index], index, context: value.context });
            const itemAddress = controlOccurrenceAddress(scopePath, node.id, { kind: "map", index });
            outputs.push(await this.#executeFailureBoundary(root, host, itemAddress, itemInput, itemBoundary,
              data.body.output.validator, () => this.#executeScope(root, data.body, host, itemInput,
                [...scopePath, { nodeId: node.id, occurrence: { kind: "map", index } }])) as JsonValue);
          }
          output = immutableJson(outputs);
        } else if (data.kind === "reduce") {
          const value = reduceInput(input, node.id);
          const iterationBoundary = graphFailureBoundariesV1(node).find(candidate => candidate.scope === "reduce-iteration");
          let accumulator: DeepReadonly<JsonValue> = immutableJson(value.initial);
          for (let index = 0; index < value.items.length; index++) {
            const iterationInput = immutableJson({ item: value.items[index], index,
              accumulator: accumulator as JsonValue, context: value.context });
            const iterationAddress = controlOccurrenceAddress(scopePath, node.id, { kind: "reduce", index });
            accumulator = await this.#executeFailureBoundary(root, host, iterationAddress, iterationInput, iterationBoundary,
              data.body.output.validator, () => this.#executeScope(root, data.body, host, iterationInput,
                [...scopePath, { nodeId: node.id, occurrence: { kind: "reduce", index } }]));
          }
          output = accumulator;
        } else {
          if (data.kind !== "loop" || !("while" in data)) throw new Error(`Unsupported graph node kind ${data.kind}.`);
          const value = loopInput(input, node.id);
          const iterationBoundary = graphFailureBoundariesV1(node).find(candidate => candidate.scope === "loop-iteration");
          let state: DeepReadonly<JsonValue> = immutableJson(value.state);
          let iteration = 0;
          while (await this.#durableControlValue(root, host, address, `loop-condition-${iteration}`,
            { state, iteration, context: value.context }, booleanValue,
            (conditionInput) => data.while(conditionInput))) {
            const iterationInput = immutableJson({ state: state as JsonValue, iteration, context: value.context });
            const iterationAddress = controlOccurrenceAddress(scopePath, node.id, { kind: "loop", iteration });
            state = await this.#executeFailureBoundary(root, host, iterationAddress, iterationInput, iterationBoundary,
              data.body.output.validator, () => this.#executeScope(root, data.body, host, iterationInput,
                [...scopePath, { nodeId: node.id, occurrence: { kind: "loop", iteration } }]));
            iteration++;
          }
          output = state;
        }

        return this.#durableControlValue(root, host, address, `${data.kind}-output`,
          { input: input as JsonValue, output: output as JsonValue }, node.outputContract.validator,
          value => (value as { output: JsonValue }).output);
      });
  }

  async #executeFailureBoundary(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    address: DeepReadonly<GraphInstanceAddressV1>,
    input: DeepReadonly<JsonValue>,
    boundary: GraphFailureBoundaryV1 | undefined,
    outputValidator: ValueValidatorV1<JsonValue>,
    execute: () => Promise<DeepReadonly<JsonValue>>,
  ): Promise<DeepReadonly<JsonValue>> {
    if (!boundary) return execute();
    let completion: { readonly output: DeepReadonly<JsonValue>; readonly recoveredAt?: string } | undefined;
    while (!completion) {
      try {
        completion = { output: await execute() };
      } catch (error) {
        if (!(error instanceof GraphExecutionFailure)) throw error;
        if (error.outcome === "outcome-unknown") throw error;
        if (error.outcome.status === "cancelled") {
          const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
            error.outcome, failureOutcomeAt(error));
          if (cleanupError) throw cleanupError;
          throw error;
        }
        if (error.outcome.status !== "failed") throw error;
        const retryStates = await Promise.all(boundary.retries.map(policy =>
          this.#controlRetryState(root, host, address, policy)));
        // A committed scope marker may precede the leaf admission. Resume that
        // exact admission before selecting another policy or consuming another
        // scope attempt.
        const pending = retryStates.find(state => state.latest
          && controlRetryMatchesFailure(state.latest, error));
        if (pending?.latest) {
          await this.#retryControlFailure(root, host, pending.latest, error);
          continue;
        }
        const action = selectGraphFailureActionV1(root, error.outcome.failure,
          retryStates.map(state => ({ policy: state.policy, scopeAddress: address as GraphInstanceAddressV1,
            currentAttempt: state.currentAttempt })), boundary.catches.map(candidate => ({
            policy: candidate.policy, scopeAddress: address as GraphInstanceAddressV1,
          })));
        if (action.kind === "retry") {
          const target = error.retryTarget;
          if (!target) throw new Error("Graph control retry requires an exact failed leaf checkpoint.");
          const admission = controlRetryAdmission(action.policyId, address, action.nextAttempt,
            error.outcome.failure.failureId,
            { stepInstanceId: target.stepInstanceId, fromAttempt: target.checkpoint.attemptCount });
          const retained = await this.#durableValue(root, host, address,
            controlRetryAction(action.policyId, action.nextAttempt), admission, jsonValue, () => admission);
          const validated = validateControlRetryAdmission(retained, action.policyId, address, action.nextAttempt);
          await this.#retryControlFailure(root, host, validated, error);
          continue;
        }
        if (action.kind === "catch") {
          try {
            const recovered = await this.#recoverCaughtFailure(root, host, address, input,
              error.outcome.failure, boundary, action.policyId);
            completion = { output: outputValidator.parse(recovered.output), recoveredAt: recovered.recoveredAt };
          } catch (recoveryError) {
            await this.#cleanupAfterCatchFailure(root, host, address, input, error.outcome.failure,
              boundary, action.policyId, recoveryError);
          }
        } else {
          const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
            error.outcome, error.outcome.failure.occurredAt);
          if (cleanupError) throw cleanupError;
          throw error;
        }
      }
    }
    let { output, recoveredAt } = completion;
    if (boundary.cleanup.some(candidate => candidate.policy.triggers.includes("success"))) {
      if (!recoveredAt) {
        const completed = await this.#durableValueCompletion(root, host, address,
          `boundary-${boundary.scope}-success`, { input: input as JsonValue, output: output as JsonValue },
          outputValidator, value => (value as { output: JsonValue }).output);
        output = completed.output;
        recoveredAt = completed.execution.completedAt;
      }
      const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
        { status: "succeeded" }, recoveredAt);
      if (cleanupError) throw cleanupError;
    }
    return output;
  }

  async #controlRetryState(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    address: DeepReadonly<GraphInstanceAddressV1>,
    policy: GraphFailureBoundaryV1["retries"][number],
  ): Promise<ControlRetryState> {
    let currentAttempt = 1;
    let latest: ControlRetryAdmission | undefined;
    // Scope attempts are separate stable checkpoints. Counting leaf attempts
    // would reset the budget when a later leaf fails in the same control scope.
    for (let scopeAttempt = 2; scopeAttempt <= policy.maxAttempts; scopeAttempt++) {
      const checkpoint = await this.#engine.readStepInstance(host.runRef,
        graphExecutionCheckpointIdV1(root, address, controlRetryAction(policy.policyId, scopeAttempt)));
      if (!checkpoint || checkpoint.state !== "COMPLETED" || !checkpoint.completed) break;
      latest = validateControlRetryAdmission(checkpoint.completed.output, policy.policyId, address, scopeAttempt);
      currentAttempt = scopeAttempt;
    }
    return { policy, currentAttempt, ...(latest ? { latest } : {}) };
  }

  async #retryControlFailure(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    admission: ControlRetryAdmission,
    error: GraphExecutionFailure,
  ): Promise<void> {
    const target = error.retryTarget;
    if (!target || !controlRetryMatchesFailure(admission, error)) {
      throw new Error("Graph control retry admission differs from the failed leaf checkpoint.");
    }
    try {
      await this.#engine.retryStepInstance({
        workflowContractVersion: root.workflowContractVersion,
        host,
        stepInstanceId: target.stepInstanceId,
        step: target.step,
        input: target.input,
        policyId: admission.policyId,
        expectedAttempt: admission.target.fromAttempt,
      });
    } catch (retryError) {
      const checkpoint = await this.#engine.readStepInstance(host.runRef, target.stepInstanceId);
      if (checkpoint?.terminal && checkpoint.attemptCount === admission.target.fromAttempt + 1) return;
      throw retryError;
    }
  }

  async #durableValue<Input extends JsonValue, Output extends JsonValue>(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    address: DeepReadonly<GraphInstanceAddressV1>,
    action: string,
    input: DeepReadonly<Input>,
    output: ValueValidatorV1<Output>,
    execute: (input: DeepReadonly<Input>) => Output | Promise<Output>,
  ): Promise<DeepReadonly<Output>> {
    return (await this.#durableValueCompletion(root, host, address, action, input, output, execute)).output;
  }

  async #durableControlValue<Input extends JsonValue, Output extends JsonValue>(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    address: DeepReadonly<GraphInstanceAddressV1>,
    action: string,
    input: DeepReadonly<Input>,
    output: ValueValidatorV1<Output>,
    execute: (input: DeepReadonly<Input>) => Output | Promise<Output>,
  ): Promise<DeepReadonly<Output>> {
    return (await this.#durableValueCompletion(root, host, address, action, input, output, execute, true)).output;
  }

  async #durableValueCompletion<Input extends JsonValue, Output extends JsonValue>(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    address: DeepReadonly<GraphInstanceAddressV1>,
    action: string,
    input: DeepReadonly<Input>,
    output: ValueValidatorV1<Output>,
    execute: (input: DeepReadonly<Input>) => Output | Promise<Output>,
    captureFailure = false,
  ) {
    const step: StepDefinitionV1<Input, Output> = defineStep({
      schemaVersion: 1,
      id: "graph-control",
      definitionVersion: "1",
      input: jsonValue as ValueValidatorV1<Input>,
      output,
      execute: async (_context, value) => execute(value),
    });
    const stepInstanceId = graphExecutionCheckpointIdV1(root, address, action);
    try {
      return await this.#engine.executeStepInstance({
        workflowContractVersion: root.workflowContractVersion,
        host,
        stepInstanceId,
        step,
        input,
      });
    } catch (error) {
      if (!captureFailure) throw error;
      const checkpoint = await this.#engine.readStepInstance(host.runRef, stepInstanceId);
      if (!checkpoint?.terminal) throw error;
      const retryTarget: RetryTarget = { stepInstanceId, step: step as StepDefinitionV1<JsonValue, JsonValue>,
        input, checkpoint };
      if (checkpoint.state === "CANCELLED") {
        throw new GraphExecutionFailure(error, cancelledOutcome(checkpoint), retryTarget);
      }
      if (checkpoint.state === "FAILED") {
        const failure = graphFailure(root, address, checkpoint);
        throw new GraphExecutionFailure(error, { status: "failed", failure }, retryTarget);
      }
      throw new GraphExecutionFailure(error, "outcome-unknown", retryTarget);
    }
  }

  async #recoverCaughtFailure(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    address: DeepReadonly<GraphInstanceAddressV1>,
    input: DeepReadonly<JsonValue>,
    failure: GraphFailureEnvelopeV1,
    boundary: GraphFailureBoundaryV1,
    policyId: string,
  ): Promise<{ readonly output: DeepReadonly<JsonValue>; readonly recoveredAt: string }> {
    const candidate = boundary.catches.find(item => item.policy.policyId === policyId);
    if (!candidate) throw new Error(`Graph catch policy ${policyId} has no attached handler.`);
    const handlerInput = inputWaitJsonSnapshot({ failure, scope: { address, input } });
    const completed = await this.#engine.executeStepInstance({
      workflowContractVersion: root.workflowContractVersion,
      host,
      stepInstanceId: graphExecutionCheckpointIdV1(root, address, `catch-${policyId}-handler`),
      step: candidate.handler,
      input: handlerInput,
    });
    const record = inputWaitJsonSnapshot({
      schemaVersion: 1,
      status: "recovered",
      policyId,
      originalFailure: failure,
      output: completed.output,
      recoveredAt: completed.execution.completedAt,
    });
    const retained = await this.#durableValue(root, host, address, `catch-${policyId}-recovery`,
      record, jsonValue, () => record);
    const recovered = validateGraphRecoveryRecordV1(root, candidate.policy, retained);
    return { output: recovered.output, recoveredAt: recovered.recoveredAt };
  }

  async #cleanupAfterCatchFailure(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    address: DeepReadonly<GraphInstanceAddressV1>,
    input: DeepReadonly<JsonValue>,
    originalFailure: GraphFailureEnvelopeV1,
    boundary: GraphFailureBoundaryV1,
    policyId: string,
    error: unknown,
  ): Promise<never> {
    const candidate = boundary.catches.find(item => item.policy.policyId === policyId);
    if (!candidate) throw error;
    const handlerInput = inputWaitJsonSnapshot({ failure: originalFailure, scope: { address, input } });
    const handlerId = graphExecutionCheckpointIdV1(root, address, `catch-${policyId}-handler`);
    const checkpoint = await this.#engine.readStepInstance(host.runRef, handlerId);
    if (!checkpoint?.terminal) throw error;
    if (checkpoint.state === "FAILED") {
      const failure = graphFailure(root, address, checkpoint);
      const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
        { status: "failed", failure }, failure.occurredAt);
      if (cleanupError) throw cleanupError;
      throw new GraphExecutionFailure(error, { status: "failed", failure }, {
        stepInstanceId: handlerId, step: candidate.handler, input: handlerInput, checkpoint,
      });
    } else if (checkpoint.state === "CANCELLED") {
      const original = cancelledOutcome(checkpoint);
      const cleanupError = await this.#runCleanup(root, host, address, input, boundary,
        original, checkpoint.terminal.at);
      if (cleanupError) throw cleanupError;
      throw new GraphExecutionFailure(error, original, {
        stepInstanceId: handlerId, step: candidate.handler, input: handlerInput, checkpoint,
      });
    }
    throw new GraphExecutionFailure(error, "outcome-unknown", {
      stepInstanceId: handlerId, step: candidate.handler, input: handlerInput, checkpoint,
    });
  }

  async #runCleanup(
    root: GraphWorkflowV1,
    host: ExecutionHostContextV1,
    address: DeepReadonly<GraphInstanceAddressV1>,
    input: DeepReadonly<JsonValue>,
    boundary: GraphFailureBoundaryV1 | undefined,
    original: GraphOriginalOutcomeV1,
    outcomeAt: string,
  ): Promise<unknown | undefined> {
    if (!boundary) return undefined;
    const trigger = cleanupTrigger(original);
    // Cleanup is declared finalization work. It may consume the reserved tail
    // after ordinary work stops, including after cancellation is already won.
    const cleanupHost: ExecutionHostContextV1 = {
      ...host,
      finalizationReserveMs: 0,
      cancellation: { aborted: false },
    };
    let affectingError: unknown | undefined;
    // The V2 runtime keeps one active leaf. Run every matching cleanup even if
    // an earlier record says its failure will make the Run fail.
    for (const candidate of boundary.cleanup) {
      if (!candidate.policy.triggers.includes(trigger)) continue;
      const scopeOutcomeId = `scope-outcome-${hashJson({ schemaVersion: 1,
        declarationSha256: root.declarationSha256, address, original, outcomeAt })}`;
      const action = `cleanup-${candidate.policy.policyId}`;
      const handlerInput = inputWaitJsonSnapshot({ scope: { address, input }, original });
      let cleanup: DeepReadonly<JsonValue>;
      let handlerError: unknown | undefined;
      let handlerFailure: GraphFailureEnvelopeV1 | undefined;
      let handlerCheckpoint: StepCheckpointV1 | undefined;
      try {
        const completed = await this.#engine.executeStepInstance({
          workflowContractVersion: root.workflowContractVersion,
          host: cleanupHost,
          stepInstanceId: graphExecutionCheckpointIdV1(root, address, `${action}-handler`),
          step: candidate.handler,
          input: handlerInput,
        });
        cleanup = inputWaitJsonSnapshot({ status: "completed", completedAt: completed.execution.completedAt });
      } catch (error) {
        const handlerId = graphExecutionCheckpointIdV1(root, address, `${action}-handler`);
        const checkpoint = await this.#engine.readStepInstance(host.runRef, handlerId);
        if (!checkpoint?.terminal) throw error;
        // An ambiguous cleanup effect is not a known cleanup failure. Keep its
        // OUTCOME_UNKNOWN checkpoint authoritative and do not mint a definitive
        // cleanup record that could hide or replay the external effect.
        if (checkpoint.state === "OUTCOME_UNKNOWN") throw error;
        handlerError = error;
        handlerCheckpoint = checkpoint;
        handlerFailure = graphFailure(root, address, checkpoint,
          checkpoint.state === "FAILED" ? "workflow" : "platform");
        cleanup = inputWaitJsonSnapshot({ status: "failed", failure: handlerFailure });
      }
      const record = inputWaitJsonSnapshot({ schemaVersion: 1, policyId: candidate.policy.policyId,
        scopeOutcomeId, scopeAddress: address, original, cleanup });
      const retained = await this.#durableValue(root, cleanupHost, address, `${action}-record`,
        record, jsonValue, () => record);
      const validated = validateGraphCleanupRecordV1(root, candidate.policy, retained);
      const resolution = resolveGraphCleanupOutcomeV1(candidate.policy, validated);
      if (resolution.cleanupFailureAffectsRun && affectingError === undefined && handlerFailure && handlerCheckpoint) {
        affectingError = new GraphExecutionFailure(handlerError, { status: "failed", failure: handlerFailure }, {
          stepInstanceId: graphExecutionCheckpointIdV1(root, address, `${action}-handler`),
          step: candidate.handler, input: handlerInput, checkpoint: handlerCheckpoint,
        });
      }
    }
    return affectingError;
  }
}

function graphFailure(graph: GraphWorkflowV1, address: DeepReadonly<GraphInstanceAddressV1>,
  checkpoint: NonNullable<Awaited<ReturnType<DurableWorkflowEngineV2["readStepInstance"]>>>,
  fallbackClass: GraphFailureEnvelopeV1["class"] = "workflow"): GraphFailureEnvelopeV1 {
  const terminal = checkpoint.terminal!;
  const externalDiagnostic = terminal.externalDiagnostic;
  return validateGraphFailureEnvelopeV1(graph, {
    schemaVersion: 1,
    failureId: `failure-${hashJson({ schemaVersion: 1, ref: checkpoint.ref, address,
      attempt: checkpoint.attemptCount, terminal })}`,
    class: externalDiagnostic ? "external-provider" : fallbackClass,
    code: terminal.code,
    message: terminal.message,
    retryability: terminal.retryability ?? "unknown",
    instance: { address, attempt: checkpoint.attemptCount },
    occurredAt: terminal.at,
    ...(externalDiagnostic ? { externalDiagnostic } : {}),
  });
}

function cancelledOutcome(checkpoint: StepCheckpointV1): Extract<GraphOriginalOutcomeV1, { readonly status: "cancelled" }> {
  const reason = checkpoint.terminal?.code;
  if (reason !== "cancelled" && reason !== "deadline_exceeded" && reason !== "host_terminated") {
    throw new Error("Cancelled graph step has an invalid terminal reason.");
  }
  return { status: "cancelled", reason };
}

function cleanupTrigger(original: GraphOriginalOutcomeV1): "success" | "failure" | "cancellation" {
  if (original.status === "succeeded") return "success";
  if (original.status === "failed") return "failure";
  return "cancellation";
}

function originalGraphError(error: unknown): unknown {
  return error instanceof GraphExecutionFailure ? error.original : error;
}

function failureOutcomeAt(error: GraphExecutionFailure): string {
  if (error.outcome !== "outcome-unknown" && error.outcome.status === "failed") {
    return error.outcome.failure.occurredAt;
  }
  const at = error.retryTarget?.checkpoint.terminal?.at;
  if (!at) throw new Error("Graph execution failure has no durable outcome time.");
  return at;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Graph execution failed.";
}

function controlRetryAction(policyId: string, scopeAttempt: number): string {
  return `control-retry-${policyId}-scope-attempt-${scopeAttempt}`;
}

function controlRetryAdmission(
  policyId: string,
  scopeAddress: DeepReadonly<GraphInstanceAddressV1>,
  scopeAttempt: number,
  failureId: string,
  target: ControlRetryAdmission["target"],
): ControlRetryAdmission {
  return Object.freeze({
    schemaVersion: 1,
    policyId,
    scopeAddress: scopeAddress as GraphInstanceAddressV1,
    scopeAttempt,
    failureId,
    target: Object.freeze({ stepInstanceId: target.stepInstanceId, fromAttempt: target.fromAttempt }),
  });
}

function validateControlRetryAdmission(
  value: unknown,
  policyId: string,
  scopeAddress: DeepReadonly<GraphInstanceAddressV1>,
  scopeAttempt: number,
): ControlRetryAdmission {
  const admission = record(inputWaitJsonSnapshot(value), "Graph control retry admission");
  assertExactKeys(admission, ["schemaVersion", "policyId", "scopeAddress", "scopeAttempt", "failureId", "target"],
    "Graph control retry admission");
  if (admission.schemaVersion !== 1 || admission.policyId !== policyId || admission.scopeAttempt !== scopeAttempt
    || JSON.stringify(admission.scopeAddress) !== JSON.stringify(scopeAddress)) {
    throw new Error("Graph control retry admission differs from its retained scope attempt.");
  }
  if (typeof admission.failureId !== "string" || admission.failureId.length === 0) {
    throw new Error("Graph control retry admission requires a failure ID.");
  }
  const target = record(admission.target as DeepReadonly<JsonValue>, "Graph control retry target");
  assertExactKeys(target, ["stepInstanceId", "fromAttempt"], "Graph control retry target");
  if (typeof target.stepInstanceId !== "string" || target.stepInstanceId.length === 0
    || !Number.isSafeInteger(target.fromAttempt) || (target.fromAttempt as number) <= 0) {
    throw new Error("Graph control retry target is invalid.");
  }
  return controlRetryAdmission(policyId, scopeAddress, scopeAttempt, admission.failureId,
    { stepInstanceId: target.stepInstanceId, fromAttempt: target.fromAttempt as number });
}

function controlRetryMatchesFailure(admission: ControlRetryAdmission, error: GraphExecutionFailure): boolean {
  return error.outcome !== "outcome-unknown" && error.outcome.status === "failed"
    && admission.failureId === error.outcome.failure.failureId
    && admission.target.stepInstanceId === error.retryTarget?.stepInstanceId
    && admission.target.fromAttempt === error.retryTarget?.checkpoint.attemptCount;
}

function controlInstanceScope(kind: GraphNodeV1["kind"]): GraphFailureBoundaryV1["scope"] | undefined {
  if (kind === "subgraph") return "subgraph-instance";
  if (kind === "map") return "map-instance";
  if (kind === "reduce") return "reduce-instance";
  if (kind === "loop") return "loop-instance";
  return undefined;
}

/** A durable checkpoint ID covers the retained declaration, full scoped address
 * and scheduler action. Retry attempt is intentionally absent. */
export function graphExecutionCheckpointIdV1(
  graph: GraphWorkflowV1,
  address: GraphInstanceAddressV1 | DeepReadonly<GraphInstanceAddressV1>,
  action: string,
): string {
  const instanceKey = graphInstanceKeyV1(graph, { executionId: "identity" }, address);
  return `graph-${hashJson({ schemaVersion: 1, declarationSha256: graph.declarationSha256, instanceKey, action })}`;
}

function nodeAddress(scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[], nodeId: string): DeepReadonly<GraphInstanceAddressV1> {
  return immutableJson({ schemaVersion: 1, path: [...scopePath, { nodeId }] }) as DeepReadonly<GraphInstanceAddressV1>;
}

function controlOccurrenceAddress(
  scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[],
  nodeId: string,
  occurrence: NonNullable<GraphInstanceSegmentV1["occurrence"]>,
): DeepReadonly<GraphInstanceAddressV1> {
  return immutableJson({ schemaVersion: 1, path: [...scopePath, { nodeId, occurrence }] }) as DeepReadonly<GraphInstanceAddressV1>;
}

const jsonValue: ValueValidatorV1<JsonValue> = { parse(value) { return immutableJson(value as JsonValue) as JsonValue; } };
const stringValue: ValueValidatorV1<string> = { parse(value) {
  if (typeof value !== "string") throw new Error("Expected a string.");
  return value;
} };
const booleanValue: ValueValidatorV1<boolean> = { parse(value) {
  if (typeof value !== "boolean") throw new Error("Expected a Boolean.");
  return value;
} };

function record(value: DeepReadonly<JsonValue>, label: string): Readonly<Record<string, JsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Readonly<Record<string, JsonValue>>;
}
function mapInput(value: DeepReadonly<JsonValue>, nodeId: string): { readonly items: readonly JsonValue[]; readonly context: JsonValue } {
  const input = record(value, `Map ${nodeId} input`);
  if (!Array.isArray(input.items) || !Object.hasOwn(input, "context")) throw new Error(`Map ${nodeId} input is invalid.`);
  return { items: input.items, context: input.context };
}
function reduceInput(value: DeepReadonly<JsonValue>, nodeId: string): {
  readonly items: readonly JsonValue[]; readonly initial: JsonValue; readonly context: JsonValue;
} {
  const input = record(value, `Reduce ${nodeId} input`);
  if (!Array.isArray(input.items) || !Object.hasOwn(input, "initial") || !Object.hasOwn(input, "context")) {
    throw new Error(`Reduce ${nodeId} input is invalid.`);
  }
  return { items: input.items, initial: input.initial, context: input.context };
}
function loopInput(value: DeepReadonly<JsonValue>, nodeId: string): { readonly state: JsonValue; readonly context: JsonValue } {
  const input = record(value, `Loop ${nodeId} input`);
  if (!Object.hasOwn(input, "state") || !Object.hasOwn(input, "context")) throw new Error(`Loop ${nodeId} input is invalid.`);
  return { state: input.state, context: input.context };
}

function boundaryValue(boundary: GraphEntryBoundaryV1, id: string): DeepReadonly<JsonValue> {
  if (!Object.hasOwn(boundary.values, id)) throw new Error(`Graph entry boundary is missing ${id}.`);
  return boundary.values[id];
}

function resolveSelectedAddress(graph: GraphWorkflowV1, address: DeepReadonly<GraphInstanceAddressV1>): {
  readonly scope: GraphDefinitionV1;
  readonly scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[];
  readonly node: GraphNodeV1;
  readonly frames: readonly SelectedFrame[];
} {
  let scope: GraphDefinitionV1 = graph;
  const scopePath: DeepReadonly<GraphInstanceSegmentV1>[] = [];
  const frames: SelectedFrame[] = [];
  for (const segment of address.path) {
    const node = scope.nodes.find(candidate => candidate.id === segment.nodeId);
    if (!node) throw new Error("Selected graph entry is outside its declared scope.");
    if (!segment.occurrence) return { scope, scopePath: Object.freeze([...scopePath]), node, frames: Object.freeze(frames) };
    const data = graphNodeDetails(node);
    const frameAddress = immutableJson({ schemaVersion: 1, path: [...scopePath, segment] }) as DeepReadonly<GraphInstanceAddressV1>;
    frames.push({ parent: scope, parentScopePath: Object.freeze([...scopePath]), node, occurrence: segment.occurrence, address: frameAddress });
    scopePath.push(segment);
    if (data.kind === "choice" && segment.occurrence.kind === "choice") scope = data.cases[segment.occurrence.case];
    else if (data.kind !== "step" && data.kind !== "choice") scope = data.body;
    else throw new Error("Selected graph entry occurrence does not match its control.");
  }
  throw new Error("Selected graph entry has no target node.");
}

function continuationFor(plan: GraphEntryPlanV1, scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[]) {
  const continuation = plan.continuation.find(candidate => samePath(candidate.scopePath, scopePath));
  if (!continuation) throw new Error("Graph entry plan has no continuation for its selected scope.");
  return continuation;
}

function skippedValuesForScope(
  plan: GraphEntryPlanV1,
  boundary: GraphEntryBoundaryV1,
  scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[],
): Map<string, CompletedNodeValue> {
  const completed = new Map<string, CompletedNodeValue>();
  for (const requirement of plan.requirements) {
    if ((requirement.role !== "skipped-node-input" && requirement.role !== "skipped-node-output") || !requirement.address) continue;
    const targetPath = requirement.address.path;
    if (targetPath.length !== scopePath.length + 1 || !samePath(targetPath.slice(0, -1), scopePath)) continue;
    const target = targetPath.at(-1)!;
    if (target.occurrence) throw new Error("Skipped graph node values must target a node, not a control occurrence.");
    const current = completed.get(target.nodeId) ?? {};
    completed.set(target.nodeId, requirement.role === "skipped-node-input"
      ? { ...current, input: boundaryValue(boundary, requirement.id) as JsonValue }
      : { ...current, output: boundaryValue(boundary, requirement.id) as JsonValue });
  }
  return completed;
}

function scopeInputFor(
  frames: readonly SelectedFrame[],
  plan: GraphEntryPlanV1,
  boundary: GraphEntryBoundaryV1,
  scopePath: readonly DeepReadonly<GraphInstanceSegmentV1>[],
): DeepReadonly<JsonValue> {
  if (scopePath.length === 0) {
    const root = plan.requirements.find(requirement => requirement.role === "root-scope-input");
    return root ? boundaryValue(boundary, root.id) : null;
  }
  const frame = frames.find(candidate => samePath(candidate.address.path, scopePath));
  if (!frame) throw new Error("Graph entry plan has no enclosing control for its scope.");
  const input = controlBoundaryValue(plan, boundary, frame.address, "control-input");
  const data = graphNodeDetails(frame.node);
  if (data.kind === "subgraph" || data.kind === "choice") return input;
  if (data.kind === "map" && frame.occurrence.kind === "map") {
    const value = mapInput(input, frame.node.id);
    return immutableJson({ item: value.items[frame.occurrence.index], index: frame.occurrence.index, context: value.context });
  }
  if (data.kind === "reduce" && frame.occurrence.kind === "reduce") {
    const value = reduceInput(input, frame.node.id);
    const accumulator = controlBoundaryValue(plan, boundary, frame.address, "reduce-accumulator");
    return immutableJson({ item: value.items[frame.occurrence.index], index: frame.occurrence.index,
      accumulator: accumulator as JsonValue, context: value.context });
  }
  if (data.kind === "loop" && frame.occurrence.kind === "loop") {
    const value = loopInput(input, frame.node.id);
    const iteration = controlBoundaryValue(plan, boundary, frame.address, "loop-iteration");
    return immutableJson({ state: value.state, iteration: iteration as JsonValue, context: value.context });
  }
  throw new Error("Graph entry control occurrence does not match its declaration.");
}

function controlBoundaryValue(
  plan: GraphEntryPlanV1,
  boundary: GraphEntryBoundaryV1,
  address: DeepReadonly<GraphInstanceAddressV1>,
  role: "control-input" | "map-completed-outputs" | "reduce-accumulator" | "loop-iteration",
): DeepReadonly<JsonValue> {
  const requirement = plan.requirements.find(candidate => candidate.role === role
    && candidate.address !== undefined && samePath(candidate.address.path, address.path));
  if (!requirement) throw new Error(`Graph entry boundary has no ${role} for the selected control.`);
  return boundaryValue(boundary, requirement.id);
}

function samePath(
  left: readonly DeepReadonly<GraphInstanceSegmentV1>[],
  right: readonly DeepReadonly<GraphInstanceSegmentV1>[],
): boolean {
  return hashJson(left as unknown as JsonValue) === hashJson(right as unknown as JsonValue);
}
