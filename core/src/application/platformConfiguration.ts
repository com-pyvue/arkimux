import { createHash } from "node:crypto";
import type { StoreAdapterReference } from "./runConfiguration.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";

export interface AgentExecutionPlatformConfigurationV1 {
  schemaVersion: 1;
  configurationId: string;
  stores: {
    users: StoreAdapterReference;
    roles: StoreAdapterReference;
    roleAssignments: StoreAdapterReference;
    runConfigurations: StoreAdapterReference;
  };
}

export interface AgentExecutionPlatformConfigurationV2 {
  schemaVersion: 2;
  configurationId: string;
  stores: AgentExecutionPlatformConfigurationV1["stores"] & {
    organizations: StoreAdapterReference;
    environments: StoreAdapterReference;
    workflowReleases: StoreAdapterReference;
    workflowDeployments: StoreAdapterReference;
    deploymentHealth: StoreAdapterReference;
    meterRecords: StoreAdapterReference;
    runProjections: StoreAdapterReference;
  };
}

export interface AgentExecutionPlatformConfigurationV3 {
  schemaVersion: 3;
  configurationId: string;
  stores: {
    users: StoreAdapterReference;
    roles: StoreAdapterReference;
    roleAssignments: StoreAdapterReference;
    agentTemplates: StoreAdapterReference;
    workflowRunConfigurations: StoreAdapterReference;
    organizations: StoreAdapterReference;
    environments: StoreAdapterReference;
    workflowReleases: StoreAdapterReference;
    workflowDeployments: StoreAdapterReference;
    deploymentHealth: StoreAdapterReference;
    meterRecords: StoreAdapterReference;
    runProjections: StoreAdapterReference;
  };
}

export interface AgentExecutionPlatformConfigurationV4 {
  schemaVersion: 4;
  configurationId: string;
  stores: AgentExecutionPlatformConfigurationV3["stores"] & {
    agentAuthProviders: StoreAdapterReference;
    agentCredentials: StoreAdapterReference;
  };
}

export interface ResolvedPlatformConfiguration {
  configuration:
    | AgentExecutionPlatformConfigurationV1
    | AgentExecutionPlatformConfigurationV2
    | AgentExecutionPlatformConfigurationV3
    | AgentExecutionPlatformConfigurationV4;
  contentHash: string;
}

export interface PlatformConfigurationContext {
  repositoryRoot?: string;
}

export interface PlatformConfigurationProvider {
  resolve(
    configurationId: string,
    context: PlatformConfigurationContext,
  ): Promise<ResolvedPlatformConfiguration>;
}

const versionedIdPattern = /^[a-z][a-z0-9-]*-v[1-9][0-9]*$/;
const adapterIdPattern = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;

export function validateAgentExecutionPlatformConfigurationV1(
  value: unknown,
  expectedConfigurationId?: string,
): AgentExecutionPlatformConfigurationV1 {
  if (!isRecord(value)) throw new Error("Platform configuration must be an object.");
  assertExactKeys(value, ["schemaVersion", "configurationId", "stores"], "Platform configuration");
  if (value.schemaVersion !== 1) throw new Error("Platform configuration.schemaVersion must be 1.");
  if (typeof value.configurationId !== "string" || !versionedIdPattern.test(value.configurationId)) {
    throw new Error("Platform configuration.configurationId must be a lowercase versioned ID ending in -v<number>.");
  }
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(
      `Platform configuration ID mismatch: requested ${expectedConfigurationId}, document declares ${value.configurationId}.`,
    );
  }
  const stores = value.stores;
  if (!isRecord(stores)) throw new Error("Platform configuration.stores must be an object.");
  const roles = ["users", "roles", "roleAssignments", "runConfigurations"] as const;
  assertExactKeys(stores, [...roles], "Platform configuration.stores");
  return {
    schemaVersion: 1,
    configurationId: value.configurationId,
    stores: Object.fromEntries(roles.map((role) => [
      role,
      validateAdapterReference(stores[role], `Platform configuration.stores.${role}`),
    ])) as AgentExecutionPlatformConfigurationV1["stores"],
  };
}

export function validateAgentExecutionPlatformConfigurationV2(
  value: unknown,
  expectedConfigurationId?: string,
): AgentExecutionPlatformConfigurationV2 {
  if (!isRecord(value)) throw new Error("Platform configuration must be an object.");
  assertExactKeys(value, ["schemaVersion", "configurationId", "stores"], "Platform configuration");
  if (value.schemaVersion !== 2) throw new Error("Platform configuration.schemaVersion must be 2.");
  if (typeof value.configurationId !== "string" || !versionedIdPattern.test(value.configurationId)) {
    throw new Error("Platform configuration.configurationId must be a lowercase versioned ID ending in -v<number>.");
  }
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(
      `Platform configuration ID mismatch: requested ${expectedConfigurationId}, document declares ${value.configurationId}.`,
    );
  }
  if (!isRecord(value.stores)) throw new Error("Platform configuration.stores must be an object.");
  const stores = value.stores;
  const roles = [
    "users",
    "roles",
    "roleAssignments",
    "runConfigurations",
    "organizations",
    "environments",
    "workflowReleases",
    "workflowDeployments",
    "deploymentHealth",
    "meterRecords",
    "runProjections",
  ] as const;
  assertExactKeys(stores, [...roles], "Platform configuration.stores");
  return {
    schemaVersion: 2,
    configurationId: value.configurationId,
    stores: Object.fromEntries(roles.map((role) => [
      role,
      validateAdapterReference(stores[role], `Platform configuration.stores.${role}`),
    ])) as AgentExecutionPlatformConfigurationV2["stores"],
  };
}

export function validateAgentExecutionPlatformConfigurationV3(
  value: unknown,
  expectedConfigurationId?: string,
): AgentExecutionPlatformConfigurationV3 {
  if (!isRecord(value)) throw new Error("Platform configuration must be an object.");
  assertExactKeys(value, ["schemaVersion", "configurationId", "stores"], "Platform configuration");
  if (value.schemaVersion !== 3) throw new Error("Platform configuration.schemaVersion must be 3.");
  if (typeof value.configurationId !== "string" || !versionedIdPattern.test(value.configurationId)) {
    throw new Error("Platform configuration.configurationId must be a lowercase versioned ID ending in -v<number>.");
  }
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(
      `Platform configuration ID mismatch: requested ${expectedConfigurationId}, document declares ${value.configurationId}.`,
    );
  }
  if (!isRecord(value.stores)) throw new Error("Platform configuration.stores must be an object.");
  const stores = value.stores;
  const roles = [
    "users",
    "roles",
    "roleAssignments",
    "agentTemplates",
    "workflowRunConfigurations",
    "organizations",
    "environments",
    "workflowReleases",
    "workflowDeployments",
    "deploymentHealth",
    "meterRecords",
    "runProjections",
  ] as const;
  assertExactKeys(stores, [...roles], "Platform configuration.stores");
  return {
    schemaVersion: 3,
    configurationId: value.configurationId,
    stores: Object.fromEntries(roles.map((role) => [
      role,
      validateAdapterReference(stores[role], `Platform configuration.stores.${role}`),
    ])) as AgentExecutionPlatformConfigurationV3["stores"],
  };
}

export function validateAgentExecutionPlatformConfigurationV4(
  value: unknown,
  expectedConfigurationId?: string,
): AgentExecutionPlatformConfigurationV4 {
  if (!isRecord(value)) throw new Error("Platform configuration must be an object.");
  assertExactKeys(value, ["schemaVersion", "configurationId", "stores"], "Platform configuration");
  if (value.schemaVersion !== 4) throw new Error("Platform configuration.schemaVersion must be 4.");
  if (typeof value.configurationId !== "string" || !versionedIdPattern.test(value.configurationId)) {
    throw new Error("Platform configuration.configurationId must be a lowercase versioned ID ending in -v<number>.");
  }
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(
      `Platform configuration ID mismatch: requested ${expectedConfigurationId}, document declares ${value.configurationId}.`,
    );
  }
  if (!isRecord(value.stores)) throw new Error("Platform configuration.stores must be an object.");
  const stores = value.stores;
  const roles = [
    "users",
    "roles",
    "roleAssignments",
    "agentTemplates",
    "workflowRunConfigurations",
    "agentAuthProviders",
    "agentCredentials",
    "organizations",
    "environments",
    "workflowReleases",
    "workflowDeployments",
    "deploymentHealth",
    "meterRecords",
    "runProjections",
  ] as const;
  assertExactKeys(stores, [...roles], "Platform configuration.stores");
  return {
    schemaVersion: 4,
    configurationId: value.configurationId,
    stores: Object.fromEntries(roles.map((role) => [
      role,
      validateAdapterReference(stores[role], `Platform configuration.stores.${role}`),
    ])) as AgentExecutionPlatformConfigurationV4["stores"],
  };
}

export function platformConfigurationContentHash(configuration: unknown): string {
  return createHash("sha256").update(canonicalJson(configuration)).digest("hex");
}

function validateAdapterReference(value: unknown, location: string): StoreAdapterReference {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  assertExactKeys(value, ["adapterId", "options"], location);
  if (typeof value.adapterId !== "string" || !adapterIdPattern.test(value.adapterId)) {
    throw new Error(`${location}.adapterId must be a lowercase versioned adapter ID ending in @<number>.`);
  }
  if (!isRecord(value.options)) throw new Error(`${location}.options must be an object.`);
  return { adapterId: value.adapterId, options: structuredClone(value.options) };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
