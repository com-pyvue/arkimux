import type {
  RunArtifactStore,
  RunEventSink,
} from "../../application/runLifecycle.ts";

export class JsonlRunEventSink<TEvent> implements RunEventSink<TEvent> {
  private sequence = 0;

  constructor(private readonly artifacts: RunArtifactStore) {}

  async emit(event: TEvent): Promise<void> {
    await this.artifacts.appendRecord("events.jsonl", this.sequence, event);
    this.sequence += 1;
  }
}
