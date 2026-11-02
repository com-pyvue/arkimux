import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { defineVendorEvaluation } from "../fixtures/local-v2-vendor/src/workflow.ts";
import { DurableWorkflowEngineV2 } from "../../core/src/application/durableWorkflowEngine.ts";
import { createLocalDurableExecutionStorage } from "../../local/src/localDurableWorkflowRuntime.ts";

it("runs the public Vendor Evaluation fixture on the same internal durable engine without a real provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendor-public-workflow-"));
  try {
    const examples = JSON.parse(await readFile(new URL("../fixtures/specifications/examples.json", import.meta.url), "utf8"));
    const workflow = defineVendorEvaluation();
    const storage = createLocalDurableExecutionStorage(root, { executionId: "vendor-fixture" });
    let calls = 0;
    const engine = new DurableWorkflowEngineV2({ storage, agents: {
      resolve: () => ({ providerId: "fixture", authProviderId: "fixture", configurationSha256: "b".repeat(64) }),
      async invoke(request) { calls++; expect(request.operation.slotId).toBe("vendor-evaluator"); return { output: request.operation.output.parse(examples.vendorResult) }; },
    } });
    const run = (input: unknown, fence = 1) => engine.execute({ workflowContractVersion: "1", host: {
      schemaVersion: 1, runRef: { executionId: "vendor-fixture" }, attemptId: `attempt-${fence}`, fence,
      deadlineAt: new Date(Date.now() + 540_000).toISOString(), finalizationReserveMs: 60_000,
      scratchDirectory: path.join(root, "scratch"), limits: { maxDurationMs: 540_000, maxScratchBytes: 1_000_000 },
      cancellation: { aborted: false }, heartbeat: async () => {},
    }, execute: context => workflow.execute(context, input as never) });
    await expect(run({})).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await run(examples.vendorInput)).toEqual(examples.vendorResult);
    expect(await run(examples.vendorInput, 2)).toEqual(examples.vendorResult);
    expect(calls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
