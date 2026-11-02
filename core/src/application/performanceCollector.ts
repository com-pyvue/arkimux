import type { RunEvent } from "./runEvent.ts";
import type { RunEventSink } from "./runLifecycle.ts";
import {
  aggregateRunUsage,
  validateRunPerformance,
  type AgentAttemptPerformanceRecord,
  type RunPerformance,
  type RunPerformanceStore,
  type StagePerformanceRecord,
} from "./runPerformance.ts";
import type { RunManifestV2, RunManifestV3 } from "../domain/runManifest.ts";

export class PerformanceCollector implements RunEventSink<RunEvent> {
  private manifest?: RunManifestV2 | RunManifestV3;
  private startedAt?: string;
  private latestAt?: string;
  private readonly stageStarts = new Map<string, string>();
  private stages: StagePerformanceRecord[] = [];
  private agentAttempts: AgentAttemptPerformanceRecord[] = [];
  private completed?: RunPerformance;

  constructor(private readonly store: RunPerformanceStore) {}

  async emit(event: RunEvent): Promise<void> {
    this.latestAt = event.at;
    if (event.type === "run-started") {
      this.manifest = event.manifest;
      this.startedAt = event.at;
      this.stageStarts.clear();
      this.stages = [];
      this.agentAttempts = [];
      this.completed = undefined;
      return;
    }
    if (event.type === "stage-started") {
      this.stageStarts.set(event.stageId, event.at);
      return;
    }
    if (event.type === "stage-completed" || event.type === "stage-failed") {
      this.stages.push({
        stageId: event.stageId,
        status: event.type === "stage-completed" ? "complete" : "failed",
        elapsedMs: event.elapsedMs,
      });
      this.stageStarts.delete(event.stageId);
      return;
    }
    if (
      event.type === "agent-completed"
      || event.type === "agent-timed-out"
      || (event.type === "agent-failed" && event.metrics !== undefined)
    ) {
      const metrics = event.metrics;
      if (metrics === undefined) return;
      const attempt = {
        stageId: event.stageId,
        logicalAgentId: event.logicalAgentId,
        metrics,
      };
      this.agentAttempts.push(attempt);
      await this.store.recordAttempt(attempt);
      return;
    }
    if (event.type === "run-completed" || event.type === "run-failed") {
      const summary = this.snapshot();
      await this.store.complete(summary);
      this.completed = summary;
    }
  }

  snapshot(): RunPerformance {
    if (!this.manifest || !this.startedAt || !this.latestAt) {
      throw new Error("Performance cannot be projected before the run-started event.");
    }
    if (this.completed) return this.completed;
    const summary: RunPerformance = {
      schemaVersion: 1,
      runRef: this.manifest.runRef,
      workflow: this.manifest.workflow,
      startedAt: this.startedAt,
      completedAt: this.latestAt,
      totalElapsedMs: Math.max(0, Date.parse(this.latestAt) - Date.parse(this.startedAt)),
      stages: [...this.stages],
      agentAttempts: [...this.agentAttempts],
      ...(aggregateRunUsage(this.agentAttempts) === undefined
        ? {}
        : { usage: aggregateRunUsage(this.agentAttempts) }),
    };
    return validateRunPerformance(summary);
  }
}
