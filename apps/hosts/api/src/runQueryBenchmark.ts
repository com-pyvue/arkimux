import { performance } from "node:perf_hooks";
import type { RunApiClient, RunListResponseDto } from "@com-pyvue/agent-execution-run-contract";

type RunCatalogEntryDto = RunListResponseDto["items"][number];

export const DEFAULT_RUN_QUERY_BENCHMARK_POLICY = {
  listP95Ms: 250,
  comparisonP95Ms: 500,
} as const;

export interface RunQueryBenchmarkOptions {
  iterations?: number;
  pageSize?: number;
  comparisonSize?: number;
}

export interface RunQueryBenchmarkResult {
  schemaVersion: 1;
  measuredAt: string;
  corpus: {
    visibleRuns: number;
    comparableRuns: number;
  };
  samples: {
    iterations: number;
    listMs: number[];
    comparisonMs: number[];
  };
  p95: {
    listMs: number;
    comparisonMs: number | null;
  };
  derivedComparisonIndex: {
    recommended: boolean;
    reason: string;
    policy: typeof DEFAULT_RUN_QUERY_BENCHMARK_POLICY;
  };
}

export async function benchmarkRunQueries(
  client: RunApiClient,
  options: RunQueryBenchmarkOptions = {},
): Promise<RunQueryBenchmarkResult> {
  const iterations = positiveInteger(options.iterations ?? 5, "iterations", 100);
  const pageSize = positiveInteger(options.pageSize ?? 500, "pageSize", 500);
  const comparisonSize = positiveInteger(options.comparisonSize ?? 20, "comparisonSize", 20);
  const listMs: number[] = [];
  let visibleRuns: RunCatalogEntryDto[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    visibleRuns = await listVisibleRuns(client, pageSize);
    listMs.push(round(performance.now() - startedAt));
  }
  const comparable = visibleRuns.filter(({ status }) => status?.status === "complete").slice(0, comparisonSize);
  const comparisonMs: number[] = [];
  if (comparable.length >= 2) {
    const executionIds = comparable.map(({ runRef }) => runRef.executionId);
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const startedAt = performance.now();
      await client.compareRuns({ executionIds });
      comparisonMs.push(round(performance.now() - startedAt));
    }
  }
  const listP95Ms = percentile95(listMs);
  const comparisonP95Ms = comparisonMs.length === 0 ? null : percentile95(comparisonMs);
  const recommendation = recommendDerivedComparisonIndex(listP95Ms, comparisonP95Ms);
  return {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    corpus: { visibleRuns: visibleRuns.length, comparableRuns: comparable.length },
    samples: { iterations, listMs, comparisonMs },
    p95: { listMs: listP95Ms, comparisonMs: comparisonP95Ms },
    derivedComparisonIndex: {
      ...recommendation,
      policy: DEFAULT_RUN_QUERY_BENCHMARK_POLICY,
    },
  };
}

export function recommendDerivedComparisonIndex(
  listP95Ms: number,
  comparisonP95Ms: number | null,
): Pick<RunQueryBenchmarkResult["derivedComparisonIndex"], "recommended" | "reason"> {
  if (listP95Ms > DEFAULT_RUN_QUERY_BENCHMARK_POLICY.listP95Ms) {
    return {
      recommended: true,
      reason: `Run listing p95 exceeded ${DEFAULT_RUN_QUERY_BENCHMARK_POLICY.listP95Ms} ms.`,
    };
  }
  if (
    comparisonP95Ms !== null
    && comparisonP95Ms > DEFAULT_RUN_QUERY_BENCHMARK_POLICY.comparisonP95Ms
  ) {
    return {
      recommended: true,
      reason: `Run comparison p95 exceeded ${DEFAULT_RUN_QUERY_BENCHMARK_POLICY.comparisonP95Ms} ms.`,
    };
  }
  return {
    recommended: false,
    reason: "Measured query latency remains within the local interactive budget.",
  };
}

async function listVisibleRuns(client: RunApiClient, pageSize: number): Promise<RunCatalogEntryDto[]> {
  const items: RunCatalogEntryDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listRuns({ pageSize, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.pagination.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function percentile95(samples: number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
