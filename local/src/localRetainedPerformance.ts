/** Private retained-Run projection. The public Performance V1 schema is unchanged. */
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { validateAgentExecutionMetrics } from "../../core/src/application/agentMetrics.ts";
import { aggregateRunUsage, validateRunPerformance, type AgentAttemptPerformanceRecord, type StagePerformanceRecord } from "../../core/src/application/runPerformance.ts";
import { terminalRun, type RetainedRunControlV1 } from "../../core/src/application/retainedExecution.ts";
import { FileRunPerformanceStore } from "../../core/src/infrastructure/storage/fileRunPerformanceStore.ts";
import { FileRunPerformanceV2Store } from "../../core/src/infrastructure/storage/fileRunPerformanceV2Store.ts";
import { FileStepCheckpointStoreV2 } from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";
import { FileRunArtifactStore } from "../../core/src/infrastructure/storage/fileRunArtifactStore.ts";
import { resolveLocalDurableExecutionPaths } from "./localDurableWorkflowRuntime.ts";
import { resolveLocalExecutionDataPaths } from "./localStorePaths.ts";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), runRef: z.strictObject({ executionId: id }),
  operationId: z.string().min(1), stageId: id, slotId: id, fence: z.number().int().positive().safe(),
  sequence: z.number().int().positive().safe(),
  metrics: z.unknown().transform(validateAgentExecutionMetrics) });
type SavedAttempt = z.infer<typeof recordSchema>;

async function names(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).filter(name => name.endsWith(".json") && !name.startsWith(".")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Persist before returning the provider result to the worker. Replay does not
 * invoke a completed operation, and the same operation/fence cannot be overwritten. */
export async function recordRetainedAgentMetrics(projectRoot: string, value: SavedAttempt, executionDataRoot?: string): Promise<void> {
  const record = recordSchema.parse(value);
  const root = resolveLocalDurableExecutionPaths(projectRoot, record.runRef, executionDataRoot).root;
  const store = new FileRunPerformanceStore<SavedAttempt, never, never>({ root,
    attemptsDirectory: "performance-agent-events", attemptFileName: item => `${hashJson([item.operationId, item.fence])}.json`,
    encodeAttempt: recordSchema.parse, matchesQuery: () => false });
  await store.recordAttempt(record);
}

export async function publishRetainedPerformance(projectRoot: string, control: RetainedRunControlV1, executionDataRoot?: string): Promise<void> {
  // The owner must have finished teardown and accounting before a terminal summary
  // becomes immutable. Waiting Runs deliberately have no completed summary.
  if (!terminalRun(control) || control.owner || control.retainedDataDeleted) return;
  const invocation = control.binding.runManifest;
  if (!invocation) return;
  const ref = control.runRef, root = resolveLocalDurableExecutionPaths(projectRoot, ref, executionDataRoot).root;
  const runRoot = path.join(resolveLocalExecutionDataPaths(projectRoot, executionDataRoot).runs, ref.executionId);
  const attempts: SavedAttempt[] = [];
  for (const name of await names(path.join(root, "performance-agent-events"))) {
    const item = recordSchema.parse(JSON.parse(await readFile(path.join(root, "performance-agent-events", name), "utf8")));
    if (item.runRef.executionId !== ref.executionId || name !== `${hashJson([item.operationId, item.fence])}.json`) throw new Error("Retained performance identity differs.");
    attempts.push(item);
  }
  // Public attempt numbers are per step/slot/provider invocation, not host fence.
  // Several operations can use one slot during the same host attempt.
  attempts.sort((a, b) => a.fence - b.fence || a.sequence - b.sequence || compare(a.operationId, b.operationId));
  const counts = new Map<string, number>();
  const agentAttempts: AgentAttemptPerformanceRecord[] = attempts.map(item => {
    const key = JSON.stringify([item.stageId, item.slotId, item.metrics.providerId]);
    const attempt = (counts.get(key) ?? 0) + 1; counts.set(key, attempt);
    return { stageId: item.stageId, logicalAgentId: item.slotId, metrics: { ...item.metrics, attempt } };
  });
  const stages: StagePerformanceRecord[] = [];
  const inputSteps = new Set(Object.values(control.requests).map(request => request.definition.stepId));
  const claims = new Map<string, string>();
  for (const name of await names(path.join(root, "events"))) {
    const event = z.object({ runRef: z.strictObject({ executionId: id }), type: z.string(),
      at: z.string().datetime({ precision: 3 }), stepId: id.optional() }).parse(JSON.parse(await readFile(path.join(root, "events", name), "utf8")));
    if (event.runRef.executionId !== ref.executionId) throw new Error("Retained performance event identity differs.");
    if (event.type === "step-claimed" && event.stepId) claims.set(event.stepId, event.at);
  }
  const steps = new FileStepCheckpointStoreV2({ root });
  for (const name of await names(path.join(root, "steps"))) {
    const stepId = decodeURIComponent(name.slice(0, -5));
    const step = await steps.read({ runRef: ref, stepId });
    if (!step || step.ref.runRef.executionId !== ref.executionId || step.ref.stepId !== stepId
      || name !== `${encodeURIComponent(stepId)}.json`) throw new Error("Retained performance step identity differs.");
    // Input steps describe human time, never execution-stage time.
    if (inputSteps.has(stepId)) continue;
    if (step.completed) stages.push({ stageId: stepId, status: "complete", elapsedMs: step.completed.execution.elapsedMs });
    else if (claims.has(stepId)) {
      const end = step.terminal?.at ?? control.compute?.lastAttempt?.endedAt;
      // An interrupted attempt may have no reliable endpoint. Do not invent zero
      // or include the subsequent downtime in its stage duration.
      if (end && control.compute?.certainty === "known") stages.push({ stageId: stepId, status: "failed",
        elapsedMs: Math.max(0, Date.parse(end) - Date.parse(claims.get(stepId)!)) });
    }
  }
  const stageOrder = new Map([...claims.keys()].map((stepId, index) => [stepId, index]));
  stages.sort((a, b) => (stageOrder.get(a.stageId) ?? Number.MAX_SAFE_INTEGER) - (stageOrder.get(b.stageId) ?? Number.MAX_SAFE_INTEGER)
    || compare(a.stageId, b.stageId));
  const usage = aggregateRunUsage(agentAttempts);
  const performance = validateRunPerformance({ schemaVersion: 1, runRef: ref, workflow: invocation.workflow,
    startedAt: invocation.createdAt, completedAt: control.updatedAt,
    totalElapsedMs: Date.parse(control.updatedAt) - Date.parse(invocation.createdAt), stages, agentAttempts,
    ...(usage ? { usage } : {}) });
  const store = new FileRunPerformanceV2Store(path.join(runRoot, "state"), ref);
  for (const attempt of agentAttempts) await store.recordAttempt(attempt);
  await store.complete(performance);
  // A separate artifact keeps accounting certainty and input time explicit without
  // redefining V1's wall-clock total or adding unapproved fields to its strict schema.
  await new FileRunArtifactStore(runRoot).scope("artifacts").writeJson("retained-timing.json", {
    schemaVersion: 1, runRef: ref, asOf: control.updatedAt,
    activeCompute: control.compute ? { spentMs: control.compute.spentMs, certainty: control.compute.certainty } : null,
    inputWaits: Object.values(control.requests).map(request => {
      const endedAt = request.status === "expired" ? request.definition.expiresAt : request.updatedAt;
      return {
      requestId: request.definition.requestId, stepId: request.definition.stepId, status: request.status,
      startedAt: request.definition.createdAt, endedAt,
      humanWaitMs: Date.parse(endedAt) - Date.parse(request.definition.createdAt),
      tokens: { availability: "unavailable", reason: "not_applicable" },
      };
    }),
  });
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
