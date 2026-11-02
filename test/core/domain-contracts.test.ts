import { describe, expect, it } from "vitest";
import {
  assertSafeIdentifier,
  isSafeIdentifier,
  validateRunActor,
  validateRunConfigurationReference,
  validateRunAttribution,
  validateRunManifestV2,
  validateRunManifestV3,
  validateRunRef,
  validateRunTargetRef,
  validateRole,
  validateTrustedRunCommand,
  validateUser,
  validateWorkflowIdentity,
  type LegacyCommitRunManifestV1,
} from "../../core/src/index.ts";

describe("agent-execution domain contracts", () => {
  it("accepts safe identifiers and rejects path-like or oversized values", () => {
    expect(isSafeIdentifier("20260804T120000Z-a1b2c3d4")).toBe(true);
    expect(isSafeIdentifier("fixture.workflow")).toBe(true);
    expect(isSafeIdentifier("../escape")).toBe(false);
    expect(isSafeIdentifier(`a${"b".repeat(128)}`)).toBe(false);
    expect(() => assertSafeIdentifier("contains/slash", "Identifier")).toThrow(
      "Identifier must start with an alphanumeric character",
    );
  });

  it("validates workflow, actor, run, and target identities strictly", () => {
    expect(validateWorkflowIdentity({
      kind: "fixture.workflow",
      version: 2,
    })).toEqual({ kind: "fixture.workflow", version: 2 });
    expect(validateRunActor({ userId: "yuryp", roleId: "agent-execution-user" })).toEqual({
      userId: "yuryp",
      roleId: "agent-execution-user",
    });
    expect(validateRunRef({ executionId: "run-01" })).toEqual({ executionId: "run-01" });
    expect(validateRunAttribution({
      kind: "authenticated",
      actor: { userId: "yuryp", roleId: "agent-execution-user" },
    })).toEqual({
      kind: "authenticated",
      actor: { userId: "yuryp", roleId: "agent-execution-user" },
    });
    expect(validateRunAttribution({ kind: "legacy-unattributed" })).toEqual({
      kind: "legacy-unattributed",
    });
    expect(validateRunTargetRef({
      kind: "git-commit",
      identity: { repository: "timeback-api", commit: "abc123" },
    })).toEqual({
      kind: "git-commit",
      identity: { repository: "timeback-api", commit: "abc123" },
    });

    expect(() => validateWorkflowIdentity({
      kind: "fixture.workflow",
      version: 0,
    })).toThrow("Workflow identity.version must be a positive integer.");
    expect(() => validateRunActor({
      userId: "yuryp",
      roleId: "agent-execution-user",
      token: "secret",
    })).toThrow("Run actor contains unknown fields [token].");
    expect(() => validateRunTargetRef({ kind: "git-commit", identity: {} })).toThrow(
      "Run target.identity must be a non-empty object.",
    );
  });

  it("validates the complete schema-v2 manifest without accepting loose aliases", () => {
    const manifest = {
      schemaVersion: 2,
      runRef: { executionId: "run-01" },
      workflow: { kind: "fixture.workflow", version: 2 },
      target: {
        kind: "git-commit",
        identity: { repository: "timeback-api", commit: "abc123" },
      },
      createdAt: "2026-08-04T12:00:00.000Z",
      actor: { userId: "yuryp", roleId: "agent-execution-user" },
    };

    expect(validateRunManifestV2(manifest)).toEqual(manifest);
    expect(() => validateRunManifestV2({
      ...manifest,
      runId: "legacy-alias",
    })).toThrow("Run manifest contains unknown fields [runId].");
    expect(() => validateRunManifestV2({
      ...manifest,
      createdAt: "not-a-timestamp",
    })).toThrow("Run manifest.createdAt must be a canonical ISO-8601 timestamp.");
  });

  it("validates users and canonical immutable roles", () => {
    expect(validateUser({
      schemaVersion: 1,
      userId: "yuryp",
      status: "active",
      displayName: "Yury",
      identity: { providerId: "local-cli", subjectId: "yuryp" },
      registeredAt: "2026-08-05T12:00:00.000Z",
    })).toMatchObject({ userId: "yuryp", status: "active" });
    expect(validateRole({
      schemaVersion: 1,
      roleId: "runner",
      permissions: ["runs:read-own", "workflow:fixture.workflow:start", "runs:read-own"],
    }).permissions).toEqual(["runs:read-own", "workflow:fixture.workflow:start"]);
  });

  it("validates configuration references, trusted commands, and schema-v3 manifests", () => {
    const runConfiguration = {
      configurationId: "fixture-v3",
      contentHash: "a".repeat(64),
    };
    expect(validateRunConfigurationReference(runConfiguration)).toEqual(runConfiguration);
    const command = {
      runRef: { executionId: "run-01" },
      workflow: { kind: "fixture.workflow", version: 2 },
      actor: { userId: "yuryp", roleId: "runner" },
      input: { value: "accepted" },
      runConfiguration,
    };
    expect(validateTrustedRunCommand(command, (input) => input as { value: string })).toEqual(command);

    const manifest = {
      schemaVersion: 3,
      runRef: command.runRef,
      workflow: command.workflow,
      createdAt: "2026-08-05T12:00:00.000Z",
      actor: command.actor,
      runConfiguration,
    };
    expect(validateRunManifestV3(manifest)).toEqual(manifest);
    expect(() => validateRunManifestV3({ ...manifest, runConfiguration: { ...runConfiguration, contentHash: "bad" } }))
      .toThrow("contentHash must be a lowercase SHA-256 digest");
  });

  it("types the existing commit-scoped manifest as an explicit legacy contract", () => {
    const manifest: LegacyCommitRunManifestV1<{ hash: string; shortHash: string }> = {
      schemaVersion: 1,
      runId: "legacy-run",
      commit: { hash: "abc123", shortHash: "abc123" },
      createdAt: "2026-08-04T12:00:00.000Z",
    };

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.commit.hash).toBe("abc123");
  });
});
