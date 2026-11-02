import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileRunPerformanceStore,
  FileRunPerformanceV2Store,
  FileRunStateStore,
  FileRunStateV2Store,
  FileRunStateV3Store,
  PerformanceAttemptConflictError,
  PerformanceSummaryConflictError,
  RunStateAlreadyExistsError,
  RunReservationAlreadyExistsError,
} from "../../core/src/index.ts";

const directories: string[] = [];

interface FixtureManifest {
  runId: string;
}

type FixtureProjection =
  | { kind: "status"; value: string }
  | { kind: "heartbeat"; value: number };

interface FixtureState {
  manifest: FixtureManifest;
  status?: Extract<FixtureProjection, { kind: "status" }>;
  heartbeat?: Extract<FixtureProjection, { kind: "heartbeat" }>;
}

interface FixtureAttempt {
  key: string;
  elapsedMs: number;
}

interface FixtureSummary {
  runId: string;
  totalElapsedMs: number;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-file-store-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

async function stateStore(root?: string) {
  return new FileRunStateStore<FixtureManifest, FixtureProjection, FixtureState>({
    root: root ?? await temporaryDirectory(),
    createState: (manifest) => ({ manifest }),
    projectionKind: (projection) => projection.kind,
    decodeManifest: (value) => fixtureManifest(value),
    projections: [
      {
        kind: "status",
        fileName: "status.json",
        encode: ({ kind: _kind, ...stored }) => stored,
        decode: (value) => ({ kind: "status", value: stringValue(value) }),
        apply: (state, projection) => ({
          ...state,
          status: projection as Extract<FixtureProjection, { kind: "status" }>,
        }),
      },
      {
        kind: "heartbeat",
        fileName: "heartbeat.json",
        encode: ({ kind: _kind, ...stored }) => stored,
        decode: (value) => ({ kind: "heartbeat", value: numberValue(value) }),
        apply: (state, projection) => ({
          ...state,
          heartbeat: projection as Extract<FixtureProjection, { kind: "heartbeat" }>,
        }),
      },
    ],
  });
}

function performanceStore(root: string, runId = "run-01") {
  return new FileRunPerformanceStore<FixtureAttempt, FixtureSummary, string>({
    root,
    attemptFileName: ({ key }) => `${key}.json`,
    encodeAttempt: (attempt) => ({ schemaVersion: 1, runId, ...attempt }),
    decodeSummary: (value) => fixtureSummary(value),
    matchesQuery: (query) => query === runId,
  });
}

describe("generic file run state store", () => {
  it("reserves a schema-v2 run globally before creating its manifest", async () => {
    const directory = await temporaryDirectory();
    const runRef = { executionId: "fixture-run" };
    const options = {
      root: path.join(directory, "run", "state"),
      reservationRoot: path.join(directory, ".reservations"),
      runRef,
    };
    const store = new FileRunStateV2Store(options);
    const manifest = {
      schemaVersion: 2 as const,
      runRef,
      workflow: { kind: "fixture.workflow", version: 2 },
      target: { kind: "fixture-target", identity: { key: "value" } },
      createdAt: "2026-08-04T12:00:00.000Z",
      actor: { userId: "fixture-user", roleId: "fixture-role" },
    };

    await store.reserve();
    await expect(new FileRunStateV2Store(options).reserve())
      .rejects.toBeInstanceOf(RunReservationAlreadyExistsError);
    await store.create(manifest);
    await store.update({
      kind: "status",
      status: "complete",
      updatedAt: "2026-08-04T12:00:01.000Z",
    });
    await expect(store.get()).resolves.toEqual({
      manifest,
      status: {
        kind: "status",
        status: "complete",
        updatedAt: "2026-08-04T12:00:01.000Z",
      },
    });
  });

  it("persists a schema-v3 manifest with its immutable configuration reference", async () => {
    const directory = await temporaryDirectory();
    const runRef = { executionId: "fixture-run-v3" };
    const store = new FileRunStateV3Store({
      root: path.join(directory, "run", "state"),
      reservationRoot: path.join(directory, ".reservations"),
      runRef,
    });
    const manifest = {
      schemaVersion: 3 as const,
      runRef,
      workflow: { kind: "fixture.workflow", version: 3 },
      createdAt: "2026-08-05T12:00:00.000Z",
      actor: { userId: "fixture-user", roleId: "fixture-role" },
      runConfiguration: {
        configurationId: "fixture-v3",
        contentHash: "a".repeat(64),
      },
    };
    await store.reserve();
    await store.create(manifest);
    await expect(store.get()).resolves.toEqual({ manifest });
  });

  it("persists an immutable manifest and independently replaceable projections", async () => {
    const directory = await temporaryDirectory();
    const store = await stateStore(directory);

    await expect(store.get()).resolves.toBeUndefined();
    await store.create({ runId: "run-01" });
    await store.update({ kind: "status", value: "running" });
    await store.update({ kind: "heartbeat", value: 1 });
    await store.update({ kind: "status", value: "complete" });

    await expect((await stateStore(directory)).get()).resolves.toEqual({
      manifest: { runId: "run-01" },
      status: { kind: "status", value: "complete" },
      heartbeat: { kind: "heartbeat", value: 1 },
    });
    await expect(fs.readFile(path.join(directory, "status.json"), "utf8"))
      .resolves.not.toContain('"kind"');
  });

  it("rejects a second manifest and malformed persisted records", async () => {
    const directory = await temporaryDirectory();
    const store = await stateStore(directory);
    await store.create({ runId: "run-01" });

    await expect(store.create({ runId: "replacement" }))
      .rejects.toBeInstanceOf(RunStateAlreadyExistsError);
    await fs.writeFile(path.join(directory, "status.json"), '{"value":7}\n', "utf8");
    await expect(store.get()).rejects.toThrow("Stored projection value must be a string.");
  });

  it("rejects unsafe and ambiguous projection layouts", async () => {
    await expect(stateStore()).resolves.toBeInstanceOf(FileRunStateStore);
    expect(() => new FileRunStateStore({
      root: "/tmp/unused",
      createState: (manifest: FixtureManifest): FixtureState => ({ manifest }),
      projectionKind: (projection: FixtureProjection) => projection.kind,
      projections: [
        fixtureProjectionCodec("status", "same.json"),
        fixtureProjectionCodec("heartbeat", "same.json"),
      ],
    })).toThrow("Duplicate run-state filename: same.json.");
  });
});

describe("generic file run performance store", () => {
  it("persists schema-v2 workflow-neutral performance", async () => {
    const directory = await temporaryDirectory();
    const runRef = { executionId: "fixture-run" };
    const store = new FileRunPerformanceV2Store(directory, runRef);
    const attempt = {
      stageId: "fixture-stage",
      logicalAgentId: "fixture-agent",
      metrics: {
        providerId: "codex-cli",
        attempt: 1,
        status: "complete" as const,
        elapsedMs: 1_000,
        artifacts: {
          eventsPath: "events.jsonl",
          stderrPath: "stderr.log",
          lastMessagePath: "message.txt",
          heartbeatPath: "heartbeat.json",
        },
        nativeToolCalls: 0,
        toolCallUnit: "shell-command" as const,
      },
    };
    const summary = {
      schemaVersion: 1 as const,
      runRef,
      workflow: { kind: "fixture.workflow", version: 2 },
      startedAt: "2026-08-04T12:00:00.000Z",
      completedAt: "2026-08-04T12:00:01.000Z",
      totalElapsedMs: 1_000,
      stages: [{ stageId: "fixture-stage", status: "complete" as const, elapsedMs: 1_000 }],
      agentAttempts: [attempt],
    };

    await store.recordAttempt(attempt);
    await store.complete(summary);
    await expect(store.get(runRef)).resolves.toEqual(summary);
  });

  it("persists idempotent attempts and an immutable queryable summary", async () => {
    const directory = await temporaryDirectory();
    const store = performanceStore(directory);
    const attempt = { key: "framework.codex.1", elapsedMs: 50 };
    const summary = { runId: "run-01", totalElapsedMs: 50 };

    await store.recordAttempt(attempt);
    await store.recordAttempt(attempt);
    await store.complete(summary);
    await store.complete(summary);

    await expect(store.get("run-01")).resolves.toEqual(summary);
    await expect(store.get("other-run")).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(
      directory,
      "performance",
      "attempts",
      "framework.codex.1.json",
    ), "utf8")).resolves.toContain('"runId": "run-01"');
  });

  it("rejects conflicting attempts and summaries", async () => {
    const directory = await temporaryDirectory();
    const store = performanceStore(directory);
    await store.recordAttempt({ key: "framework.codex.1", elapsedMs: 50 });
    await store.complete({ runId: "run-01", totalElapsedMs: 50 });

    await expect(store.recordAttempt({ key: "framework.codex.1", elapsedMs: 51 }))
      .rejects.toBeInstanceOf(PerformanceAttemptConflictError);
    await expect(store.complete({ runId: "run-01", totalElapsedMs: 51 }))
      .rejects.toBeInstanceOf(PerformanceSummaryConflictError);
  });

  it("rejects unsafe attempt keys and malformed summaries", async () => {
    const directory = await temporaryDirectory();
    const store = performanceStore(directory);
    await expect(store.recordAttempt({ key: "../escape", elapsedMs: 1 }))
      .rejects.toThrow("Performance attempt filename must be a single path segment.");
    await fs.writeFile(path.join(directory, "performance.json"), '{"runId":7}\n', "utf8");
    await expect(store.get("run-01")).rejects.toThrow("Stored summary.runId must be a string.");
  });
});

function fixtureProjectionCodec(kind: string, fileName: string) {
  return {
    kind,
    fileName,
    encode: (projection: FixtureProjection) => projection,
    decode: (value: unknown) => value as FixtureProjection,
    apply: (state: FixtureState) => state,
  };
}

function fixtureManifest(value: unknown): FixtureManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored manifest must be an object.");
  }
  const runId = (value as Record<string, unknown>).runId;
  if (typeof runId !== "string") throw new Error("Stored manifest.runId must be a string.");
  return { runId };
}

function stringValue(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored projection must be an object.");
  }
  const stored = (value as Record<string, unknown>).value;
  if (typeof stored !== "string") throw new Error("Stored projection value must be a string.");
  return stored;
}

function numberValue(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored projection must be an object.");
  }
  const stored = (value as Record<string, unknown>).value;
  if (typeof stored !== "number") throw new Error("Stored projection value must be a number.");
  return stored;
}

function fixtureSummary(value: unknown): FixtureSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored summary must be an object.");
  }
  const stored = value as Record<string, unknown>;
  if (typeof stored.runId !== "string") throw new Error("Stored summary.runId must be a string.");
  if (typeof stored.totalElapsedMs !== "number") {
    throw new Error("Stored summary.totalElapsedMs must be a number.");
  }
  return { runId: stored.runId, totalElapsedMs: stored.totalElapsedMs };
}
