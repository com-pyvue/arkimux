import { describe, expect, it } from "vitest";
import {
  assertDeploymentManifestCurrent,
  deploymentManifestDigest,
  projectionIdentity,
  validateDeploymentManifestV1,
  validateEnvironmentPlacement,
  validateHybridEnvironmentAccessV1,
  validateRunManifestV5,
  validateWorkflowReleaseRef,
  type EnvironmentDeploymentManifestV1,
} from "../../core/src/index.ts";

const actor = { userId: "yuryp", roleId: "runner" };
const runConfiguration = { configurationId: "fixture-v3", contentHash: "a".repeat(64) };

describe("agent-execution cloud contracts", () => {
  it("validates provider-neutral placement and immutable release references", () => {
    expect(validateEnvironmentPlacement({
      provider: "aws",
      owner: "customer",
      accountOrProjectId: "123456789012",
      region: "us-east-1",
    })).toMatchObject({ provider: "aws", owner: "customer" });
    expect(validateWorkflowReleaseRef({
      workflow: { kind: "system-model.stack-discovery", version: 2 },
      releaseId: "release-01",
      sourceCommit: "b".repeat(40),
      imageDigest: `sha256:${"c".repeat(64)}`,
    })).toMatchObject({ releaseId: "release-01" });
  });

  it("enforces the local, hybrid, and cloud schema-v5 placement rules", () => {
    const base = {
      schemaVersion: 5,
      runRef: { executionId: "run-01" },
      workflow: { kind: "fixture.workflow", version: 1 },
      createdAt: "2026-08-07T12:00:00.000Z",
      actor,
      runConfiguration,
    } as const;
    expect(validateRunManifestV5({ ...base, executionMode: "local" })).toMatchObject({ executionMode: "local" });
    expect(validateRunManifestV5({
      ...base,
      executionMode: "hybrid",
      organization: { organizationId: "org-01" },
      environment: { environmentId: "production" },
    })).toMatchObject({ executionMode: "hybrid" });
    expect(validateRunManifestV5({
      ...base,
      executionMode: "cloud",
      organization: { organizationId: "org-01" },
      environment: { environmentId: "production" },
      workflowDeployment: { workflowDeploymentId: "stack-discovery-prod" },
    })).toMatchObject({ executionMode: "cloud" });
    expect(() => validateRunManifestV5({ ...base, executionMode: "hybrid" })).toThrow(
      "requires organization and environment",
    );
  });

  it("binds deployment manifests to exact content and expiry", () => {
    const unsigned = {
      schemaVersion: 1,
      kind: "environment",
      manifestId: "manifest-01",
      organization: { organizationId: "org-01" },
      environment: { environmentId: "production" },
      definitionVersion: 1,
      placement: {
        provider: "aws",
        owner: "customer",
        accountOrProjectId: "123456789012",
        region: "us-east-1",
      },
      dataApiBundle: {
        bundleId: "aws-data-api",
        bundleVersion: 1,
        parameters: { removalPolicy: "retain" },
      },
      platformEndpoint: "https://platform.example.com",
      registrationClaimRef: "claim-01",
      issuedAt: "2026-08-07T12:00:00.000Z",
      expiresAt: "2026-08-07T13:00:00.000Z",
    } as const;
    const manifest = {
      ...unsigned,
      manifestDigest: deploymentManifestDigest(unsigned),
    } as EnvironmentDeploymentManifestV1;
    expect(validateDeploymentManifestV1(manifest)).toEqual(manifest);
    expect(() => validateDeploymentManifestV1({
      ...manifest,
      definitionVersion: 2,
    })).toThrow("digest does not match");
    expect(() => assertDeploymentManifestCurrent(manifest, new Date("2026-08-07T13:00:00.000Z")))
      .toThrow("expired");
  });

  it("accepts non-secret hybrid integration configuration and rejects credentials", () => {
    const access = {
      schemaVersion: 1,
      organization: { organizationId: "org-01" },
      environment: { environmentId: "production" },
      placement: {
        provider: "aws",
        owner: "customer",
        accountOrProjectId: "123456789012",
        region: "us-east-1",
      },
      adapterContracts: {
        runState: "dynamodb-run-state@1",
        runArtifacts: "s3-run-artifacts@1",
        runPerformance: "dynamodb-run-performance@1",
        publishedResults: "s3-published-results@1",
      },
      aws: {
        region: "us-east-1",
        stateTableName: "agent-runs",
        artifactBucketName: "agent-artifacts",
        resultBucketName: "agent-results",
        dataApiBaseUrl: "https://data.example.com",
      },
      platformBaseUrl: "https://platform.example.com",
      generatedAt: "2026-08-07T12:00:00.000Z",
    } as const;
    expect(validateHybridEnvironmentAccessV1(access)).toEqual(access);
    expect(() => validateHybridEnvironmentAccessV1({
      ...access,
      aws: { ...access.aws, accessKey: "forbidden" },
    })).toThrow("unknown fields [accessKey]");
  });

  it("builds a stable identity for central run projections", () => {
    expect(projectionIdentity({
      schemaVersion: 1,
      organization: { organizationId: "org-01" },
      environment: { environmentId: "production" },
      runRef: { executionId: "run-01" },
      workflow: { kind: "fixture.workflow", version: 1 },
      status: "complete",
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:01:00.000Z",
      revision: 2,
      canonicalResultAvailability: "environment",
      sourceFreshnessAt: "2026-08-07T12:01:01.000Z",
    })).toBe("org-01:production:run-01");
  });
});
