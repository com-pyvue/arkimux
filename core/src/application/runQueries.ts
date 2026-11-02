import type { PublishedResultEnvelope, PublishedResultRef } from "./publishedResult.ts";
import type {
  RunHeartbeatProjection,
  RunLifecycleStatus,
  RunStatusProjection,
} from "./runState.ts";
import type { StoredArtifact } from "./runLifecycle.ts";
import type { RunActor } from "../domain/runActor.ts";
import type { RunConfigurationReference } from "../domain/runConfigurationReference.ts";
import type { RunRef, RunTargetRef } from "../domain/runIdentity.ts";
import type { WorkflowIdentity } from "../domain/workflowIdentity.ts";
import type {
  EnvironmentRef,
  OrganizationRef,
  WorkflowDeploymentRef,
} from "../domain/platformResource.ts";
import type { RunExecutionMode } from "../domain/runManifest.ts";

export interface RunCatalogEntry {
  runRef: RunRef;
  workflow: WorkflowIdentity;
  target?: RunTargetRef;
  actor: RunActor;
  createdAt: string;
  runConfiguration?: RunConfigurationReference;
  status?: RunStatusProjection;
  heartbeat?: RunHeartbeatProjection;
  organization?: OrganizationRef;
  environment?: EnvironmentRef;
  workflowDeployment?: WorkflowDeploymentRef;
  executionMode?: RunExecutionMode;
  lifecycleStatus?: RunCatalogLifecycleStatus;
  archivedAt?: string;
}

export type RunCatalogLifecycleStatus = "active" | "archived";

export interface RunCatalogQuery {
  userId?: string;
  workflow?: WorkflowIdentity;
  target?: RunTargetQuery;
  status?: RunLifecycleStatus;
  createdAtOrAfter?: string;
  createdBefore?: string;
  pageSize?: number;
  cursor?: string;
  organization?: OrganizationRef;
  environment?: EnvironmentRef;
  workflowDeployment?: WorkflowDeploymentRef;
  executionMode?: RunExecutionMode;
  lifecycleStatus?: RunCatalogLifecycleStatus | "all";
}

export interface RunTargetQuery {
  kind: string;
  identity?: Record<string, string>;
}

export interface RunCatalogPage {
  items: RunCatalogEntry[];
  nextCursor?: string;
}

export interface RunCatalogStore {
  get(runRef: RunRef): Promise<RunCatalogEntry | undefined>;
  list(query: RunCatalogQuery): Promise<RunCatalogPage>;
  archive(runRef: RunRef, archivedAt: string): Promise<void>;
  restore(runRef: RunRef, restoredAt: string): Promise<void>;
}

export interface RunArtifactQueryStore {
  list(prefix?: string): Promise<StoredArtifact[]>;
  readBytes(key: string): Promise<Uint8Array | undefined>;
  readText(key: string): Promise<string | undefined>;
  readJson(key: string): Promise<unknown | undefined>;
}

export interface PublishedResultQueryStore {
  list(): Promise<PublishedResultRef[]>;
  get(ref: PublishedResultRef): Promise<PublishedResultEnvelope | undefined>;
}
