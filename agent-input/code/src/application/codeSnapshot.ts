export interface CodeCommit {
  hash: string;
  shortHash: string;
}

export interface CodeSnapshot {
  root: string;
  commit: CodeCommit;
  dispose(): Promise<void>;
}

export interface CodeSnapshotRequest {
  repositoryRoot: string;
  ref: string;
  outputRoot: string;
  executionId: string;
  keepSnapshot: boolean;
}

export interface CodeSnapshotProvider {
  prepare(request: CodeSnapshotRequest): Promise<CodeSnapshot>;
}
