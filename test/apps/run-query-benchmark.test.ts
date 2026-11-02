import { describe, expect, it } from "vitest";
import { RunApiClient } from "../../apps/packages/run/contract/src/index.ts";
import {
  benchmarkRunQueries,
  recommendDerivedComparisonIndex,
} from "../../apps/hosts/api/src/runQueryBenchmark.ts";

const timestamp = "2026-08-05T12:00:00.000Z";

describe("local run query benchmark", () => {
  it("measures the complete paged catalog and a bounded comparison", async () => {
    const client = new RunApiClient({
      baseUrl: "http://benchmark.test",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/runs") {
          return json({
            items: url.searchParams.get("cursor") === "next" ? [run("run-3")] : [run("run-1"), run("run-2")],
            pagination: url.searchParams.get("cursor") === "next" ? {} : { nextCursor: "next" },
          });
        }
        if (url.pathname === "/api/v1/run-comparisons") {
          return json({ rows: [comparison("run-1"), comparison("run-2"), comparison("run-3")] });
        }
        return json({ error: { code: "not-found", message: "not found" } }, 404);
      },
    });
    const result = await benchmarkRunQueries(client, { iterations: 2, pageSize: 2, comparisonSize: 3 });
    expect(result.corpus).toEqual({ visibleRuns: 3, comparableRuns: 3 });
    expect(result.samples.listMs).toHaveLength(2);
    expect(result.samples.comparisonMs).toHaveLength(2);
    expect(result.derivedComparisonIndex.recommended).toBe(false);
  });

  it("recommends an index only after an interactive p95 budget is exceeded", () => {
    expect(recommendDerivedComparisonIndex(250, 500).recommended).toBe(false);
    expect(recommendDerivedComparisonIndex(250.01, null)).toMatchObject({
      recommended: true,
      reason: expect.stringContaining("listing"),
    });
    expect(recommendDerivedComparisonIndex(10, 500.01)).toMatchObject({
      recommended: true,
      reason: expect.stringContaining("comparison"),
    });
  });
});

function run(executionId: string) {
  return {
    runRef: { executionId },
    workflow: { kind: "fixture.workflow", version: 1 },
    actor: { userId: "owner", roleId: "runner" },
    createdAt: timestamp,
    status: { kind: "status", status: "complete", updatedAt: timestamp },
  };
}

function comparison(executionId: string) {
  return {
    runRef: { executionId },
    status: "complete",
    userId: "owner",
    roleId: "runner",
    workflow: { kind: "fixture.workflow", version: 1 },
    target: null,
    runConfiguration: null,
    provider: null,
    model: null,
    reasoningEffort: null,
    speed: null,
    durationMs: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    costs: null,
    toolCalls: null,
    searchCalls: null,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
