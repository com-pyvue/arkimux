import { defineStep, type WorkflowExecutionContextV1, type DeepReadonly } from "@com-pyvue/agent-execution-core";
import { vendorInputSchema, vendorResultSchema, validateVendorResultForInput, type VendorInput } from "./contract.js";

/** Offline conformance fixture, not a preinstalled customer workflow. */
export function defineVendorEvaluation() {
  const evaluate = defineStep({
    schemaVersion: 1, id: "evaluate-vendors", definitionVersion: "1",
    input: vendorInputSchema, output: vendorResultSchema,
    execute: async (context, input) => validateVendorResultForInput(input,
      await context.agents.invoke({ schemaVersion: 1, operationId: "evaluate-vendors", slotId: "vendor-evaluator", output: vendorResultSchema }, input)),
  });
  return {
    workflow: { kind: "vendor-evaluation", version: 1 }, workflowContractVersion: "1",
    input: vendorInputSchema, output: vendorResultSchema, resultKind: "vendor-evaluation.result",
    async execute(context: WorkflowExecutionContextV1, input: DeepReadonly<VendorInput>) {
      const validated = vendorInputSchema.parse(input);
      return (await context.steps.run(evaluate, validated)).output;
    },
  };
}
