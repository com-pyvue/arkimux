import { describe, expect, it } from "vitest";
import {
  CompositeRunEventSink,
  type RunEventSink,
  type RunPerformanceReader,
  type RunPerformanceWriteStore,
  type RunStateStore,
} from "../../core/src/index.ts";

type FixtureEvent =
  | { type: "started"; at: string }
  | { type: "completed"; at: string; value: number };

describe("generic run lifecycle contracts", () => {
  it("fans one workflow-owned event out to every sink", async () => {
    const received: Array<{ sink: string; event: FixtureEvent }> = [];
    const sink = (name: string): RunEventSink<FixtureEvent> => ({
      emit: async (event) => {
        received.push({ sink: name, event });
      },
    });
    const events = new CompositeRunEventSink([
      sink("state"),
      sink("performance"),
    ]);
    const event: FixtureEvent = {
      type: "completed",
      at: "2026-08-04T12:00:00.000Z",
      value: 42,
    };

    await events.emit(event);

    expect(received).toEqual([
      { sink: "state", event },
      { sink: "performance", event },
    ]);
  });

  it("supports workflow-owned state and performance records without domain imports", async () => {
    type Manifest = { executionId: string };
    type Projection = { status: "running" | "complete" };
    type State = { manifest: Manifest; latest?: Projection };
    type Attempt = { worker: string; elapsedMs: number };
    type Summary = { totalElapsedMs: number };
    let state: State | undefined;
    let summary: Summary | undefined;
    const states: RunStateStore<Manifest, Projection, State> = {
      create: async (manifest) => {
        state = { manifest };
      },
      update: async (projection) => {
        if (!state) throw new Error("fixture state was not created");
        state = { ...state, latest: projection };
      },
      get: async () => state,
    };
    const attempts: Attempt[] = [];
    const performance: RunPerformanceWriteStore<Attempt, Summary> = {
      recordAttempt: async (attempt) => {
        attempts.push(attempt);
      },
      complete: async (value) => {
        summary = value;
      },
    };
    const performanceQuery: RunPerformanceReader<Summary, { executionId: string }> = {
      get: async () => summary,
    };

    await states.create({ executionId: "fixture-run" });
    await states.update({ status: "complete" });
    await performance.recordAttempt({ worker: "fixture-agent", elapsedMs: 10 });
    await performance.complete({ totalElapsedMs: 10 });

    await expect(states.get()).resolves.toEqual({
      manifest: { executionId: "fixture-run" },
      latest: { status: "complete" },
    });
    await expect(performanceQuery.get({ executionId: "fixture-run" })).resolves.toEqual({
      totalElapsedMs: 10,
    });
    expect(attempts).toEqual([{ worker: "fixture-agent", elapsedMs: 10 }]);
  });
});
