import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FilePlatformConfigurationProvider,
  platformConfigurationContentHash,
  validateAgentExecutionPlatformConfigurationV1,
  validateAgentExecutionPlatformConfigurationV2,
  validateAgentExecutionPlatformConfigurationV4,
} from "../../core/src/index.ts";

const configuration = {
  schemaVersion: 1,
  configurationId: "local-platform-v1",
  stores: {
    users: { adapterId: "file-users@1", options: {} },
    roles: { adapterId: "file-roles@1", options: {} },
    roleAssignments: { adapterId: "file-role-assignments@1", options: {} },
    runConfigurations: { adapterId: "file-run-configurations@1", options: {} },
  },
} as const;

describe("platform configuration", () => {
  it("validates exact versioned platform store references", () => {
    expect(validateAgentExecutionPlatformConfigurationV1(configuration)).toEqual(configuration);
    expect(platformConfigurationContentHash(configuration)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateAgentExecutionPlatformConfigurationV1({
      ...configuration,
      stores: { ...configuration.stores, users: { adapterId: "file-users", options: {} } },
    })).toThrow("adapterId must be a lowercase versioned adapter ID");
  });

  it("validates the additive control-plane configuration without changing V1", () => {
    const v2 = {
      schemaVersion: 2,
      configurationId: "local-platform-v2",
      stores: {
        ...configuration.stores,
        organizations: { adapterId: "file-organizations@1", options: {} },
        environments: { adapterId: "file-environments@1", options: {} },
        workflowReleases: { adapterId: "file-workflow-releases@1", options: {} },
        workflowDeployments: { adapterId: "file-workflow-deployments@1", options: {} },
        deploymentHealth: { adapterId: "file-deployment-health@1", options: {} },
        meterRecords: { adapterId: "file-meter-records@1", options: {} },
        runProjections: { adapterId: "file-run-projections@1", options: {} },
      },
    } as const;
    expect(validateAgentExecutionPlatformConfigurationV2(v2)).toEqual(v2);
    expect(() => validateAgentExecutionPlatformConfigurationV1(v2)).toThrow("schemaVersion must be 1");
  });

  it("loads an immutable file-backed platform configuration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "platform-config-"));
    await writeFile(
      path.join(directory, "local-platform-v1.json"),
      `${JSON.stringify(configuration)}\n`,
      "utf8",
    );
    const provider = new FilePlatformConfigurationProvider({ configurationDirectory: directory });
    const resolved = await provider.resolve("local-platform-v1", {});
    expect(resolved.configuration).toEqual(configuration);
    expect(resolved.contentHash).toBe(platformConfigurationContentHash(configuration));
  });

  it("requires separate authentication definition and credential stores in V4", () => {
    const ref = (adapterId: string) => ({ adapterId, options: {} });
    const v4 = {
      schemaVersion: 4,
      configurationId: "local-platform-v4",
      stores: {
        users: ref("file-users@1"),
        roles: ref("file-roles@1"),
        roleAssignments: ref("file-role-assignments@1"),
        agentTemplates: ref("file-agent-templates@1"),
        workflowRunConfigurations: ref("file-workflow-run-configurations@1"),
        agentAuthProviders: ref("file-agent-auth-providers@1"),
        agentCredentials: ref("local-plaintext-agent-credentials@1"),
        organizations: ref("file-organizations@1"),
        environments: ref("file-environments@1"),
        workflowReleases: ref("file-workflow-releases@1"),
        workflowDeployments: ref("file-workflow-deployments@1"),
        deploymentHealth: ref("file-deployment-health@1"),
        meterRecords: ref("file-meter-records@1"),
        runProjections: ref("file-run-projections@1"),
      },
    } as const;
    expect(validateAgentExecutionPlatformConfigurationV4(v4)).toEqual(v4);
    const { agentCredentials: _omitted, ...missingCredentialStore } = v4.stores;
    expect(() => validateAgentExecutionPlatformConfigurationV4({
      ...v4,
      stores: missingCredentialStore,
    })).toThrow("missing required fields [agentCredentials]");
  });
});
