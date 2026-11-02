import type { PublishedResultStore } from "./publishedResult.ts";
import type { RunArtifactStore } from "./runLifecycle.ts";
import type { RunPerformanceStore } from "./runPerformance.ts";
import type { ReservableRunStateV3Store } from "./runState.ts";
import type { RunActor } from "../domain/runActor.ts";
import type { RunRef, RunTargetRef } from "../domain/runIdentity.ts";
import type { WorkflowIdentity } from "../domain/workflowIdentity.ts";
import type {
  EnvironmentRef,
  OrganizationRef,
  WorkflowDeploymentRef,
} from "../domain/platformResource.ts";
import type { RunExecutionMode } from "../domain/runManifest.ts";
import type {
  StoreAdapterFactory,
  StoreAdapterRegistry,
  StorePreflightResult,
} from "./storeAdapter.ts";

export type ExecutionStoreRole =
  | "run-state"
  | "run-artifact"
  | "run-performance"
  | "published-result";

export interface ExecutionStorePortByRole<
  TRunStateStore = ReservableRunStateV3Store,
> {
  "run-state": TRunStateStore;
  "run-artifact": RunArtifactStore;
  "run-performance": RunPerformanceStore;
  "published-result": PublishedResultStore;
}

export interface ExecutionStoreAdapterContext {
  options: Record<string, unknown>;
  runRef: RunRef;
  workflow: WorkflowIdentity;
  target?: RunTargetRef;
  actor: RunActor;
  localOutputRoot?: string;
  organization?: OrganizationRef;
  environment?: EnvironmentRef;
  workflowDeployment?: WorkflowDeploymentRef;
  executionMode?: RunExecutionMode;
}

export type ExecutionStorePreflightResult = StorePreflightResult<ExecutionStoreRole>;

export type ExecutionStoreAdapterFactory<TStore = unknown> = StoreAdapterFactory<
  ExecutionStoreRole,
  TStore,
  ExecutionStoreAdapterContext
>;

export type ExecutionStoreAdapterRegistry<
  TRunStateStore = ReservableRunStateV3Store,
> = StoreAdapterRegistry<
  ExecutionStoreRole,
  ExecutionStorePortByRole<TRunStateStore>,
  ExecutionStoreAdapterContext
>;
