export interface StoredArtifact {
  key: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

export interface RunArtifactStore {
  scope(...segments: string[]): RunArtifactStore;
  writeJson<T>(name: string, value: T): Promise<StoredArtifact>;
  writeText(name: string, value: string): Promise<StoredArtifact>;
  appendRecord<T>(name: string, sequence: number, value: T): Promise<void>;
}

export interface RunStateStore<TManifest, TProjection, TState> {
  create(manifest: TManifest): Promise<void>;
  update(projection: TProjection): Promise<void>;
  get(): Promise<TState | undefined>;
}

export interface RunPerformanceWriteStore<TAttempt, TSummary> {
  recordAttempt(record: TAttempt): Promise<void>;
  complete(summary: TSummary): Promise<void>;
}

export interface RunPerformanceReader<TSummary, TQuery> {
  get(query: TQuery): Promise<TSummary | undefined>;
}

export interface RunEventSink<TEvent> {
  emit(event: TEvent): Promise<void>;
}
