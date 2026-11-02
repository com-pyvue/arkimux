import type { RunEvent } from "../../application/runEvent.ts";
import type { RunEventSink } from "../../application/runLifecycle.ts";

export type ConsoleLineWriter = (line: string) => void | Promise<void>;

export class ConsoleRunEventSink implements RunEventSink<RunEvent> {
  constructor(
    private readonly prefix = "[agent-execution]",
    private readonly writeLine: ConsoleLineWriter = (line) => console.error(line),
  ) {}

  async emit(event: RunEvent): Promise<void> {
    if (event.type === "stage-started") {
      await this.writeLine(`${this.prefix} ${event.stageId}`);
    } else if (event.type === "agent-started") {
      await this.writeLine(
        `${this.prefix} ${event.logicalAgentId} via ${event.providerId} attempt ${event.attempt}`,
      );
    } else if (event.type === "agent-completed") {
      await this.writeLine(
        `${this.prefix} ${event.logicalAgentId} via ${event.providerId} completed in ${event.metrics.elapsedMs}ms`,
      );
    } else if (event.type === "agent-timed-out") {
      await this.writeLine(`${this.prefix} ${event.logicalAgentId} via ${event.providerId} timed out`);
    } else if (event.type === "agent-failed") {
      await this.writeLine(`${this.prefix} ${event.logicalAgentId} via ${event.providerId} failed`);
    } else if (event.type === "run-failed") {
      await this.writeLine(`${this.prefix} FAILED: ${event.message}`);
    }
  }
}
