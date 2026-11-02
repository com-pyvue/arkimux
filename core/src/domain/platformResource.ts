import { assertSafeIdentifier } from "./identifiers.ts";
import { validateWorkflowIdentity, type WorkflowIdentity } from "./workflowIdentity.ts";
import { assertExactKeys, isRecord } from "./validation.ts";

export interface OrganizationRef {
  organizationId: string;
}

export interface EnvironmentRef {
  environmentId: string;
}

export interface WorkflowDeploymentRef {
  workflowDeploymentId: string;
}

export interface WorkflowReleaseRef {
  workflow: WorkflowIdentity;
  releaseId: string;
  sourceCommit: string;
  imageDigest: string;
}

export type CloudProvider = "aws" | "gcp";
export type EnvironmentOwner = "customer" | "managed";

export interface EnvironmentPlacement {
  provider: CloudProvider;
  owner: EnvironmentOwner;
  accountOrProjectId: string;
  region: string;
}

export function validateOrganizationRef(value: unknown): OrganizationRef {
  const record = requireRecord(value, "Organization reference");
  assertExactKeys(record, ["organizationId"], "Organization reference");
  assertSafeIdentifier(record.organizationId, "Organization reference.organizationId");
  return { organizationId: record.organizationId };
}

export function validateEnvironmentRef(value: unknown): EnvironmentRef {
  const record = requireRecord(value, "Environment reference");
  assertExactKeys(record, ["environmentId"], "Environment reference");
  assertSafeIdentifier(record.environmentId, "Environment reference.environmentId");
  return { environmentId: record.environmentId };
}

export function validateWorkflowDeploymentRef(value: unknown): WorkflowDeploymentRef {
  const record = requireRecord(value, "Workflow deployment reference");
  assertExactKeys(record, ["workflowDeploymentId"], "Workflow deployment reference");
  assertSafeIdentifier(
    record.workflowDeploymentId,
    "Workflow deployment reference.workflowDeploymentId",
  );
  return { workflowDeploymentId: record.workflowDeploymentId };
}

export function validateWorkflowReleaseRef(value: unknown): WorkflowReleaseRef {
  const record = requireRecord(value, "Workflow release reference");
  assertExactKeys(
    record,
    ["workflow", "releaseId", "sourceCommit", "imageDigest"],
    "Workflow release reference",
  );
  assertSafeIdentifier(record.releaseId, "Workflow release reference.releaseId");
  if (typeof record.sourceCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(record.sourceCommit)) {
    throw new Error("Workflow release reference.sourceCommit must be a lowercase hexadecimal commit digest.");
  }
  if (typeof record.imageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.imageDigest)) {
    throw new Error("Workflow release reference.imageDigest must be a sha256 OCI digest.");
  }
  return {
    workflow: validateWorkflowIdentity(record.workflow),
    releaseId: record.releaseId,
    sourceCommit: record.sourceCommit,
    imageDigest: record.imageDigest,
  };
}

export function validateEnvironmentPlacement(value: unknown): EnvironmentPlacement {
  const record = requireRecord(value, "Environment placement");
  assertExactKeys(
    record,
    ["provider", "owner", "accountOrProjectId", "region"],
    "Environment placement",
  );
  if (record.provider !== "aws" && record.provider !== "gcp") {
    throw new Error("Environment placement.provider must be aws or gcp.");
  }
  if (record.owner !== "customer" && record.owner !== "managed") {
    throw new Error("Environment placement.owner must be customer or managed.");
  }
  const accountOrProjectId = placementString(
    record.accountOrProjectId,
    "Environment placement.accountOrProjectId",
  );
  const region = placementString(record.region, "Environment placement.region");
  return {
    provider: record.provider,
    owner: record.owner,
    accountOrProjectId,
    region,
  };
}

function placementString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Error(`${location} must be a non-empty string of at most 128 characters.`);
  }
  return value;
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  return value;
}
