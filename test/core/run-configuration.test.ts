import { describe, expect, it } from "vitest";
import {
  redactResolvedRunConfiguration,
  runConfigurationContentHash,
  validateAgentExecutionRunConfigurationV1,
  validateAgentExecutionRunConfigurationV2,
  validateAgentExecutionRunConfigurationV3,
  type AgentExecutionRunConfigurationV1,
} from "../../core/src/index.ts";

type FixtureAgentId = "planner" | "executor";
type FixtureStoreRole = "state" | "artifacts";
type FixtureConfiguration = AgentExecutionRunConfigurationV1<FixtureAgentId, FixtureStoreRole>;

const schema = {
  agentIds: ["planner", "executor"],
  storeRoles: ["state", "artifacts"],
} as const;

function document(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    configurationId: "fixture-v1",
    agents: {
      planner: {
        timeoutMs: 1_000,
        execution: {
          provider: "codex-cli",
          authProvider: "codex-native-session",
          parameters: { model: "fixture", model_reasoning_effort: "high" },
        },
      },
      executor: {
        timeoutMs: 2_000,
        execution: {
          provider: "pi-cli",
          authProvider: "pi-openai-codex-session",
          parameters: { provider: "openai-codex", model: "fixture", thinking: "high" },
        },
      },
    },
    stores: {
      state: { adapterId: "file-state@1", options: {} },
      artifacts: { adapterId: "file-artifacts@1", options: {} },
    },
  };
}

function validate(value: unknown, expectedConfigurationId?: string): FixtureConfiguration {
  return validateAgentExecutionRunConfigurationV1(
    value,
    schema,
    expectedConfigurationId,
  );
}

describe("generic run configuration", () => {
  it("validates workflow-bound schema-v3 capability references", () => {
    const legacy = document();
    const configuration = validateAgentExecutionRunConfigurationV3({
      ...legacy,
      schemaVersion: 3,
      configurationId: "fixture-v3",
      workflow: { kind: "fixture.workflow", version: 2 },
      workflowStores: {
        results: { adapterId: "file-results@2", options: {} },
      },
      capabilities: {
        source: { adapterId: "git-source@1", options: {} },
      },
    }, {
      ...schema,
      workflow: { kind: "fixture.workflow", version: 2 },
      workflowStoreRoles: ["results"],
      capabilityRoles: ["source"],
    }, "fixture-v3");

    expect(configuration.capabilities.source.adapterId).toBe("git-source@1");
    expect(() => validateAgentExecutionRunConfigurationV3({
      ...configuration,
      capabilities: {},
    }, {
      ...schema,
      workflow: { kind: "fixture.workflow", version: 2 },
      workflowStoreRoles: ["results"],
      capabilityRoles: ["source"],
    })).toThrow("Run configuration.capabilities is missing required fields [source]");
  });

  it("validates workflow-bound schema-v2 execution and workflow stores", () => {
    const legacy = document();
    const configuration = validateAgentExecutionRunConfigurationV2({
      ...legacy,
      schemaVersion: 2,
      configurationId: "fixture-v2",
      workflow: { kind: "fixture.workflow", version: 2 },
      workflowStores: {
        results: { adapterId: "file-results@2", options: {} },
      },
    }, {
      ...schema,
      workflow: { kind: "fixture.workflow", version: 2 },
      workflowStoreRoles: ["results"],
    }, "fixture-v2");

    expect(configuration.workflow).toEqual({ kind: "fixture.workflow", version: 2 });
    expect(configuration.workflowStores.results.adapterId).toBe("file-results@2");
    expect(() => validateAgentExecutionRunConfigurationV2({
      ...configuration,
      workflow: { kind: "other.workflow", version: 2 },
    }, {
      ...schema,
      workflow: { kind: "fixture.workflow", version: 2 },
      workflowStoreRoles: ["results"],
    })).toThrow("workflow must be fixture.workflow@2");
  });

  it("uses workflow-owned agent IDs and store roles", () => {
    const configuration = validate(document());

    expect(Object.keys(configuration.agents)).toEqual(["planner", "executor"]);
    expect(Object.keys(configuration.stores)).toEqual(["state", "artifacts"]);
    expect(configuration.agents.executor.execution).toEqual({
      provider: "pi-cli",
      authProvider: "pi-openai-codex-session",
      parameters: { provider: "openai-codex", model: "fixture", thinking: "high" },
    });

    const missingAgent = document();
    delete (missingAgent.agents as Record<string, unknown>).executor;
    expect(() => validate(missingAgent)).toThrow(
      "Run configuration.agents is missing required fields [executor]",
    );
    const extraStore = document();
    (extraStore.stores as Record<string, unknown>).results = {
      adapterId: "file-results@1",
      options: {},
    };
    expect(() => validate(extraStore)).toThrow(
      "Run configuration.stores contains unknown fields [results]",
    );
  });

  it("validates provider-native parameters and prohibits persisted secrets", () => {
    const unsupportedPi = document();
    const executor = (unsupportedPi.agents as Record<string, Record<string, unknown>>).executor;
    const execution = executor.execution as Record<string, unknown>;
    (execution.parameters as Record<string, unknown>).model_reasoning_effort = "high";
    expect(() => validate(unsupportedPi)).toThrow(
      "contains unsupported Pi fields [model_reasoning_effort]",
    );

    const secret = document();
    const planner = (secret.agents as Record<string, Record<string, unknown>>).planner;
    const plannerExecution = planner.execution as Record<string, unknown>;
    (plannerExecution.parameters as Record<string, unknown>).api_key = "must-not-persist";
    expect(() => validate(secret)).toThrow(
      "is prohibited because resolved run configuration is persisted",
    );
  });

  it("hashes canonical content and redacts sensitive adapter options", () => {
    const left = document();
    const right = {
      stores: left.stores,
      agents: left.agents,
      configurationId: left.configurationId,
      schemaVersion: left.schemaVersion,
    };
    const configuration = validate(left);
    expect(runConfigurationContentHash(configuration)).toBe(
      runConfigurationContentHash(validate(right)),
    );

    configuration.stores.state.options = {
      tableName: "runs",
      authorizationToken: "must-not-persist",
    };
    const resolved = {
      configuration,
      contentHash: runConfigurationContentHash(configuration),
    };
    expect(redactResolvedRunConfiguration(resolved)).toEqual({
      contentHash: resolved.contentHash,
      configuration: {
        ...configuration,
        stores: {
          ...configuration.stores,
          state: {
            ...configuration.stores.state,
            options: {
              tableName: "runs",
              authorizationToken: "[REDACTED]",
            },
          },
        },
      },
    });
  });

  it("rejects duplicate workflow schema dimensions", () => {
    expect(() => validateAgentExecutionRunConfigurationV1(document(), {
      agentIds: ["planner", "planner"],
      storeRoles: ["state", "artifacts"],
    })).toThrow("Run configuration schema agent ID is duplicated: planner.");
  });
});
