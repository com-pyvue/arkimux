import { validateRunActor, type RunActor } from "./runActor.ts";
import {
  validateRunRef,
  validateRunTargetRef,
  type RunRef,
  type RunTargetRef,
} from "./runIdentity.ts";
import {
  validateWorkflowIdentity,
  type WorkflowIdentity,
} from "./workflowIdentity.ts";
import {
  validateRunConfigurationReference,
  type RunConfigurationReference,
} from "./runConfigurationReference.ts";
import {
  validateEnvironmentRef,
  validateOrganizationRef,
  validateWorkflowDeploymentRef,
  type EnvironmentRef,
  type OrganizationRef,
  type WorkflowDeploymentRef,
} from "./platformResource.ts";
import { assertExactKeys, isRecord } from "./validation.ts";

export interface LegacyCommitRunManifestV1<TCommit> {
  schemaVersion: 1;
  runId: string;
  commit: TCommit;
  createdAt: string;
}

export interface RunManifestV2 {
  schemaVersion: 2;
  runRef: RunRef;
  workflow: WorkflowIdentity;
  target?: RunTargetRef;
  createdAt: string;
  actor: RunActor;
}

export interface RunManifestV3 {
  schemaVersion: 3;
  runRef: RunRef;
  workflow: WorkflowIdentity;
  target?: RunTargetRef;
  createdAt: string;
  actor: RunActor;
  runConfiguration: RunConfigurationReference;
}

export type RunExecutionMode = "local" | "hybrid" | "cloud";

export interface RunManifestV5 {
  schemaVersion: 5;
  runRef: RunRef;
  workflow: WorkflowIdentity;
  target?: RunTargetRef;
  createdAt: string;
  actor: RunActor;
  runConfiguration: RunConfigurationReference;
  organization?: OrganizationRef;
  environment?: EnvironmentRef;
  workflowDeployment?: WorkflowDeploymentRef;
  executionMode: RunExecutionMode;
}

export function validateRunManifestV2(value: unknown): RunManifestV2 {
  if (!isRecord(value)) throw new Error("Run manifest must be an object.");
  const expectedKeys = ["schemaVersion", "runRef", "workflow", "createdAt", "actor"];
  const allowedKeys = [...expectedKeys, "target"];
  assertExactKeys(value, expectedKeys, "Run manifest", allowedKeys);
  if (value.schemaVersion !== 2) {
    throw new Error("Run manifest.schemaVersion must be 2.");
  }
  if (typeof value.createdAt !== "string" || !isCanonicalIsoTimestamp(value.createdAt)) {
    throw new Error("Run manifest.createdAt must be a canonical ISO-8601 timestamp.");
  }
  return {
    schemaVersion: 2,
    runRef: validateRunRef(value.runRef),
    workflow: validateWorkflowIdentity(value.workflow),
    ...(value.target === undefined ? {} : { target: validateRunTargetRef(value.target) }),
    createdAt: value.createdAt,
    actor: validateRunActor(value.actor),
  };
}

export function validateRunManifestV3(value: unknown): RunManifestV3 {
  if (!isRecord(value)) throw new Error("Run manifest must be an object.");
  const expectedKeys = [
    "schemaVersion",
    "runRef",
    "workflow",
    "createdAt",
    "actor",
    "runConfiguration",
  ];
  const allowedKeys = [...expectedKeys, "target"];
  assertExactKeys(value, expectedKeys, "Run manifest", allowedKeys);
  if (value.schemaVersion !== 3) {
    throw new Error("Run manifest.schemaVersion must be 3.");
  }
  if (typeof value.createdAt !== "string" || !isCanonicalIsoTimestamp(value.createdAt)) {
    throw new Error("Run manifest.createdAt must be a canonical ISO-8601 timestamp.");
  }
  return {
    schemaVersion: 3,
    runRef: validateRunRef(value.runRef),
    workflow: validateWorkflowIdentity(value.workflow),
    ...(value.target === undefined ? {} : { target: validateRunTargetRef(value.target) }),
    createdAt: value.createdAt,
    actor: validateRunActor(value.actor),
    runConfiguration: validateRunConfigurationReference(value.runConfiguration),
  };
}

export function validateRunManifestV5(value: unknown): RunManifestV5 {
  if (!isRecord(value)) throw new Error("Run manifest must be an object.");
  const expectedKeys = [
    "schemaVersion",
    "runRef",
    "workflow",
    "createdAt",
    "actor",
    "runConfiguration",
    "executionMode",
  ];
  const allowedKeys = [
    ...expectedKeys,
    "target",
    "organization",
    "environment",
    "workflowDeployment",
  ];
  assertExactKeys(value, expectedKeys, "Run manifest", allowedKeys);
  if (value.schemaVersion !== 5) throw new Error("Run manifest.schemaVersion must be 5.");
  if (typeof value.createdAt !== "string" || !isCanonicalIsoTimestamp(value.createdAt)) {
    throw new Error("Run manifest.createdAt must be a canonical ISO-8601 timestamp.");
  }
  if (value.executionMode !== "local" && value.executionMode !== "hybrid" && value.executionMode !== "cloud") {
    throw new Error("Run manifest.executionMode must be local, hybrid, or cloud.");
  }
  const hasOrganization = value.organization !== undefined;
  const hasEnvironment = value.environment !== undefined;
  const hasWorkflowDeployment = value.workflowDeployment !== undefined;
  if (value.executionMode === "local" && (hasOrganization || hasEnvironment || hasWorkflowDeployment)) {
    throw new Error("A local run manifest must not contain organization, environment, or workflowDeployment.");
  }
  if (value.executionMode === "hybrid" && (!hasOrganization || !hasEnvironment || hasWorkflowDeployment)) {
    throw new Error("A hybrid run manifest requires organization and environment and must not contain workflowDeployment.");
  }
  if (value.executionMode === "cloud" && (!hasOrganization || !hasEnvironment || !hasWorkflowDeployment)) {
    throw new Error("A cloud run manifest requires organization, environment, and workflowDeployment.");
  }
  return {
    schemaVersion: 5,
    runRef: validateRunRef(value.runRef),
    workflow: validateWorkflowIdentity(value.workflow),
    ...(value.target === undefined ? {} : { target: validateRunTargetRef(value.target) }),
    createdAt: value.createdAt,
    actor: validateRunActor(value.actor),
    runConfiguration: validateRunConfigurationReference(value.runConfiguration),
    ...(value.organization === undefined ? {} : { organization: validateOrganizationRef(value.organization) }),
    ...(value.environment === undefined ? {} : { environment: validateEnvironmentRef(value.environment) }),
    ...(value.workflowDeployment === undefined ? {} : {
      workflowDeployment: validateWorkflowDeploymentRef(value.workflowDeployment),
    }),
    executionMode: value.executionMode,
  };
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
