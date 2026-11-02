import { z } from "zod";
import {
  defineGraphValue,
  defineStep,
  defineWorkflow,
  graphRef,
  graphStep,
  graphValue,
} from "../../../core/src/index.ts";
import { graphFailureBoundaryV1, type GraphCleanupHandlerInputV1 } from "../../../core/src/application/graphFailureBoundary.ts";
import { defineGraphCleanupPolicyV1 } from "../../../core/src/application/graphFailurePolicy.ts";
import type { RetainedConstructionContextV1 } from "../../../core/src/application/retainedWorkflowConstruction.ts";

const number = defineGraphValue({ version: "1", schema: { type: "number" }, validator: z.number() });

export function createRetainedGraph(context: RetainedConstructionContextV1) {
  const configuration = z.object({ failFirst: z.boolean(), cancelFirst: z.boolean().optional().default(false) }).parse(context.runConfiguration);
  const firstStep = defineStep({ schemaVersion: 1, id: "first-step", definitionVersion: "1",
    input: z.number(), output: z.number(), execute: async (step, input) => {
      while (configuration.cancelFirst && !step.cancellation.aborted) await new Promise(resolve => setTimeout(resolve, 5));
      if (step.cancellation.aborted) throw new Error("The retained graph was cancelled.");
      if (configuration.failFirst) throw new Error("The skipped first step executed.");
      return input + 1;
    } });
  const secondInput = z.object({ original: z.number(), first: z.number() });
  const secondStep = defineStep({ schemaVersion: 1, id: "second-step", definitionVersion: "1",
    input: secondInput, output: z.number(), execute: async (_step, input) => input.original + input.first });
  const first = graphStep({ id: "first", input: graphRef.workflowInput<number>(), step: firstStep,
    inputSchema: { type: "number" }, outputSchema: { type: "number" } });
  const cleanup = defineStep({ schemaVersion: 1, id: "release-first-step", definitionVersion: "1",
    input: z.custom<GraphCleanupHandlerInputV1<number>>(), output: z.null(), execute: async () => null });
  graphFailureBoundaryV1({ placement: first, scope: "node-instance", cleanup: [{
    policy: defineGraphCleanupPolicyV1({ schemaVersion: 1, kind: "cleanup", policyId: "release-first-step",
      policyVersion: "1", handlerDefinitionId: "release-first-step", triggers: ["cancellation"],
      execution: "once-per-scope-outcome", failureMode: "record-only-preserve-original" }),
    handler: cleanup,
  }] });
  const second = graphStep({ id: "second", input: graphValue.object({ original: graphRef.workflowInput<number>(), first: graphRef.output(first) }),
    step: secondStep, inputSchema: z.toJSONSchema(secondInput), outputSchema: { type: "number" } });
  const graph = defineWorkflow({ workflow: { kind: "retained-worker-graph", version: 1 }, workflowContractVersion: "1",
    resultKind: "retained-worker-graph.result", input: number, nodes: [second, first], entry: first, result: second });
  return { graph, agentPrompts: {} };
}
