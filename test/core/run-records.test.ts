import { describe, expect, it } from "vitest";
import {
  aggregateRunUsage,
  validateRunEvent,
  validateRunPerformance,
  validateRunState,
  validateRunStateV3,
  validateRunStateProjection,
  type AgentAttemptPerformanceRecord,
  type AgentExecutionMetrics,
  type RunManifestV2,
} from "../../core/src/index.ts";

const manifest: RunManifestV2 = {
  schemaVersion: 2,
  runRef: { executionId: "fixture-run" },
  workflow: { kind: "fixture.workflow", version: 2 },
  target: { kind: "fixture-target", identity: { key: "value" } },
  createdAt: "2026-08-04T12:00:00.000Z",
  actor: { userId: "fixture-user", roleId: "fixture-role" },
};

function metrics(
  providerId: string,
  attempt: number,
  usage?: AgentExecutionMetrics["usage"],
): AgentExecutionMetrics {
  return {
    providerId,
    attempt,
    status: "complete",
    elapsedMs: 500,
    artifacts: {
      eventsPath: `${providerId}.events.jsonl`,
      stderrPath: `${providerId}.stderr.log`,
      lastMessagePath: `${providerId}.last-message.txt`,
      heartbeatPath: `${providerId}.heartbeat.json`,
    },
    nativeToolCalls: 1,
    toolCallUnit: "shell-command",
    ...(usage === undefined ? {} : { usage }),
  };
}

function attempt(
  stageId: string,
  logicalAgentId: string,
  executionMetrics: AgentExecutionMetrics,
): AgentAttemptPerformanceRecord {
  return { stageId, logicalAgentId, metrics: executionMetrics };
}

describe("generic run records", () => {
  it("validates workflow-neutral events and rejects legacy agent aliases", () => {
    const event = {
      type: "agent-completed",
      at: "2026-08-04T12:00:01.000Z",
      stageId: "fixture-stage",
      logicalAgentId: "fixture-agent",
      providerId: "codex-cli",
      metrics: metrics("codex-cli", 1),
    };

    expect(validateRunEvent(event)).toEqual(event);
    expect(() => validateRunEvent({
      ...event,
      agentId: "legacy-agent-alias",
    })).toThrow("Run event contains unknown fields [agentId].");
    expect(() => validateRunEvent({
      ...event,
      providerId: "pi-cli",
    })).toThrow("metrics providerId must match");
    expect(() => validateRunEvent({
      ...event,
      type: "agent-timed-out",
      message: "timed out",
    })).toThrow("metrics status must be timed-out");
  });

  it("validates schema-v2 state and strict status and heartbeat projections", () => {
    const status = {
      kind: "status",
      status: "running",
      updatedAt: "2026-08-04T12:00:01.000Z",
      stageId: "fixture-stage",
    } as const;
    const heartbeat = {
      kind: "heartbeat",
      status: "running",
      lastEventType: "agent-started",
      updatedAt: "2026-08-04T12:00:02.000Z",
      stageId: "fixture-stage",
      logicalAgentId: "fixture-agent",
      providerId: "pi-cli",
    } as const;

    expect(validateRunStateProjection(status)).toEqual(status);
    expect(validateRunState({ manifest, status, heartbeat })).toEqual({ manifest, status, heartbeat });
    expect(() => validateRunStateProjection({
      kind: "status",
      status: "failed",
      updatedAt: "2026-08-04T12:00:03.000Z",
    })).toThrow("missing required fields [message]");
    expect(() => validateRunStateProjection({
      ...heartbeat,
      lastEventType: "framework-discovery-complete",
    })).toThrow("lastEventType is unsupported");
  });

  it("validates schema-v3 state containing the immutable configuration reference", () => {
    const manifestV3 = {
      ...manifest,
      schemaVersion: 3 as const,
      runConfiguration: {
        configurationId: "fixture-v3",
        contentHash: "a".repeat(64),
      },
    };
    expect(validateRunStateV3({ manifest: manifestV3 })).toEqual({ manifest: manifestV3 });
    expect(validateRunEvent({
      type: "run-started",
      at: "2026-08-04T12:00:00.000Z",
      manifest: manifestV3,
    })).toMatchObject({ manifest: manifestV3 });
  });

  it("aggregates partial token usage and keeps costs separate by currency and kind", () => {
    const attempts = [
      attempt("stage-one", "agent-one", metrics("codex-cli", 1, {
        inputTokens: 100,
        cachedInputTokens: 60,
        cost: { amount: 0.25, currency: "USD", kind: "provider-estimate" },
      })),
      attempt("stage-two", "agent-two", metrics("pi-cli", 1, {
        outputTokens: 20,
        cost: { amount: 0.40, currency: "EUR", kind: "billed" },
      })),
      attempt("stage-two", "agent-two", metrics("pi-cli", 2, {
        inputTokens: 50,
        reasoningOutputTokens: 5,
        cost: { amount: 0.10, currency: "USD", kind: "billed" },
      })),
      attempt("stage-three", "agent-three", metrics("codex-cli", 1, {
        cost: { amount: 0.15, currency: "USD", kind: "provider-estimate" },
      })),
    ];

    expect(aggregateRunUsage(attempts)).toEqual({
      inputTokens: 150,
      cachedInputTokens: 60,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      costs: [
        { amount: 0.40, currency: "EUR", kind: "billed" },
        { amount: 0.10, currency: "USD", kind: "billed" },
        { amount: 0.40, currency: "USD", kind: "provider-estimate" },
      ],
    });
  });

  it("validates deterministic performance summaries and attempt identities", () => {
    const agentAttempts = [attempt(
      "fixture-stage",
      "fixture-agent",
      metrics("codex-cli", 1, { inputTokens: 100, outputTokens: 20 }),
    )];
    const performance = {
      schemaVersion: 1,
      runRef: manifest.runRef,
      workflow: manifest.workflow,
      startedAt: "2026-08-04T12:00:00.000Z",
      completedAt: "2026-08-04T12:00:02.000Z",
      totalElapsedMs: 2_000,
      stages: [{ stageId: "fixture-stage", status: "complete", elapsedMs: 1_500 }],
      agentAttempts,
      usage: { inputTokens: 100, outputTokens: 20 },
    } as const;

    expect(validateRunPerformance(performance)).toEqual(performance);
    expect(() => validateRunPerformance({
      ...performance,
      usage: { inputTokens: 99, outputTokens: 20 },
    })).toThrow("must equal the deterministic aggregation");
    expect(() => validateRunPerformance({
      ...performance,
      agentAttempts: [...agentAttempts, ...agentAttempts],
    })).toThrow("agentAttempts identity contains duplicates");
    expect(() => validateRunPerformance({
      ...performance,
      totalElapsedMs: 1_999,
    })).toThrow("must equal completedAt minus startedAt");
  });

  it("validates deterministic performance summaries containing provider costs", () => {
    const agentAttempts = [attempt(
      "fixture-stage",
      "fixture-agent",
      metrics("pi-cli", 1, {
        inputTokens: 100,
        cost: { amount: 0.25, currency: "USD", kind: "provider-estimate" },
      }),
    )];
    const performance = {
      schemaVersion: 1,
      runRef: manifest.runRef,
      workflow: manifest.workflow,
      startedAt: "2026-08-04T12:00:00.000Z",
      completedAt: "2026-08-04T12:00:02.000Z",
      totalElapsedMs: 2_000,
      stages: [{ stageId: "fixture-stage", status: "complete", elapsedMs: 1_500 }],
      agentAttempts,
      usage: {
        inputTokens: 100,
        costs: [{ amount: 0.25, currency: "USD", kind: "provider-estimate" }],
      },
    } as const;

    expect(validateRunPerformance(performance)).toEqual(performance);
  });
});
