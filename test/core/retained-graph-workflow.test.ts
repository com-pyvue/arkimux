import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  admitGraphInvocationV1,
  createGraphAcceptedBoundaryV1,
  createGraphEntryRequestV1,
  createGraphRunInvocationV1,
  defineGraphValue,
  defineStep,
  defineWorkflow,
  graphRef,
  graphStep,
  graphValue,
  type GraphWorkflowV1,
  type JsonValue,
  validateGraphEntryBoundaryV1,
} from "../../core/src/index.ts";
import type { ExecutionHostContextV1 } from "../../core/src/application/durableExecution.ts";
import { DurableWorkflowEngineV2 } from "../../core/src/application/durableWorkflowEngine.ts";
import { executeRetainedGraphWorkflowV1 } from "../../core/src/application/retainedGraphWorkflow.ts";
import { constructRetainedGraphWorkflow } from "../../core/src/application/retainedWorkflowConstruction.ts";
import {
  FileAgentOperationStoreV1,
  FileDurableExecutionEventSinkV1,
  FileEffectOperationStoreV1,
  FileStepCheckpointStoreV2,
} from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";

const runConfiguration = { configurationId: "config-v1", contentHash: "c".repeat(64) };
const buildSha256 = "b".repeat(64);
const createdAt = "2026-09-18T10:00:00.000Z";
const numberContract = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });

function host(executionId: string, attemptId: string, fence: number): ExecutionHostContextV1 {
  return {
    schemaVersion: 1,
    runRef: { executionId },
    attemptId,
    fence,
    deadlineAt: "2030-01-01T00:00:00.000Z",
    finalizationReserveMs: 1_000,
    scratchDirectory: path.join(tmpdir(), attemptId),
    limits: { maxDurationMs: 60_000, maxScratchBytes: 1_000_000 },
    cancellation: { aborted: false },
    heartbeat: async () => undefined,
  };
}

function engine(root: string): DurableWorkflowEngineV2 {
  return new DurableWorkflowEngineV2({
    storage: {
      steps: new FileStepCheckpointStoreV2({ root }),
      agents: new FileAgentOperationStoreV1({ root }),
      effects: new FileEffectOperationStoreV1({ root }),
      events: new FileDurableExecutionEventSinkV1({ root }),
    },
    agents: {
      resolve: () => { throw new Error("No agent operations expected."); },
      invoke: async () => { throw new Error("No agent operations expected."); },
    },
  });
}

function graphFixture(calls: string[], secondVersion = "1"): GraphWorkflowV1<number, number> {
  const firstStep = defineStep({ schemaVersion: 1, id: "first-step", definitionVersion: "1",
    input: z.number(), output: z.number(), execute: async (_context, input) => { calls.push("first"); return input + 1; } });
  const secondInput = z.object({ original: z.number(), first: z.number() });
  const secondStep = defineStep({ schemaVersion: 1, id: "second-step", definitionVersion: secondVersion,
    input: secondInput, output: z.number(), execute: async (_context, input) => { calls.push("second"); return input.original + input.first; } });
  const first = graphStep({ id: "first", input: graphRef.workflowInput<number>(), step: firstStep,
    inputSchema: { type: "number" }, outputSchema: { type: "number" } });
  const second = graphStep({ id: "second", input: graphValue.object({ original: graphRef.workflowInput<number>(), first: graphRef.output(first) }),
    step: secondStep, inputSchema: z.toJSONSchema(secondInput), outputSchema: { type: "number" } });
  return defineWorkflow({ workflow: { kind: "retained-graph", version: 1 }, workflowContractVersion: "1",
    resultKind: "retained-graph.result", input: numberContract, nodes: [second, first], entry: first, result: second });
}

async function construct(graph: GraphWorkflowV1, invocation: Parameters<typeof constructRetainedGraphWorkflow>[0]["invocation"], observations: JsonValue[]) {
  return constructRetainedGraphWorkflow({
    module: { createGraph: (context: { runConfiguration: unknown; readAsset(path: string): Uint8Array }) => {
      observations.push({ environmentVisible: Object.hasOwn(context, "environment"), configuration: context.runConfiguration as JsonValue,
        asset: new TextDecoder().decode(context.readAsset("prompt.md")) });
      return { graph, agentPrompts: {} };
    } },
    descriptor: { schemaVersion: 1, export: "createGraph" }, invocation,
    runConfiguration: { name: "retained" },
    assets: { "prompt.md": new TextEncoder().encode("Pinned prompt") },
  });
}

describe("retained graph workflow execution", () => {
  it("reconstructs the pinned graph on every attempt and replays completed work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retained-graph-"));
    try {
      const calls: string[] = [], observations: JsonValue[] = [];
      const graph = graphFixture(calls);
      const admission = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied",
        entry: { kind: "default" }, values: { entry: 4 } });
      if (admission.acquisition !== "supplied") throw new Error("Expected supplied admission.");
      const invocation = createGraphRunInvocationV1({ graph, admission, runRef: { executionId: "retained-graph-run" },
        runConfiguration, executableBindingId: "binding-v1", buildSha256, createdAt });
      const accepted = createGraphAcceptedBoundaryV1({ graph, invocation, boundary: admission.boundary,
        acceptanceId: "acceptance-v1", acceptedAt: createdAt });

      for (const [attemptId, fence] of [["attempt-1", 1], ["attempt-2", 2]] as const) {
        const retained = await construct(graph, invocation, observations);
        expect(await executeRetainedGraphWorkflowV1({ graph: retained.graph, invocation, accepted,
          host: host("retained-graph-run", attemptId, fence), engine: engine(root) })).toBe(9);
      }

      expect(observations).toEqual([
        { environmentVisible: false, configuration: { name: "retained" }, asset: "Pinned prompt" },
        { environmentVisible: false, configuration: { name: "retained" }, asset: "Pinned prompt" },
      ]);
      expect(calls).toEqual(["first", "second"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("executes an accepted deferred selected entry without running skipped ancestors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retained-selected-"));
    try {
      const calls: string[] = [], graph = graphFixture(calls), observations: JsonValue[] = [];
      const admission = admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred",
        entry: { kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: "second" }] } }, wait: { duration: "1d" } });
      if (admission.acquisition !== "deferred") throw new Error("Expected deferred admission.");
      const invocation = createGraphRunInvocationV1({ graph, admission, runRef: { executionId: "retained-selected-run" },
        runConfiguration, executableBindingId: "binding-v1", buildSha256, createdAt });
      const request = createGraphEntryRequestV1(graph, invocation, { requestId: "request-v1" });
      const boundary = admission.plan.requirements.reduce<Record<string, JsonValue>>((values, requirement) => {
        values[requirement.id] = requirement.role === "entry-input" ? { original: 4, first: 5 } : 4;
        return values;
      }, {});
      const accepted = createGraphAcceptedBoundaryV1({ graph, invocation, request,
        boundary: validateGraphEntryBoundaryV1(admission.plan, { schemaVersion: 1, planSha256: admission.plan.planSha256, values: boundary }),
        acceptanceId: "acceptance-v1", acceptedAt: "2026-09-18T10:05:00.000Z" });
      const retained = await construct(graph, invocation, observations);

      expect(await executeRetainedGraphWorkflowV1({ graph: retained.graph, invocation, request, accepted,
        host: host("retained-selected-run", "attempt-1", 1), engine: engine(root) })).toBe(9);
      expect(calls).toEqual(["second"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects construction from a changed graph declaration", async () => {
    const original = graphFixture([]);
    const admission = admitGraphInvocationV1(original, { schemaVersion: 1, acquisition: "supplied",
      entry: { kind: "default" }, values: { entry: 1 } });
    if (admission.acquisition !== "supplied") throw new Error("Expected supplied admission.");
    const invocation = createGraphRunInvocationV1({ graph: original, admission, runRef: { executionId: "changed-graph-run" },
      runConfiguration, executableBindingId: "binding-v1", buildSha256, createdAt });
    const changed = graphFixture([], "2");
    await expect(construct(changed, invocation, [])).rejects.toThrow(/declaration differs/);
  });
});
