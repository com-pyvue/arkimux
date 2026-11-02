import type { AgentExecutionMetrics } from "./agentProvider.ts";
import { validateAgentExecutionMetrics } from "./agentMetrics.ts";
import type {
  RunPerformanceReader,
  RunPerformanceWriteStore,
} from "./runLifecycle.ts";
import {
  canonicalTimestamp,
  compareText,
  nonNegativeInteger,
  nonNegativeNumber,
  record,
  safeIdentifier,
  unique,
} from "./recordValidation.ts";
import { validateRunRef, type RunRef } from "../domain/runIdentity.ts";
import { validateWorkflowIdentity, type WorkflowIdentity } from "../domain/workflowIdentity.ts";
import { assertExactKeys } from "../domain/validation.ts";

export interface StagePerformanceRecord {
  stageId: string;
  status: "complete" | "failed";
  elapsedMs: number;
}

export interface AgentAttemptPerformanceRecord {
  stageId: string;
  logicalAgentId: string;
  metrics: AgentExecutionMetrics;
}

export interface RunUsageCost {
  amount: number;
  currency: string;
  kind: "provider-estimate" | "billed";
}

export interface RunUsageSummary {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  costs?: RunUsageCost[];
}

export interface RunPerformance {
  schemaVersion: 1;
  runRef: RunRef;
  workflow: WorkflowIdentity;
  startedAt: string;
  completedAt: string;
  totalElapsedMs: number;
  stages: StagePerformanceRecord[];
  agentAttempts: AgentAttemptPerformanceRecord[];
  usage?: RunUsageSummary;
}

export type RunPerformanceStore = RunPerformanceWriteStore<
  AgentAttemptPerformanceRecord,
  RunPerformance
>;

export type RunPerformanceQueryStore = RunPerformanceReader<RunPerformance, RunRef>;

export function aggregateRunUsage(
  attempts: readonly AgentAttemptPerformanceRecord[],
): RunUsageSummary | undefined {
  const tokenFields = [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const;
  const sums = new Map<typeof tokenFields[number], number>();
  const costs = new Map<string, RunUsageCost>();
  for (const attempt of attempts) {
    const usage = attempt.metrics.usage;
    if (!usage) continue;
    for (const field of tokenFields) {
      const value = usage[field];
      if (value !== undefined) sums.set(field, (sums.get(field) ?? 0) + value);
    }
    if (usage.cost) {
      const key = `${usage.cost.currency}\0${usage.cost.kind}`;
      const existing = costs.get(key);
      costs.set(key, {
        currency: usage.cost.currency,
        kind: usage.cost.kind,
        amount: (existing?.amount ?? 0) + usage.cost.amount,
      });
    }
  }
  if (sums.size === 0 && costs.size === 0) return undefined;
  const aggregatedCosts = [...costs.values()].sort((left, right) => (
    compareText(left.currency, right.currency) || compareText(left.kind, right.kind)
  ));
  return {
    ...Object.fromEntries(tokenFields.flatMap((field) => (
      sums.has(field) ? [[field, sums.get(field)]] : []
    ))),
    ...(aggregatedCosts.length === 0 ? {} : { costs: aggregatedCosts }),
  };
}

export function validateRunPerformance(value: unknown): RunPerformance {
  const performance = record(value, "Run performance");
  assertExactKeys(
    performance,
    [
      "schemaVersion",
      "runRef",
      "workflow",
      "startedAt",
      "completedAt",
      "totalElapsedMs",
      "stages",
      "agentAttempts",
    ],
    "Run performance",
    [
      "schemaVersion",
      "runRef",
      "workflow",
      "startedAt",
      "completedAt",
      "totalElapsedMs",
      "stages",
      "agentAttempts",
      "usage",
    ],
  );
  if (performance.schemaVersion !== 1) throw new Error("Run performance.schemaVersion must be 1.");
  canonicalTimestamp(performance.startedAt, "Run performance.startedAt");
  canonicalTimestamp(performance.completedAt, "Run performance.completedAt");
  const elapsed = Date.parse(performance.completedAt as string) - Date.parse(performance.startedAt as string);
  nonNegativeInteger(performance.totalElapsedMs, "Run performance.totalElapsedMs");
  if (performance.totalElapsedMs !== elapsed) {
    throw new Error("Run performance.totalElapsedMs must equal completedAt minus startedAt.");
  }
  if (!Array.isArray(performance.stages)) throw new Error("Run performance.stages must be an array.");
  if (!Array.isArray(performance.agentAttempts)) {
    throw new Error("Run performance.agentAttempts must be an array.");
  }
  const stages = performance.stages.map((item, index) => validateStagePerformanceRecord(
    item,
    `Run performance.stages[${index}]`,
  ));
  unique(stages.map(({ stageId }) => stageId), "Run performance.stages stageId");
  const agentAttempts = performance.agentAttempts.map((item, index) => validateAgentAttemptPerformanceRecord(
    item,
    `Run performance.agentAttempts[${index}]`,
  ));
  unique(agentAttempts.map(({ stageId, logicalAgentId, metrics }) => (
    `${stageId}\0${logicalAgentId}\0${metrics.providerId}\0${metrics.attempt}`
  )), "Run performance.agentAttempts identity");
  const expectedUsage = aggregateRunUsage(agentAttempts);
  const suppliedUsage = performance.usage === undefined
    ? undefined
    : validateRunUsageSummary(performance.usage);
  if (JSON.stringify(suppliedUsage) !== JSON.stringify(expectedUsage)) {
    throw new Error("Run performance.usage must equal the deterministic aggregation of agentAttempts.");
  }
  return {
    schemaVersion: 1,
    runRef: validateRunRef(performance.runRef),
    workflow: validateWorkflowIdentity(performance.workflow),
    startedAt: performance.startedAt as string,
    completedAt: performance.completedAt as string,
    totalElapsedMs: performance.totalElapsedMs as number,
    stages,
    agentAttempts,
    ...(expectedUsage === undefined ? {} : { usage: expectedUsage }),
  };
}

function validateStagePerformanceRecord(value: unknown, location: string): StagePerformanceRecord {
  const stage = record(value, location);
  assertExactKeys(stage, ["stageId", "status", "elapsedMs"], location);
  safeIdentifier(stage.stageId, `${location}.stageId`);
  if (stage.status !== "complete" && stage.status !== "failed") {
    throw new Error(`${location}.status must be complete or failed.`);
  }
  nonNegativeInteger(stage.elapsedMs, `${location}.elapsedMs`);
  return structuredClone(stage) as unknown as StagePerformanceRecord;
}

function validateAgentAttemptPerformanceRecord(
  value: unknown,
  location: string,
): AgentAttemptPerformanceRecord {
  const attempt = record(value, location);
  assertExactKeys(attempt, ["stageId", "logicalAgentId", "metrics"], location);
  safeIdentifier(attempt.stageId, `${location}.stageId`);
  safeIdentifier(attempt.logicalAgentId, `${location}.logicalAgentId`);
  const metrics = validateAgentExecutionMetrics(attempt.metrics);
  if (metrics.attempt === undefined) throw new Error(`${location}.metrics.attempt is required.`);
  return {
    stageId: attempt.stageId as string,
    logicalAgentId: attempt.logicalAgentId as string,
    metrics,
  };
}

function validateRunUsageSummary(value: unknown): RunUsageSummary {
  const usage = record(value, "Run performance.usage");
  const tokenFields = [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const;
  assertExactKeys(usage, [], "Run performance.usage", [...tokenFields, "costs"]);
  for (const field of tokenFields) {
    if (usage[field] !== undefined) nonNegativeInteger(usage[field], `Run performance.usage.${field}`);
  }
  let costs: RunUsageCost[] | undefined;
  if (usage.costs !== undefined) {
    if (!Array.isArray(usage.costs) || usage.costs.length === 0) {
      throw new Error("Run performance.usage.costs must be a non-empty array when present.");
    }
    costs = usage.costs.map((item, index) => validateRunUsageCost(item, index));
    unique(costs.map(({ currency, kind }) => `${currency}\0${kind}`), "Run performance.usage.costs identity");
    costs.sort((left, right) => (
      compareText(left.currency, right.currency) || compareText(left.kind, right.kind)
    ));
  }
  return {
    ...Object.fromEntries(tokenFields.flatMap((field) => (
      usage[field] === undefined ? [] : [[field, usage[field]]]
    ))),
    ...(costs === undefined ? {} : { costs }),
  };
}

function validateRunUsageCost(value: unknown, index: number): RunUsageCost {
  const location = `Run performance.usage.costs[${index}]`;
  const cost = record(value, location);
  assertExactKeys(cost, ["amount", "currency", "kind"], location);
  nonNegativeNumber(cost.amount, `${location}.amount`);
  if (typeof cost.currency !== "string" || !/^[A-Z]{3}$/.test(cost.currency)) {
    throw new Error(`${location}.currency must be an uppercase ISO-4217 code.`);
  }
  if (cost.kind !== "provider-estimate" && cost.kind !== "billed") {
    throw new Error(`${location}.kind must be provider-estimate or billed.`);
  }
  return {
    currency: cost.currency,
    kind: cost.kind,
    amount: cost.amount as number,
  };
}
