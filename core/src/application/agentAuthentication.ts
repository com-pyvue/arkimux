import { createHash } from "node:crypto";
import type { ExecutionProviderId } from "../infrastructure/agents/agentProviderConfigProvider.ts";
import type { Page, PageQuery } from "./platformStore.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";
import { readExternalErrorDiagnostic, type ExternalErrorDiagnostic } from "./externalError.ts";

const identifierPattern = /^[a-z][a-z0-9-]*$/;
const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type AgentAuthenticationLifecycleStatus = "active" | "archived";
export type AgentAuthProviderLifecycleStatus = AgentAuthenticationLifecycleStatus;

/** A non-secret, reusable binding between a runtime and a separately stored credential. */
interface AgentAuthProviderDefinitionBase {
  schemaVersion: 2;
  authProviderId: string;
  displayName: string;
  executionProviderId: ExecutionProviderId;
  modelProvider?: string;
}

export interface StoredCredentialAgentAuthProviderDefinition extends AgentAuthProviderDefinitionBase {
  kind: "stored-credential";
  credentialId: string;
  targetVariable: string;
}

export interface NativeSessionAgentAuthProviderDefinition extends AgentAuthProviderDefinitionBase {
  kind: "runtime-native";
  modelProvider: string;
}

export type AgentAuthProviderDefinition = StoredCredentialAgentAuthProviderDefinition | NativeSessionAgentAuthProviderDefinition;

export interface ResolvedAgentAuthProviderDefinition {
  definition: AgentAuthProviderDefinition;
  contentHash: string;
  lifecycleStatus: AgentAuthenticationLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAuthProviderListQuery extends PageQuery {
  lifecycleStatus?: AgentAuthenticationLifecycleStatus | "all";
  executionProviderId?: ExecutionProviderId;
}

export type AgentAuthProbeStatus = "connected" | "action-required" | "failed" | "indeterminate";
export type AgentAuthProbeMechanism = "native-status" | "provider-check" | "minimal-inference";

/** Mutable, non-secret evidence from an explicitly requested authentication connection test. */
export interface AgentAuthProbeResult {
  schemaVersion: 1;
  authProviderId: string;
  checkedAt: string;
  status: AgentAuthProbeStatus;
  mechanism: AgentAuthProbeMechanism;
  latencyMs: number;
  probeModel?: string;
  message: string;
  externalDiagnostic?: ExternalErrorDiagnostic;
}

export interface AgentAuthConnectionTarget {
  authProviderId: string;
  executionProviderId: ExecutionProviderId;
  modelProvider?: string;
}

export interface AgentAuthConnectionProbe {
  probe(target: AgentAuthConnectionTarget): Promise<AgentAuthProbeResult>;
}

export interface AgentAuthProviderStore {
  create(definition: AgentAuthProviderDefinition): Promise<ResolvedAgentAuthProviderDefinition>;
  get(authProviderId: string): Promise<ResolvedAgentAuthProviderDefinition | undefined>;
  list(query?: AgentAuthProviderListQuery): Promise<Page<ResolvedAgentAuthProviderDefinition>>;
  setLifecycleStatus(authProviderId: string, status: AgentAuthenticationLifecycleStatus): Promise<void>;
  getLatestProbe(authProviderId: string): Promise<AgentAuthProbeResult | undefined>;
  recordProbe(result: AgentAuthProbeResult): Promise<void>;
}

/** Safe metadata for a secret. The secret value is never part of this definition. */
export interface AgentCredentialDefinition {
  schemaVersion: 1;
  credentialId: string;
  displayName: string;
  kind: "api-key";
  modelProvider: string;
}

export interface ResolvedAgentCredentialDefinition {
  definition: AgentCredentialDefinition;
  contentHash: string;
  lifecycleStatus: AgentAuthenticationLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  valueAvailable: boolean;
}

export interface AgentCredentialListQuery extends PageQuery {
  lifecycleStatus?: AgentAuthenticationLifecycleStatus | "all";
  modelProvider?: string;
}

/**
 * Secret-bearing port. Values returned by this port must never be serialized into
 * run, API, log, event, or performance artifacts.
 */
export interface AgentCredentialStore {
  create(definition: AgentCredentialDefinition, value: string): Promise<ResolvedAgentCredentialDefinition>;
  getDefinition(credentialId: string): Promise<ResolvedAgentCredentialDefinition | undefined>;
  list(query?: AgentCredentialListQuery): Promise<Page<ResolvedAgentCredentialDefinition>>;
  setLifecycleStatus(credentialId: string, status: AgentAuthenticationLifecycleStatus): Promise<void>;
  putValue(credentialId: string, value: string): Promise<void>;
  getValue(credentialId: string): Promise<string | undefined>;
  hasValue(credentialId: string): Promise<boolean>;
  deleteValue(credentialId: string): Promise<void>;
}

export function assertAgentAuthProviderId(value: unknown, location = "Authentication provider ID"): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new Error(`${location} must be a lowercase kebab-case identifier.`);
  }
  return value;
}

export function assertAgentCredentialId(value: unknown, location = "Credential ID"): string {
  return assertAgentAuthProviderId(value, location);
}

export function validateAgentAuthProviderDefinition(
  value: unknown,
  expectedId?: string,
): AgentAuthProviderDefinition {
  if (!isRecord(value)) throw new Error("Authentication provider definition must be an object.");
  assertExactKeys(value, [
    "schemaVersion", "authProviderId", "displayName", "kind", "executionProviderId",
    "modelProvider", ...(value.kind === "runtime-native" ? [] : ["credentialId", "targetVariable"]),
  ], "Authentication provider definition");
  if (value.schemaVersion !== 2) throw new Error("Authentication provider definition.schemaVersion must be 2.");
  const authProviderId = assertAgentAuthProviderId(value.authProviderId);
  if (expectedId !== undefined && authProviderId !== expectedId) {
    throw new Error(`Authentication provider ID mismatch: expected ${expectedId}, received ${authProviderId}.`);
  }
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) {
    throw new Error("Authentication provider definition.displayName must be a non-empty string.");
  }
  if (value.kind !== "stored-credential" && value.kind !== "runtime-native") throw new Error("Authentication provider definition.kind must be stored-credential or runtime-native.");
  if (!["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"].includes(String(value.executionProviderId))) {
    throw new Error("Authentication provider definition.executionProviderId must identify an installed execution provider.");
  }
  const modelProvider = validateModelProvider(value.modelProvider, "Authentication provider definition.modelProvider");
  if (value.kind === "runtime-native") {
    if (!modelProvider) throw new Error("Native-session Connection.modelProvider is required.");
    return {
      schemaVersion: 2, authProviderId, displayName: value.displayName.trim(),
      kind: "runtime-native", executionProviderId: value.executionProviderId as ExecutionProviderId,
      modelProvider,
    };
  }
  const credentialId = assertAgentCredentialId(value.credentialId);
  if (typeof value.targetVariable !== "string" || !environmentVariablePattern.test(value.targetVariable)) {
    throw new Error("Authentication provider definition.targetVariable must be an environment-variable name.");
  }
  return {
    schemaVersion: 2,
    authProviderId,
    displayName: value.displayName.trim(),
    kind: "stored-credential",
    executionProviderId: value.executionProviderId as ExecutionProviderId,
    ...(modelProvider === undefined ? {} : { modelProvider }),
    credentialId,
    targetVariable: value.targetVariable,
  };
}

export function validateAgentCredentialDefinition(value: unknown, expectedId?: string): AgentCredentialDefinition {
  if (!isRecord(value)) throw new Error("Credential definition must be an object.");
  assertExactKeys(value, ["schemaVersion", "credentialId", "displayName", "kind", "modelProvider"], "Credential definition");
  if (value.schemaVersion !== 1) throw new Error("Credential definition.schemaVersion must be 1.");
  const credentialId = assertAgentCredentialId(value.credentialId);
  if (expectedId !== undefined && credentialId !== expectedId) {
    throw new Error(`Credential ID mismatch: expected ${expectedId}, received ${credentialId}.`);
  }
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) {
    throw new Error("Credential definition.displayName must be a non-empty string.");
  }
  if (value.kind !== "api-key") throw new Error("Credential definition.kind must be api-key.");
  const modelProvider = validateModelProvider(value.modelProvider, "Credential definition.modelProvider");
  if (!modelProvider) throw new Error("Credential definition.modelProvider is required.");
  return { schemaVersion: 1, credentialId, displayName: value.displayName.trim(), kind: "api-key", modelProvider };
}

export function agentAuthProviderContentHash(definition: AgentAuthProviderDefinition): string {
  return createHash("sha256").update(JSON.stringify(validateAgentAuthProviderDefinition(definition))).digest("hex");
}

export function agentCredentialContentHash(definition: AgentCredentialDefinition): string {
  return createHash("sha256").update(JSON.stringify(validateAgentCredentialDefinition(definition))).digest("hex");
}

export function validateAgentAuthProbeResult(value: unknown, expectedId?: string): AgentAuthProbeResult {
  if (!isRecord(value)) throw new Error("Authentication probe result must be an object.");
  assertExactKeys(
    value,
    ["schemaVersion", "authProviderId", "checkedAt", "status", "mechanism", "latencyMs", "message"],
    "Authentication probe result",
    ["schemaVersion", "authProviderId", "checkedAt", "status", "mechanism", "latencyMs", "probeModel", "message", "externalDiagnostic"],
  );
  if (value.schemaVersion !== 1) throw new Error("Authentication probe result.schemaVersion must be 1.");
  const authProviderId = assertAgentAuthProviderId(value.authProviderId, "Authentication probe result.authProviderId");
  if (expectedId !== undefined && authProviderId !== expectedId) {
    throw new Error(`Authentication probe result ID mismatch: expected ${expectedId}, received ${authProviderId}.`);
  }
  if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) {
    throw new Error("Authentication probe result.checkedAt must be an ISO timestamp.");
  }
  if (!["connected", "action-required", "failed", "indeterminate"].includes(String(value.status))) {
    throw new Error("Authentication probe result.status is invalid.");
  }
  if (!["native-status", "provider-check", "minimal-inference"].includes(String(value.mechanism))) {
    throw new Error("Authentication probe result.mechanism is invalid.");
  }
  if (typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) {
    throw new Error("Authentication probe result.latencyMs must be a non-negative number.");
  }
  if (value.probeModel !== undefined && (typeof value.probeModel !== "string" || value.probeModel.length === 0)) {
    throw new Error("Authentication probe result.probeModel must be a non-empty string when supplied.");
  }
  if (typeof value.message !== "string" || value.message.trim().length === 0) {
    throw new Error("Authentication probe result.message must be non-empty.");
  }
  const externalDiagnostic = value.externalDiagnostic === undefined ? undefined : readExternalErrorDiagnostic(value.externalDiagnostic);
  if (value.externalDiagnostic !== undefined && externalDiagnostic === undefined) {
    throw new Error("Authentication probe result.externalDiagnostic must be a valid external provider diagnostic.");
  }
  return {
    schemaVersion: 1,
    authProviderId,
    checkedAt: value.checkedAt,
    status: value.status as AgentAuthProbeStatus,
    mechanism: value.mechanism as AgentAuthProbeMechanism,
    latencyMs: value.latencyMs,
    ...(value.probeModel === undefined ? {} : { probeModel: value.probeModel }),
    message: value.message,
    ...(externalDiagnostic === undefined ? {} : { externalDiagnostic }),
  };
}

function validateModelProvider(value: unknown, location: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new Error(`${location} must be a lowercase kebab-case identifier.`);
  }
  return value;
}
