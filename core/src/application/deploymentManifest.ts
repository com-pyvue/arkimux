import { createHash } from "node:crypto";
import {
  validateEnvironmentPlacement,
  validateEnvironmentRef,
  validateOrganizationRef,
  validateWorkflowDeploymentRef,
  validateWorkflowReleaseRef,
  type EnvironmentPlacement,
  type EnvironmentRef,
  type OrganizationRef,
  type WorkflowDeploymentRef,
  type WorkflowReleaseRef,
} from "../domain/platformResource.ts";
import { assertSafeIdentifier } from "../domain/identifiers.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";
import { canonicalTimestamp, positiveInteger, requiredString } from "./recordValidation.ts";

export interface VersionedBundleReference {
  bundleId: string;
  bundleVersion: number;
  parameters: Record<string, unknown>;
}

interface DeploymentManifestBaseV1 {
  schemaVersion: 1;
  manifestId: string;
  manifestDigest: string;
  organization: OrganizationRef;
  environment: EnvironmentRef;
  definitionVersion: number;
  placement: EnvironmentPlacement;
  registrationClaimRef: string;
  platformEndpoint: string;
  issuedAt: string;
  expiresAt: string;
}

export interface EnvironmentDeploymentManifestV1 extends DeploymentManifestBaseV1 {
  kind: "environment";
  dataApiBundle: VersionedBundleReference;
}

export interface WorkflowDeploymentManifestV1 extends DeploymentManifestBaseV1 {
  kind: "workflow";
  workflowDeployment: WorkflowDeploymentRef;
  release: WorkflowReleaseRef;
  executionBundle: VersionedBundleReference;
  dataApiIntegrationRef: string;
}

export type DeploymentManifestV1 =
  | EnvironmentDeploymentManifestV1
  | WorkflowDeploymentManifestV1;

export function validateDeploymentManifestV1(value: unknown): DeploymentManifestV1 {
  if (!isRecord(value)) throw new Error("Deployment manifest must be an object.");
  if (value.kind === "environment") return validateEnvironmentDeploymentManifestV1(value);
  if (value.kind === "workflow") return validateWorkflowDeploymentManifestV1(value);
  throw new Error("Deployment manifest.kind must be environment or workflow.");
}

export function validateEnvironmentDeploymentManifestV1(
  value: unknown,
): EnvironmentDeploymentManifestV1 {
  const record = manifestRecord(value, "Environment deployment manifest", ["dataApiBundle"]);
  if (record.kind !== "environment") {
    throw new Error("Environment deployment manifest.kind must be environment.");
  }
  const manifest: EnvironmentDeploymentManifestV1 = {
    ...parseBase(record),
    kind: "environment",
    dataApiBundle: validateBundle(record.dataApiBundle, "Environment deployment manifest.dataApiBundle"),
  };
  validateManifestDigest(manifest);
  return manifest;
}

export function validateWorkflowDeploymentManifestV1(
  value: unknown,
): WorkflowDeploymentManifestV1 {
  const record = manifestRecord(value, "Workflow deployment manifest", [
    "workflowDeployment",
    "release",
    "executionBundle",
    "dataApiIntegrationRef",
  ]);
  if (record.kind !== "workflow") {
    throw new Error("Workflow deployment manifest.kind must be workflow.");
  }
  assertSafeIdentifier(
    record.dataApiIntegrationRef,
    "Workflow deployment manifest.dataApiIntegrationRef",
  );
  const manifest: WorkflowDeploymentManifestV1 = {
    ...parseBase(record),
    kind: "workflow",
    workflowDeployment: validateWorkflowDeploymentRef(record.workflowDeployment),
    release: validateWorkflowReleaseRef(record.release),
    executionBundle: validateBundle(record.executionBundle, "Workflow deployment manifest.executionBundle"),
    dataApiIntegrationRef: record.dataApiIntegrationRef,
  };
  validateManifestDigest(manifest);
  return manifest;
}

export function deploymentManifestDigest(value: Omit<DeploymentManifestV1, "manifestDigest">): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertDeploymentManifestCurrent(manifest: DeploymentManifestV1, now: Date): void {
  const current = now.getTime();
  if (current < Date.parse(manifest.issuedAt)) throw new Error("Deployment manifest is not active yet.");
  if (current >= Date.parse(manifest.expiresAt)) throw new Error("Deployment manifest has expired.");
}

const baseKeys = [
  "schemaVersion",
  "kind",
  "manifestId",
  "manifestDigest",
  "organization",
  "environment",
  "definitionVersion",
  "placement",
  "registrationClaimRef",
  "platformEndpoint",
  "issuedAt",
  "expiresAt",
];

function manifestRecord(
  value: unknown,
  location: string,
  specificKeys: string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  assertExactKeys(value, [...baseKeys, ...specificKeys], location);
  return value;
}

function parseBase(record: Record<string, unknown>): DeploymentManifestBaseV1 {
  if (record.schemaVersion !== 1) throw new Error("Deployment manifest.schemaVersion must be 1.");
  assertSafeIdentifier(record.manifestId, "Deployment manifest.manifestId");
  if (typeof record.manifestDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.manifestDigest)) {
    throw new Error("Deployment manifest.manifestDigest must be a lowercase SHA-256 digest.");
  }
  positiveInteger(record.definitionVersion, "Deployment manifest.definitionVersion");
  assertSafeIdentifier(record.registrationClaimRef, "Deployment manifest.registrationClaimRef");
  requiredString(record.platformEndpoint, "Deployment manifest.platformEndpoint");
  validateHttpsUrl(record.platformEndpoint, "Deployment manifest.platformEndpoint");
  canonicalTimestamp(record.issuedAt, "Deployment manifest.issuedAt");
  canonicalTimestamp(record.expiresAt, "Deployment manifest.expiresAt");
  if (Date.parse(record.expiresAt) <= Date.parse(record.issuedAt)) {
    throw new Error("Deployment manifest.expiresAt must be later than issuedAt.");
  }
  return {
    schemaVersion: 1,
    manifestId: record.manifestId,
    manifestDigest: record.manifestDigest,
    organization: validateOrganizationRef(record.organization),
    environment: validateEnvironmentRef(record.environment),
    definitionVersion: record.definitionVersion,
    placement: validateEnvironmentPlacement(record.placement),
    registrationClaimRef: record.registrationClaimRef,
    platformEndpoint: record.platformEndpoint,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  };
}

function validateBundle(value: unknown, location: string): VersionedBundleReference {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  assertExactKeys(value, ["bundleId", "bundleVersion", "parameters"], location);
  assertSafeIdentifier(value.bundleId, `${location}.bundleId`);
  positiveInteger(value.bundleVersion, `${location}.bundleVersion`);
  if (!isRecord(value.parameters)) throw new Error(`${location}.parameters must be an object.`);
  return {
    bundleId: value.bundleId,
    bundleVersion: value.bundleVersion,
    parameters: jsonClone(value.parameters, `${location}.parameters`),
  };
}

function validateManifestDigest(manifest: DeploymentManifestV1): void {
  const { manifestDigest, ...unsigned } = manifest;
  const actual = deploymentManifestDigest(unsigned);
  if (manifestDigest !== actual) throw new Error("Deployment manifest digest does not match its content.");
}

function validateHttpsUrl(value: string, location: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${location} must be an HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`${location} must be an HTTPS URL.`);
  }
}

function jsonClone(value: Record<string, unknown>, location: string): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    throw new Error(`${location} must contain only JSON values.`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
