import { createHash } from "node:crypto";
import type {
  AgentExecutionConfig,
  AgentRunPolicy,
  ProviderParameterValue,
} from "./agentProvider.ts";
import {
  validateWorkflowIdentity,
  type WorkflowIdentity,
} from "../domain/workflowIdentity.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";
import { assertRunConfigurationId } from "../domain/runConfigurationReference.ts";
import type { AgentTemplateProvenance } from "./agentTemplate.ts";

export interface StoreAdapterReference {
  adapterId: string;
  options: Record<string, unknown>;
}

export interface AgentExecutionRunConfigurationV1<
  TAgentId extends string = string,
  TStoreRole extends string = string,
> {
  schemaVersion: 1;
  configurationId: string;
  agents: Record<TAgentId, AgentRunPolicy>;
  stores: Record<TStoreRole, StoreAdapterReference>;
}

export interface AgentExecutionRunConfigurationV2<
  TAgentId extends string = string,
  TStoreRole extends string = string,
  TWorkflowStoreRole extends string = string,
> {
  schemaVersion: 2;
  configurationId: string;
  workflow: WorkflowIdentity;
  agents: Record<TAgentId, AgentRunPolicy>;
  stores: Record<TStoreRole, StoreAdapterReference>;
  workflowStores: Record<TWorkflowStoreRole, StoreAdapterReference>;
}

export interface AgentExecutionRunConfigurationV3<
  TAgentId extends string = string,
  TStoreRole extends string = string,
  TWorkflowStoreRole extends string = string,
  TCapabilityRole extends string = string,
> {
  schemaVersion: 3;
  configurationId: string;
  workflow: WorkflowIdentity;
  agents: Record<TAgentId, AgentRunPolicy>;
  agentTemplateProvenance?: Partial<Record<TAgentId, AgentTemplateProvenance>>;
  stores: Record<TStoreRole, StoreAdapterReference>;
  workflowStores: Record<TWorkflowStoreRole, StoreAdapterReference>;
  capabilities: Record<TCapabilityRole, StoreAdapterReference>;
}

export interface ResolvedRunConfiguration<TConfiguration> {
  configuration: TConfiguration;
  contentHash: string;
  createdAt?: string;
}

export interface RunConfigurationV1Schema<
  TAgentId extends string,
  TStoreRole extends string,
> {
  agentIds: readonly TAgentId[];
  storeRoles: readonly TStoreRole[];
}

export interface RunConfigurationV2Schema<
  TAgentId extends string,
  TStoreRole extends string,
  TWorkflowStoreRole extends string,
> extends RunConfigurationV1Schema<TAgentId, TStoreRole> {
  workflow: WorkflowIdentity;
  workflowStoreRoles: readonly TWorkflowStoreRole[];
}

export interface RunConfigurationV3Schema<
  TAgentId extends string,
  TStoreRole extends string,
  TWorkflowStoreRole extends string,
  TCapabilityRole extends string,
> extends RunConfigurationV2Schema<TAgentId, TStoreRole, TWorkflowStoreRole> {
  capabilityRoles: readonly TCapabilityRole[];
}

const adapterIdPattern = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;
const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const claudeEffortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
const claudePermissionModes = ["default", "acceptEdits", "plan", "auto", "manual", "dontAsk", "bypassPermissions"] as const;
const kimiProviderTypes = ["kimi", "anthropic", "openai"] as const;
const kimiThinkingEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
const prohibitedParameterKey = /(^|[._-])(api[_-]?key|token|secret|password|authorization)([._-]|$)/i;
const redactedOptionKey = /(api[_-]?key|token|secret|password|authorization|credential)/i;

export { assertRunConfigurationId };

export function validateAgentExecutionRunConfigurationV1<
  TAgentId extends string,
  TStoreRole extends string,
>(
  value: unknown,
  schema: RunConfigurationV1Schema<TAgentId, TStoreRole>,
  expectedConfigurationId?: string,
): AgentExecutionRunConfigurationV1<TAgentId, TStoreRole> {
  if (!isRecord(value)) throw new Error("Run configuration must be an object.");
  assertExactKeys(value, ["schemaVersion", "configurationId", "agents", "stores"], "Run configuration");
  if (value.schemaVersion !== 1) throw new Error("Run configuration.schemaVersion must be 1.");
  if (typeof value.configurationId !== "string") {
    throw new Error("Run configuration.configurationId must be a lowercase versioned ID ending in -v<number>.");
  }
  assertRunConfigurationId(value.configurationId);
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(`Run configuration ID mismatch: requested ${expectedConfigurationId}, document declares ${value.configurationId}.`);
  }
  assertUniqueSchemaValues(schema.agentIds, "Run configuration schema agent ID");
  assertUniqueSchemaValues(schema.storeRoles, "Run configuration schema store role");
  return {
    schemaVersion: 1,
    configurationId: value.configurationId,
    agents: parseAgents(value.agents, schema.agentIds),
    stores: parseStores(value.stores, schema.storeRoles),
  };
}

export function validateAgentExecutionRunConfigurationV2<
  TAgentId extends string,
  TStoreRole extends string,
  TWorkflowStoreRole extends string,
>(
  value: unknown,
  schema: RunConfigurationV2Schema<TAgentId, TStoreRole, TWorkflowStoreRole>,
  expectedConfigurationId?: string,
): AgentExecutionRunConfigurationV2<TAgentId, TStoreRole, TWorkflowStoreRole> {
  if (!isRecord(value)) throw new Error("Run configuration must be an object.");
  assertExactKeys(
    value,
    ["schemaVersion", "configurationId", "workflow", "agents", "stores", "workflowStores"],
    "Run configuration",
  );
  if (value.schemaVersion !== 2) throw new Error("Run configuration.schemaVersion must be 2.");
  if (typeof value.configurationId !== "string") {
    throw new Error("Run configuration.configurationId must be a lowercase versioned ID ending in -v<number>.");
  }
  assertRunConfigurationId(value.configurationId);
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(`Run configuration ID mismatch: requested ${expectedConfigurationId}, document declares ${value.configurationId}.`);
  }
  const workflow = validateWorkflowIdentity(value.workflow);
  if (workflow.kind !== schema.workflow.kind || workflow.version !== schema.workflow.version) {
    throw new Error(
      `Run configuration workflow must be ${schema.workflow.kind}@${schema.workflow.version}.`,
    );
  }
  assertUniqueSchemaValues(schema.agentIds, "Run configuration schema agent ID");
  assertUniqueSchemaValues(schema.storeRoles, "Run configuration schema store role");
  assertUniqueSchemaValues(schema.workflowStoreRoles, "Run configuration schema workflow store role");
  return {
    schemaVersion: 2,
    configurationId: value.configurationId,
    workflow,
    agents: parseAgents(value.agents, schema.agentIds),
    stores: parseStores(value.stores, schema.storeRoles),
    workflowStores: parseStores(value.workflowStores, schema.workflowStoreRoles),
  };
}

export function validateAgentExecutionRunConfigurationV3<
  TAgentId extends string,
  TStoreRole extends string,
  TWorkflowStoreRole extends string,
  TCapabilityRole extends string,
>(
  value: unknown,
  schema: RunConfigurationV3Schema<TAgentId, TStoreRole, TWorkflowStoreRole, TCapabilityRole>,
  expectedConfigurationId?: string,
): AgentExecutionRunConfigurationV3<TAgentId, TStoreRole, TWorkflowStoreRole, TCapabilityRole> {
  if (!isRecord(value)) throw new Error("Run configuration must be an object.");
  assertExactKeys(
    value,
    ["schemaVersion", "configurationId", "workflow", "agents", "stores", "workflowStores", "capabilities"],
    "Run configuration",
    ["schemaVersion", "configurationId", "workflow", "agents", "agentTemplateProvenance", "stores", "workflowStores", "capabilities"],
  );
  if (value.schemaVersion !== 3) throw new Error("Run configuration.schemaVersion must be 3.");
  if (typeof value.configurationId !== "string") {
    throw new Error("Run configuration.configurationId must be a lowercase versioned ID ending in -v<number>.");
  }
  assertRunConfigurationId(value.configurationId);
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(`Run configuration ID mismatch: requested ${expectedConfigurationId}, document declares ${value.configurationId}.`);
  }
  const workflow = validateWorkflowIdentity(value.workflow);
  if (workflow.kind !== schema.workflow.kind || workflow.version !== schema.workflow.version) {
    throw new Error(
      `Run configuration workflow must be ${schema.workflow.kind}@${schema.workflow.version}.`,
    );
  }
  assertUniqueSchemaValues(schema.agentIds, "Run configuration schema agent ID");
  assertUniqueSchemaValues(schema.storeRoles, "Run configuration schema store role");
  assertUniqueSchemaValues(schema.workflowStoreRoles, "Run configuration schema workflow store role");
  assertUniqueSchemaValues(schema.capabilityRoles, "Run configuration schema capability role");
  return {
    schemaVersion: 3,
    configurationId: value.configurationId,
    workflow,
    agents: parseAgents(value.agents, schema.agentIds),
    ...(value.agentTemplateProvenance === undefined ? {} : {
      agentTemplateProvenance: parseAgentTemplateProvenance(value.agentTemplateProvenance, schema.agentIds),
    }),
    stores: parseStores(value.stores, schema.storeRoles, "stores"),
    workflowStores: parseStores(value.workflowStores, schema.workflowStoreRoles, "workflowStores"),
    capabilities: parseStores(value.capabilities, schema.capabilityRoles, "capabilities"),
  };
}

function parseAgentTemplateProvenance<TAgentId extends string>(
  value: unknown,
  agentIds: readonly TAgentId[],
): Partial<Record<TAgentId, AgentTemplateProvenance>> {
  if (!isRecord(value)) throw new Error("Run configuration.agentTemplateProvenance must be an object.");
  const unknown = Object.keys(value).filter((slotId) => !agentIds.includes(slotId as TAgentId));
  if (unknown.length > 0) throw new Error(`Run configuration.agentTemplateProvenance contains unknown agent IDs [${unknown.join(", ")}].`);
  return Object.fromEntries(Object.entries(value).map(([slotId, candidate]) => {
    if (!isRecord(candidate)) throw new Error(`Run configuration.agentTemplateProvenance.${slotId} must be an object.`);
    assertExactKeys(candidate, ["templateId", "templateContentHash"], `Run configuration.agentTemplateProvenance.${slotId}`);
    if (typeof candidate.templateId !== "string") throw new Error(`Run configuration.agentTemplateProvenance.${slotId}.templateId must be a string.`);
    assertRunConfigurationId(candidate.templateId);
    if (typeof candidate.templateContentHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.templateContentHash)) {
      throw new Error(`Run configuration.agentTemplateProvenance.${slotId}.templateContentHash must be a SHA-256 hash.`);
    }
    return [slotId, { templateId: candidate.templateId, templateContentHash: candidate.templateContentHash }];
  })) as Partial<Record<TAgentId, AgentTemplateProvenance>>;
}

export function runConfigurationContentHash(configuration: unknown): string {
  return createHash("sha256").update(canonicalJson(configuration)).digest("hex");
}

export function redactResolvedRunConfiguration<TConfiguration>(
  resolved: ResolvedRunConfiguration<TConfiguration>,
): ResolvedRunConfiguration<TConfiguration> {
  return {
    contentHash: resolved.contentHash,
    ...(resolved.createdAt === undefined ? {} : { createdAt: resolved.createdAt }),
    configuration: redactValue(resolved.configuration) as TConfiguration,
  };
}

function parseAgents<TAgentId extends string>(
  value: unknown,
  agentIds: readonly TAgentId[],
): Record<TAgentId, AgentRunPolicy> {
  if (!isRecord(value)) throw new Error("Run configuration.agents must be an object.");
  assertExactKeys(value, [...agentIds], "Run configuration.agents");
  return Object.fromEntries(agentIds.map((agentId) => [
    agentId,
    parsePolicy(value[agentId], `Run configuration.agents.${agentId}`),
  ])) as Record<TAgentId, AgentRunPolicy>;
}

function parseStores<TStoreRole extends string>(
  value: unknown,
  storeRoles: readonly TStoreRole[],
  section = "stores",
): Record<TStoreRole, StoreAdapterReference> {
  if (!isRecord(value)) throw new Error(`Run configuration.${section} must be an object.`);
  assertExactKeys(value, [...storeRoles], `Run configuration.${section}`);
  return Object.fromEntries(storeRoles.map((role) => {
    const location = `Run configuration.${section}.${role}`;
    const reference = value[role];
    if (!isRecord(reference)) throw new Error(`${location} must be an object.`);
    assertExactKeys(reference, ["adapterId", "options"], location);
    if (typeof reference.adapterId !== "string" || !adapterIdPattern.test(reference.adapterId)) {
      throw new Error(`${location}.adapterId must contain an exact positive numeric adapter version.`);
    }
    return [role, {
      adapterId: reference.adapterId,
      options: parseJsonObject(reference.options, `${location}.options`),
    }];
  })) as Record<TStoreRole, StoreAdapterReference>;
}

export function validateAgentRunPolicy(value: unknown, location = "Agent policy"): AgentRunPolicy {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  assertExactKeys(value, ["timeoutMs", "execution"], location);
  if (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0) {
    throw new Error(`${location}.timeoutMs must be a positive integer.`);
  }
  return { timeoutMs: value.timeoutMs, execution: parseExecution(value.execution, `${location}.execution`) };
}

const parsePolicy = validateAgentRunPolicy;

function parseExecution(value: unknown, location: string): AgentExecutionConfig {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  assertExactKeys(value, ["provider", "authProvider", "parameters"], location);
  if (typeof value.authProvider !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.authProvider)) {
    throw new Error(`${location}.authProvider must be a lowercase provider ID.`);
  }
  const parameters = parseParameters(value.parameters, `${location}.parameters`);
  if (value.provider === "codex-cli") {
    return { provider: "codex-cli", authProvider: value.authProvider, parameters };
  }
  if (value.provider === "pi-cli") {
    assertParameterKeys(parameters, ["provider", "model", "thinking"], location, "Pi");
    const provider = requiredStringParameter(parameters, "provider", location);
    const model = requiredStringParameter(parameters, "model", location);
    const thinking = optionalEnumParameter(parameters, "thinking", piThinkingLevels, location);
    return { provider: "pi-cli", authProvider: value.authProvider, parameters: { provider, model, ...(thinking ? { thinking } : {}) } };
  }
  if (value.provider === "claude-code-cli") {
    assertParameterKeys(parameters, ["model", "effort", "permission-mode", "max-budget-usd"], location, "Claude Code");
    const model = requiredStringParameter(parameters, "model", location);
    const effort = optionalEnumParameter(parameters, "effort", claudeEffortLevels, location);
    const permissionMode = optionalEnumParameter(parameters, "permission-mode", claudePermissionModes, location);
    const maxBudgetUsd = optionalPositiveNumberParameter(parameters, "max-budget-usd", location, false);
    return { provider: "claude-code-cli", authProvider: value.authProvider, parameters: { model, ...(effort ? { effort } : {}), ...(permissionMode ? { "permission-mode": permissionMode } : {}), ...(maxBudgetUsd ? { "max-budget-usd": maxBudgetUsd } : {}) } };
  }
  if (value.provider === "kimi-code-cli") {
    assertParameterKeys(parameters, ["model", "provider-type", "base-url", "max-context-size", "capabilities", "thinking-effort"], location, "Kimi Code");
    const model = requiredStringParameter(parameters, "model", location);
    const providerType = optionalEnumParameter(parameters, "provider-type", kimiProviderTypes, location);
    const baseUrl = optionalStringParameter(parameters, "base-url", location);
    const maxContextSize = optionalPositiveNumberParameter(parameters, "max-context-size", location, true);
    const capabilities = parameters.capabilities;
    if (capabilities !== undefined && (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === "string"))) {
      throw new Error(`${location}.parameters.capabilities must be an array of strings.`);
    }
    const thinkingEffort = optionalEnumParameter(parameters, "thinking-effort", kimiThinkingEfforts, location);
    return { provider: "kimi-code-cli", authProvider: value.authProvider, parameters: { model, ...(providerType ? { "provider-type": providerType } : {}), ...(baseUrl ? { "base-url": baseUrl } : {}), ...(maxContextSize ? { "max-context-size": maxContextSize } : {}), ...(capabilities ? { capabilities: capabilities as string[] } : {}), ...(thinkingEffort ? { "thinking-effort": thinkingEffort } : {}) } };
  }
  throw new Error(`${location}.provider must identify an installed execution provider.`);
}

function assertParameterKeys(parameters: Record<string, ProviderParameterValue>, allowed: string[], location: string, label: string): void {
  const unknown = Object.keys(parameters).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${location}.parameters contains unsupported ${label} fields [${unknown.join(", ")}].`);
}

function requiredStringParameter(parameters: Record<string, ProviderParameterValue>, key: string, location: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location}.parameters.${key} must be a non-empty string.`);
  return value;
}

function optionalStringParameter(parameters: Record<string, ProviderParameterValue>, key: string, location: string): string | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location}.parameters.${key} must be a non-empty string.`);
  return value;
}

function optionalEnumParameter<const T extends readonly string[]>(parameters: Record<string, ProviderParameterValue>, key: string, allowed: T, location: string): T[number] | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${location}.parameters.${key} is unsupported.`);
  return value as T[number];
}

function optionalPositiveNumberParameter(parameters: Record<string, ProviderParameterValue>, key: string, location: string, integer: boolean): number | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${location}.parameters.${key} must be a positive${integer ? " integer" : " number"}.`);
  }
  return value;
}

function parseParameters(value: unknown, location: string): Record<string, ProviderParameterValue> {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  return Object.fromEntries(Object.entries(value).map(([key, parameterValue]) => {
    if (key.length === 0) throw new Error(`${location} contains an empty key.`);
    if (prohibitedParameterKey.test(key)) {
      throw new Error(`${location}.${key} is prohibited because resolved run configuration is persisted.`);
    }
    return [key, parseParameterValue(parameterValue, `${location}.${key}`)];
  }));
}

function parseParameterValue(value: unknown, location: string): ProviderParameterValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item) => (
    typeof item === "string"
    || typeof item === "boolean"
    || (typeof item === "number" && Number.isFinite(item))
  ))) {
    return value as ProviderParameterValue;
  }
  throw new Error(`${location} must be a provider-native scalar or scalar array.`);
}

function parseJsonObject(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${location} must contain JSON values.`);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function assertUniqueSchemaValues(values: readonly string[], label: string): void {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) throw new Error(`${label} is duplicated: ${duplicate}.`);
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

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && redactedOptionKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, entryKey),
    ]));
  }
  return value;
}
