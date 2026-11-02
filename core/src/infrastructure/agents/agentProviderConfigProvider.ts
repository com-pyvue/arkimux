import { promises as fs } from "node:fs";
import type { ResolvedAgentProviderConfigArtifact } from "../../application/agentProvider.ts";
import type { AgentAuthProviderDefinition } from "../../application/agentAuthentication.ts";

const executionProviderIds = ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"] as const;
const providerIdPattern = /^[a-z][a-z0-9-]*$/;
const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ExecutionProviderId = typeof executionProviderIds[number];

export interface AgentExecutionProviderRuntimeConfig {
  command: string;
  heartbeatIntervalMs: number;
  environmentAllowlist: string[];
  childHome?: string;
  parentHome?: string;
  agentDirectory?: string;
  offline?: boolean;
  telemetry?: boolean;
  versionCheck?: boolean;
  requiredVersion?: string;
}

export type AgentAuthProviderConfig =
  | {
      kind: "runtime-native";
      runtime: ExecutionProviderId;
      modelProvider?: string;
    }
  | {
      kind: "environment";
      sourceVariable: string;
      targetVariable: string;
    }
  | {
      kind: "command";
      command: string;
      args: string[];
      targetVariable: string;
    }
  | {
      kind: "stored-credential";
      credentialId: string;
      targetVariable: string;
      runtime: ExecutionProviderId;
      modelProvider?: string;
    };

export interface ResolvedAgentProviderConfig {
  schemaVersion: 1;
  executionProviders: Record<ExecutionProviderId, AgentExecutionProviderRuntimeConfig>;
  authProviders: Record<string, AgentAuthProviderConfig>;
  legacyEnvironmentOverrides: string[];
}

export type RedactedAgentProviderConfig = ResolvedAgentProviderConfigArtifact;

export interface AgentProviderConfigProvider {
  resolve(): Promise<ResolvedAgentProviderConfig>;
}

export function withStoredAgentAuthProviders(
  config: ResolvedAgentProviderConfig,
  definitions: readonly AgentAuthProviderDefinition[],
): ResolvedAgentProviderConfig {
  const dynamic: Record<string, AgentAuthProviderConfig> = Object.fromEntries(definitions.map((definition) => [definition.authProviderId, {
    ...(definition.kind === "stored-credential" ? { kind: "stored-credential" as const, credentialId: definition.credentialId, targetVariable: definition.targetVariable } : { kind: "runtime-native" as const }),
    runtime: definition.executionProviderId,
    ...(definition.modelProvider === undefined ? {} : { modelProvider: definition.modelProvider }),
  }]));
  const duplicate = Object.keys(dynamic).find((authProviderId) => config.authProviders[authProviderId] !== undefined);
  if (duplicate) throw new Error(`Stored authentication provider ${duplicate} conflicts with runtime configuration.`);
  return { ...config, authProviders: { ...config.authProviders, ...dynamic } };
}

export interface LayeredAgentProviderConfigProviderOptions {
  defaultConfigPath: string;
  environment?: NodeJS.ProcessEnv;
  fileConfigPath?: string;
}

type ExecutionProviderPatch = Partial<AgentExecutionProviderRuntimeConfig>;

interface AgentProviderConfigPatch {
  executionProviders: Partial<Record<ExecutionProviderId, ExecutionProviderPatch>>;
  authProviders: Record<string, AgentAuthProviderConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: string[], location: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${location} contains unknown fields [${unknown.join(", ")}].`);
  }
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${location} must be a non-empty string.`);
  }
  return value;
}

function booleanFromUnknown(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${location} must be a boolean.`);
  return value;
}

function positiveIntegerFromUnknown(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${location} must be a positive integer.`);
  }
  return value;
}

function parseEnvironmentVariables(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => (
    typeof item === "string" && environmentVariablePattern.test(item)
  ))) {
    throw new Error(`${location} must be an array of environment-variable names.`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${location} must not contain duplicate names.`);
  }
  return [...value];
}

function parseExecutionProviderId(value: string, location: string): ExecutionProviderId {
  if (!providerIdPattern.test(value)) {
    throw new Error(`${location} must be a lowercase provider ID.`);
  }
  if (!executionProviderIds.includes(value as ExecutionProviderId)) {
    throw new Error(`${location} references unsupported execution provider ${value}.`);
  }
  return value as ExecutionProviderId;
}

function parseExecutionProviderPatch(
  providerId: ExecutionProviderId,
  value: unknown,
  location: string,
): ExecutionProviderPatch {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  assertOnlyKeys(value, [
    "command",
    "heartbeatIntervalMs",
    "environmentAllowlist",
    "childHome",
    "parentHome",
    "agentDirectory",
    "offline",
    "telemetry",
    "versionCheck",
    "requiredVersion",
  ], location);
  if (providerId === "codex-cli") {
    const piOnly = ["agentDirectory", "offline", "telemetry", "versionCheck"]
      .filter((key) => value[key] !== undefined);
    if (piOnly.length > 0) throw new Error(`${location} contains Pi-only fields [${piOnly.join(", ")}].`);
  } else if (providerId === "pi-cli") {
    const codexOnly = ["childHome", "parentHome"].filter((key) => value[key] !== undefined);
    if (codexOnly.length > 0) throw new Error(`${location} contains Codex-only fields [${codexOnly.join(", ")}].`);
  }
  return {
    ...(value.command === undefined ? {} : { command: nonEmptyString(value.command, `${location}.command`) }),
    ...(value.heartbeatIntervalMs === undefined ? {} : {
      heartbeatIntervalMs: positiveIntegerFromUnknown(value.heartbeatIntervalMs, `${location}.heartbeatIntervalMs`),
    }),
    ...(value.environmentAllowlist === undefined ? {} : {
      environmentAllowlist: parseEnvironmentVariables(value.environmentAllowlist, `${location}.environmentAllowlist`),
    }),
    ...(value.childHome === undefined ? {} : { childHome: nonEmptyString(value.childHome, `${location}.childHome`) }),
    ...(value.parentHome === undefined ? {} : { parentHome: nonEmptyString(value.parentHome, `${location}.parentHome`) }),
    ...(value.agentDirectory === undefined ? {} : {
      agentDirectory: nonEmptyString(value.agentDirectory, `${location}.agentDirectory`),
    }),
    ...(value.offline === undefined ? {} : { offline: booleanFromUnknown(value.offline, `${location}.offline`) }),
    ...(value.telemetry === undefined ? {} : { telemetry: booleanFromUnknown(value.telemetry, `${location}.telemetry`) }),
    ...(value.versionCheck === undefined ? {} : {
      versionCheck: booleanFromUnknown(value.versionCheck, `${location}.versionCheck`),
    }),
    ...(value.requiredVersion === undefined ? {} : {
      requiredVersion: nonEmptyString(value.requiredVersion, `${location}.requiredVersion`),
    }),
  };
}

function parseVariableName(value: unknown, location: string): string {
  const variable = nonEmptyString(value, location);
  if (!environmentVariablePattern.test(variable)) {
    throw new Error(`${location} must be an environment-variable name.`);
  }
  return variable;
}

function parseAuthProvider(value: unknown, location: string): AgentAuthProviderConfig {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  if (value.kind === "runtime-native") {
    assertOnlyKeys(value, ["kind", "runtime", "modelProvider"], location);
    return {
      kind: "runtime-native",
      runtime: parseExecutionProviderId(nonEmptyString(value.runtime, `${location}.runtime`), `${location}.runtime`),
      ...(value.modelProvider === undefined ? {} : {
        modelProvider: nonEmptyString(value.modelProvider, `${location}.modelProvider`),
      }),
    };
  }
  if (value.kind === "environment") {
    assertOnlyKeys(value, ["kind", "sourceVariable", "targetVariable"], location);
    return {
      kind: "environment",
      sourceVariable: parseVariableName(value.sourceVariable, `${location}.sourceVariable`),
      targetVariable: parseVariableName(value.targetVariable, `${location}.targetVariable`),
    };
  }
  if (value.kind === "command") {
    assertOnlyKeys(value, ["kind", "command", "args", "targetVariable"], location);
    if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string"))) {
      throw new Error(`${location}.args must be an array of strings.`);
    }
    return {
      kind: "command",
      command: nonEmptyString(value.command, `${location}.command`),
      args: value.args === undefined ? [] : [...value.args],
      targetVariable: parseVariableName(value.targetVariable, `${location}.targetVariable`),
    };
  }
  if (value.kind === "stored-credential") {
    assertOnlyKeys(value, ["kind", "credentialId", "targetVariable", "runtime", "modelProvider"], location);
    const credentialId = nonEmptyString(value.credentialId, `${location}.credentialId`);
    if (!providerIdPattern.test(credentialId)) {
      throw new Error(`${location}.credentialId must be a lowercase provider ID.`);
    }
    return {
      kind: "stored-credential",
      credentialId,
      targetVariable: parseVariableName(value.targetVariable, `${location}.targetVariable`),
      runtime: parseExecutionProviderId(nonEmptyString(value.runtime, `${location}.runtime`), `${location}.runtime`),
      ...(value.modelProvider === undefined ? {} : {
        modelProvider: nonEmptyString(value.modelProvider, `${location}.modelProvider`),
      }),
    };
  }
  throw new Error(`${location}.kind must be runtime-native, environment, command, or stored-credential.`);
}

function parseConfigDocument(value: unknown, label: string): AgentProviderConfigPatch {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertOnlyKeys(value, ["schemaVersion", "executionProviders", "authProviders"], label);
  if (value.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1.`);
  if (value.executionProviders !== undefined && !isRecord(value.executionProviders)) {
    throw new Error(`${label}.executionProviders must be an object.`);
  }
  if (value.authProviders !== undefined && !isRecord(value.authProviders)) {
    throw new Error(`${label}.authProviders must be an object.`);
  }
  const executionProviders = Object.fromEntries(
    Object.entries(value.executionProviders ?? {}).map(([providerId, provider]) => {
      const parsedProviderId = parseExecutionProviderId(providerId, `${label}.executionProviders.${providerId}`);
      return [
        parsedProviderId,
        parseExecutionProviderPatch(parsedProviderId, provider, `${label}.executionProviders.${providerId}`),
      ];
    }),
  ) as Partial<Record<ExecutionProviderId, ExecutionProviderPatch>>;
  const authProviders = Object.fromEntries(
    Object.entries(value.authProviders ?? {}).map(([authProviderId, provider]) => {
      if (!providerIdPattern.test(authProviderId)) {
        throw new Error(`${label}.authProviders.${authProviderId} must use a lowercase provider ID.`);
      }
      return [authProviderId, parseAuthProvider(provider, `${label}.authProviders.${authProviderId}`)];
    }),
  );
  return { executionProviders, authProviders };
}

async function readConfigDocument(filePath: string, label: string): Promise<AgentProviderConfigPatch> {
  try {
    return parseConfigDocument(JSON.parse(await fs.readFile(filePath, "utf8")), label);
  } catch (error) {
    if ((error as Error).message.startsWith(label)) throw error;
    throw new Error(`${label} could not be read as JSON from ${filePath}: ${(error as Error).message}`);
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

function environmentPatch(environment: NodeJS.ProcessEnv): {
  patch: AgentProviderConfigPatch;
  overriddenNames: string[];
} {
  const overriddenNames: string[] = [];
  const used = <T>(name: string, value: T | undefined): T | undefined => {
    if (value !== undefined) overriddenNames.push(name);
    return value;
  };
  const heartbeatIntervalMs = used(
    "SYSTEM_MODEL_BUILDER_AGENT_HEARTBEAT_INTERVAL_MS",
    positiveInteger(environment.SYSTEM_MODEL_BUILDER_AGENT_HEARTBEAT_INTERVAL_MS),
  );
  const codexCommandName = environment.AGENT_EXECUTION_CODEX_COMMAND !== undefined
    ? "AGENT_EXECUTION_CODEX_COMMAND"
    : environment.CODEX_COMMAND !== undefined
      ? "CODEX_COMMAND"
      : "SYSTEM_MODEL_BUILDER_CODEX_COMMAND";
  const codexCommand = used(
    codexCommandName,
    environment.AGENT_EXECUTION_CODEX_COMMAND
      ?? environment.CODEX_COMMAND
      ?? environment.SYSTEM_MODEL_BUILDER_CODEX_COMMAND,
  );
  const childHome = used("SYSTEM_MODEL_BUILDER_CODEX_HOME", environment.SYSTEM_MODEL_BUILDER_CODEX_HOME);
  const parentHomeName = environment.SYSTEM_MODEL_BUILDER_PARENT_CODEX_HOME !== undefined
    ? "SYSTEM_MODEL_BUILDER_PARENT_CODEX_HOME"
    : "CODEX_HOME";
  const parentHome = used(
    parentHomeName,
    environment.SYSTEM_MODEL_BUILDER_PARENT_CODEX_HOME ?? environment.CODEX_HOME,
  );
  const piCommandName = environment.AGENT_EXECUTION_PI_COMMAND !== undefined
    ? "AGENT_EXECUTION_PI_COMMAND"
    : environment.PI_COMMAND !== undefined
      ? "PI_COMMAND"
      : "SYSTEM_MODEL_BUILDER_PI_COMMAND";
  const piCommand = used(
    piCommandName,
    environment.AGENT_EXECUTION_PI_COMMAND
      ?? environment.PI_COMMAND
      ?? environment.SYSTEM_MODEL_BUILDER_PI_COMMAND,
  );
  const agentDirectoryName = environment.SYSTEM_MODEL_BUILDER_PI_AGENT_DIRECTORY !== undefined
    ? "SYSTEM_MODEL_BUILDER_PI_AGENT_DIRECTORY"
    : "PI_CODING_AGENT_DIR";
  const agentDirectory = used(
    agentDirectoryName,
    environment.SYSTEM_MODEL_BUILDER_PI_AGENT_DIRECTORY ?? environment.PI_CODING_AGENT_DIR,
  );
  const offline = used("PI_OFFLINE", booleanValue(environment.PI_OFFLINE));
  const telemetry = used("PI_TELEMETRY", booleanValue(environment.PI_TELEMETRY));
  const claudeCommand = used(
    "AGENT_EXECUTION_CLAUDE_COMMAND",
    environment.AGENT_EXECUTION_CLAUDE_COMMAND ?? environment.CLAUDE_COMMAND,
  );
  const kimiCommand = used(
    "AGENT_EXECUTION_KIMI_COMMAND",
    environment.AGENT_EXECUTION_KIMI_COMMAND ?? environment.KIMI_COMMAND,
  );
  const executionProviders: AgentProviderConfigPatch["executionProviders"] = {};
  const codexPatch: ExecutionProviderPatch = {
    ...(codexCommand ? { command: codexCommand } : {}),
    ...(heartbeatIntervalMs ? { heartbeatIntervalMs } : {}),
    ...(childHome ? { childHome } : {}),
    ...(parentHome ? { parentHome } : {}),
  };
  const piPatch: ExecutionProviderPatch = {
    ...(piCommand ? { command: piCommand } : {}),
    ...(heartbeatIntervalMs ? { heartbeatIntervalMs } : {}),
    ...(agentDirectory ? { agentDirectory } : {}),
    ...(offline === undefined ? {} : { offline }),
    ...(telemetry === undefined ? {} : { telemetry }),
  };
  if (Object.keys(codexPatch).length > 0) executionProviders["codex-cli"] = codexPatch;
  if (Object.keys(piPatch).length > 0) executionProviders["pi-cli"] = piPatch;
  if (claudeCommand || heartbeatIntervalMs) {
    executionProviders["claude-code-cli"] = {
      ...(claudeCommand ? { command: claudeCommand } : {}),
      ...(heartbeatIntervalMs ? { heartbeatIntervalMs } : {}),
    };
  }
  if (kimiCommand || heartbeatIntervalMs) {
    executionProviders["kimi-code-cli"] = {
      ...(kimiCommand ? { command: kimiCommand } : {}),
      ...(heartbeatIntervalMs ? { heartbeatIntervalMs } : {}),
    };
  }
  return {
    patch: { executionProviders, authProviders: {} },
    overriddenNames: [...new Set(overriddenNames)].sort(),
  };
}

function mergePatches(base: AgentProviderConfigPatch, override: AgentProviderConfigPatch): AgentProviderConfigPatch {
  const executionProviders = { ...base.executionProviders };
  for (const providerId of executionProviderIds) {
    const patch = override.executionProviders[providerId];
    if (patch) executionProviders[providerId] = { ...executionProviders[providerId], ...patch };
  }
  return {
    executionProviders,
    authProviders: { ...base.authProviders, ...override.authProviders },
  };
}

function resolveConfig(
  layers: AgentProviderConfigPatch[],
  legacyEnvironmentOverrides: string[],
): ResolvedAgentProviderConfig {
  const merged = layers.reduce(mergePatches, { executionProviders: {}, authProviders: {} });
  const executionProviders = Object.fromEntries(executionProviderIds.map((providerId) => {
    const value = merged.executionProviders[providerId];
    if (!value?.command) throw new Error(`Resolved agent provider configuration is missing ${providerId}.command.`);
    if (!value.heartbeatIntervalMs) {
      throw new Error(`Resolved agent provider configuration is missing ${providerId}.heartbeatIntervalMs.`);
    }
    if (!value.environmentAllowlist) {
      throw new Error(`Resolved agent provider configuration is missing ${providerId}.environmentAllowlist.`);
    }
    return [providerId, value as AgentExecutionProviderRuntimeConfig];
  })) as Record<ExecutionProviderId, AgentExecutionProviderRuntimeConfig>;
  if (Object.keys(merged.authProviders).length === 0) {
    throw new Error("Resolved agent provider configuration must define at least one authentication provider.");
  }
  for (const [authProviderId, authProvider] of Object.entries(merged.authProviders)) {
    if (authProvider.kind === "runtime-native" && !executionProviders[authProvider.runtime]) {
      throw new Error(`Authentication provider ${authProviderId} references missing runtime ${authProvider.runtime}.`);
    }
  }
  return {
    schemaVersion: 1,
    executionProviders,
    authProviders: merged.authProviders,
    legacyEnvironmentOverrides,
  };
}

class LayeredAgentProviderConfigProvider implements AgentProviderConfigProvider {
  constructor(private readonly resolved: ResolvedAgentProviderConfig) {}

  async resolve(): Promise<ResolvedAgentProviderConfig> {
    return structuredClone(this.resolved);
  }
}

export async function createAgentProviderConfigProvider(
  options: LayeredAgentProviderConfigProviderOptions,
): Promise<AgentProviderConfigProvider> {
  const environment = environmentPatch(options.environment ?? process.env);
  const layers = [
    await readConfigDocument(options.defaultConfigPath, "Built-in agent provider configuration"),
    environment.patch,
  ];
  if (options.fileConfigPath) {
    layers.push(await readConfigDocument(options.fileConfigPath, "File agent provider configuration"));
  }
  return new LayeredAgentProviderConfigProvider(resolveConfig(layers, environment.overriddenNames));
}

/** Resolve an already-loaded built-in configuration with the same environment overrides as the file provider. */
export function resolveAgentProviderConfigDocument(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProviderConfig {
  const overrides = environmentPatch(environment);
  return resolveConfig([
    parseConfigDocument(value, "Built-in agent provider configuration"),
    overrides.patch,
  ], overrides.overriddenNames);
}

export function redactAgentProviderConfig(config: ResolvedAgentProviderConfig): RedactedAgentProviderConfig {
  return {
    schemaVersion: 1,
    executionProviders: structuredClone(config.executionProviders),
    authProviders: Object.fromEntries(Object.entries(config.authProviders).map(([providerId, provider]) => {
      if (provider.kind === "runtime-native") {
        return [providerId, {
          kind: provider.kind,
          runtime: provider.runtime,
          ...(provider.modelProvider ? { modelProvider: provider.modelProvider } : {}),
          preflightStatus: "not-checked" as const,
        }];
      }
      if (provider.kind === "environment") {
        return [providerId, {
          kind: provider.kind,
          sourceVariable: provider.sourceVariable,
          targetVariable: provider.targetVariable,
          preflightStatus: "not-checked" as const,
        }];
      }
      return [providerId, {
        kind: provider.kind,
        targetVariable: provider.targetVariable,
        commandConfigured: true as const,
        preflightStatus: "not-checked" as const,
      }];
    })),
    legacyEnvironmentOverrides: [...config.legacyEnvironmentOverrides],
  };
}
