import type {
  EnvironmentPlacement,
  EnvironmentRef,
  OrganizationRef,
  WorkflowDeploymentRef,
  WorkflowReleaseRef,
} from "../domain/platformResource.ts";
import type { Page, PageQuery } from "./platformStore.ts";

export interface Organization {
  schemaVersion: 1;
  organizationId: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt: string;
}

export interface EnvironmentDefinition {
  schemaVersion: 1;
  organization: OrganizationRef;
  environment: EnvironmentRef;
  displayName: string;
  placement: EnvironmentPlacement;
  definitionVersion: number;
  dataApiBundleId: string;
  dataApiBundleVersion: number;
  status: "draft" | "deploying" | "ready" | "unhealthy" | "decommissioning" | "decommissioned";
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRelease {
  schemaVersion: 1;
  organization: OrganizationRef;
  release: WorkflowReleaseRef;
  createdAt: string;
}

export interface WorkflowDeployment {
  schemaVersion: 1;
  organization: OrganizationRef;
  environment: EnvironmentRef;
  workflowDeployment: WorkflowDeploymentRef;
  release: WorkflowReleaseRef;
  definitionVersion: number;
  executionBundleId: string;
  executionBundleVersion: number;
  status: "draft" | "deploying" | "ready" | "unhealthy" | "decommissioning" | "decommissioned";
  dispatchReady: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationStore {
  create(organization: Organization): Promise<void>;
  get(ref: OrganizationRef): Promise<Organization | undefined>;
  list(query?: PageQuery): Promise<Page<Organization>>;
  setStatus(ref: OrganizationRef, status: Organization["status"]): Promise<void>;
}

export interface EnvironmentStore {
  publish(definition: EnvironmentDefinition): Promise<void>;
  get(organization: OrganizationRef, environment: EnvironmentRef): Promise<EnvironmentDefinition | undefined>;
  list(organization: OrganizationRef, query?: PageQuery): Promise<Page<EnvironmentDefinition>>;
  updateStatus(organization: OrganizationRef, environment: EnvironmentRef, status: EnvironmentDefinition["status"], updatedAt: string): Promise<void>;
}

export interface WorkflowReleaseStore {
  publish(release: WorkflowRelease): Promise<void>;
  get(organization: OrganizationRef, release: WorkflowReleaseRef): Promise<WorkflowRelease | undefined>;
  list(organization: OrganizationRef, query?: PageQuery): Promise<Page<WorkflowRelease>>;
}

export interface WorkflowDeploymentStore {
  publish(deployment: WorkflowDeployment): Promise<void>;
  get(organization: OrganizationRef, deployment: WorkflowDeploymentRef): Promise<WorkflowDeployment | undefined>;
  list(organization: OrganizationRef, environment?: EnvironmentRef, query?: PageQuery): Promise<Page<WorkflowDeployment>>;
  updateReadiness(organization: OrganizationRef, deployment: WorkflowDeploymentRef, status: WorkflowDeployment["status"], dispatchReady: boolean, updatedAt: string): Promise<void>;
}

export type DeploymentHealthTarget =
  | { kind: "environment"; organization: OrganizationRef; environment: EnvironmentRef }
  | { kind: "workflow"; organization: OrganizationRef; environment: EnvironmentRef; workflowDeployment: WorkflowDeploymentRef };

export interface DeploymentHealthRecord {
  schemaVersion: 1;
  target: DeploymentHealthTarget;
  status: "healthy" | "unhealthy" | "decommissioned";
  revision: number;
  checkedAt: string;
  details?: Record<string, string>;
}

export interface DeploymentHealthStore {
  record(value: DeploymentHealthRecord): Promise<void>;
  get(target: DeploymentHealthTarget): Promise<DeploymentHealthRecord | undefined>;
}

export interface MeterRecord {
  schemaVersion: 1;
  meterId: string;
  organization: OrganizationRef;
  environment: EnvironmentRef;
  workflowDeployment?: WorkflowDeploymentRef;
  meterKind: string;
  quantity: number;
  unit: string;
  occurredAt: string;
}

export interface MeterRecordStore {
  record(value: MeterRecord): Promise<void>;
  list(organization: OrganizationRef, environment?: EnvironmentRef, query?: PageQuery): Promise<Page<MeterRecord>>;
}
