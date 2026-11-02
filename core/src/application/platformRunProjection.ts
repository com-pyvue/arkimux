import type { RunUsageSummary } from "./runPerformance.ts";
import { validateRunRef, type RunRef } from "../domain/runIdentity.ts";
import {
  validateEnvironmentRef,
  validateOrganizationRef,
  validateWorkflowDeploymentRef,
  type EnvironmentRef,
  type OrganizationRef,
  type WorkflowDeploymentRef,
} from "../domain/platformResource.ts";
import { validateWorkflowIdentity, type WorkflowIdentity } from "../domain/workflowIdentity.ts";

export type PlatformRunStatus = "accepted" | "running" | "waiting_for_input" | "resume_queued" | "complete" | "failed" | "cancelled" | "archived";
export type CanonicalResultAvailability = "environment" | "archive" | "unavailable";

export interface PlatformRunProjectionV1 {
  schemaVersion: 1;
  organization: OrganizationRef;
  environment: EnvironmentRef;
  runRef: RunRef;
  workflow: WorkflowIdentity;
  workflowDeployment?: WorkflowDeploymentRef;
  status: PlatformRunStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
  aggregatePerformance?: RunUsageSummary & { totalElapsedMs?: number };
  canonicalResultAvailability: CanonicalResultAvailability;
  sourceFreshnessAt: string;
}

export type PlatformRunEventType =
  | "run.accepted"
  | "run.running"
  | "run.waiting-for-input"
  | "run.resume-queued"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.performance-updated"
  | "run.archived";

export interface PlatformRunEventV1 {
  schemaVersion: 1;
  eventId: string;
  type: PlatformRunEventType;
  organization: OrganizationRef;
  environment: EnvironmentRef;
  runRef: RunRef;
  workflow: WorkflowIdentity;
  workflowDeployment?: WorkflowDeploymentRef;
  revision: number;
  occurredAt: string;
  status: PlatformRunStatus;
  aggregatePerformance?: PlatformRunProjectionV1["aggregatePerformance"];
  canonicalResultAvailability: CanonicalResultAvailability;
}

export interface PlatformRunProjectionQuery {
  organization: OrganizationRef;
  environment?: EnvironmentRef;
  workflow?: WorkflowIdentity;
  status?: PlatformRunStatus;
  pageSize?: number;
  cursor?: string;
}

export interface PlatformRunProjectionPage {
  items: PlatformRunProjectionV1[];
  nextCursor?: string;
}

export interface PlatformRunProjectionStore {
  apply(event: PlatformRunEventV1): Promise<PlatformRunProjectionV1>;
  get(organization: OrganizationRef, environment: EnvironmentRef, runRef: RunRef): Promise<PlatformRunProjectionV1 | undefined>;
  list(query: PlatformRunProjectionQuery): Promise<PlatformRunProjectionPage>;
}

export function projectionIdentity(value: PlatformRunProjectionV1): string {
  const organization = validateOrganizationRef(value.organization);
  const environment = validateEnvironmentRef(value.environment);
  const runRef = validateRunRef(value.runRef);
  validateWorkflowIdentity(value.workflow);
  if (value.workflowDeployment !== undefined) validateWorkflowDeploymentRef(value.workflowDeployment);
  return `${organization.organizationId}:${environment.environmentId}:${runRef.executionId}`;
}
