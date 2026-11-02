import type { RunEventSink } from "./runLifecycle.ts";

export class CompositeRunEventSink<TEvent> implements RunEventSink<TEvent> {
  constructor(private readonly sinks: readonly RunEventSink<TEvent>[]) {}

  async emit(event: TEvent): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.emit(event)));
  }
}
