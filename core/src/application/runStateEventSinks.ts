import type { RunEvent } from "./runEvent.ts";
import type { RunEventSink } from "./runLifecycle.ts";
import type { ReservableRunStateStore } from "./runState.ts";

type RunStateProjectionWriter = Pick<ReservableRunStateStore, "update">;

export class RunStatusEventSink implements RunEventSink<RunEvent> {
  constructor(private readonly state: RunStateProjectionWriter) {}

  async emit(event: RunEvent): Promise<void> {
    if (event.type === "stage-started") {
      await this.state.update({
        kind: "status",
        status: "running",
        updatedAt: event.at,
        stageId: event.stageId,
      });
    } else if (event.type === "run-completed") {
      await this.state.update({ kind: "status", status: "complete", updatedAt: event.at });
    } else if (event.type === "run-failed") {
      await this.state.update({
        kind: "status",
        status: "failed",
        updatedAt: event.at,
        message: event.message,
      });
    }
  }
}

export class HeartbeatRunEventSink implements RunEventSink<RunEvent> {
  constructor(private readonly state: RunStateProjectionWriter) {}

  async emit(event: RunEvent): Promise<void> {
    await this.state.update({
      kind: "heartbeat",
      status: event.type === "run-completed"
        ? "complete"
        : event.type === "run-failed"
          ? "failed"
          : "running",
      lastEventType: event.type,
      updatedAt: event.at,
      ...("stageId" in event ? { stageId: event.stageId } : {}),
      ...("logicalAgentId" in event ? { logicalAgentId: event.logicalAgentId } : {}),
      ...("providerId" in event ? { providerId: event.providerId } : {}),
    });
  }
}
