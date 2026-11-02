import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AgentAuthProviderConfig,
  ExecutionProviderId,
  ProviderParameterValue,
  ResolvedAgentProviderConfig,
} from "../../../core/src/index.ts";

export const LIVE_CASES_FILE_VARIABLE = "ARKIMUX_PROVIDER_CONFORMANCE_CASES_FILE";
export const LIVE_MODE_VARIABLE = "ARKIMUX_PROVIDER_CONFORMANCE_MODE";

export const managedV2ProviderReleaseProfile = {
  profileId: "managed-v2-provider-portability",
  cases: {
    "codex-openai-api-key": {
      executionProviderId: "codex-cli",
      modelProvider: "openai",
      authProviderId: "codex-openai-api-key",
      targetVariable: "OPENAI_API_KEY",
      requiredRuntimeVersion: "0.145.0",
    },
    "pi-openai-api-key": {
      executionProviderId: "pi-cli",
      modelProvider: "openai",
      authProviderId: "pi-openai-api-key",
      targetVariable: "OPENAI_API_KEY",
      requiredRuntimeVersion: "0.84.3",
    },
    "pi-anthropic-api-key": {
      executionProviderId: "pi-cli",
      modelProvider: "anthropic",
      authProviderId: "pi-anthropic-api-key",
      targetVariable: "ANTHROPIC_API_KEY",
      requiredRuntimeVersion: "0.84.3",
    },
    "claude-anthropic-api-key": {
      executionProviderId: "claude-code-cli",
      modelProvider: "anthropic",
      authProviderId: "claude-code-anthropic-api-key",
      targetVariable: "ANTHROPIC_API_KEY",
      requiredRuntimeVersion: "2.1.241",
    },
  },
} as const;

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type LiveConformanceMode = "live" | "release";
export type RequiredUsageField =
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
  | "cost";

export interface EnvironmentLiveAuth {
  kind: "environment";
  authProviderId: string;
  sourceVariable: string;
  targetVariable: string;
}

export interface RuntimeNativeLiveAuth {
  kind: "runtime-native";
  authProviderId: string;
}

export type LiveAuth = EnvironmentLiveAuth | RuntimeNativeLiveAuth;

export interface ProviderLiveCase {
  caseId: string;
  required: boolean;
  executionProviderId: ExecutionProviderId;
  modelProvider: string;
  model: string;
  runtime: {
    command: string;
    requiredVersion: string;
  };
  auth: LiveAuth;
  parameters: Record<string, ProviderParameterValue>;
  timeoutMs: number;
  maxReportedCostUsd: number;
  maxNativeToolCalls: number;
  requiredUsageFields: RequiredUsageField[];
}

export interface ProviderLiveSuite {
  schemaVersion: 1;
  mode: LiveConformanceMode;
  conformanceSetId: string;
  arkimuxRevision: string;
  evidenceDirectory: string;
  requiredCaseIds: string[];
  cases: ProviderLiveCase[];
  definitionPath: string;
}

const executionProviderIds = new Set<ExecutionProviderId>([
  "codex-cli",
  "pi-cli",
  "claude-code-cli",
  "kimi-code-cli",
]);
const usageFields = new Set<RequiredUsageField>([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "cost",
]);
const safeId = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const providerId = /^[a-z][a-z0-9-]*$/;
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const prohibitedParameterKey = /(^|[._-])(api[_-]?key|token|secret|password|authorization)([._-]|$)/i;
const reservedChildVariables = new Set([
  "PATH",
  "TMPDIR",
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "KIMI_CODE_HOME",
]);

export async function loadProviderLiveSuite(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderLiveSuite> {
  const configuredPath = environment[LIVE_CASES_FILE_VARIABLE]?.trim();
  if (!configuredPath) {
    throw new Error(
      `${LIVE_CASES_FILE_VARIABLE} must point to an explicit live-case JSON file. No provider calls were made.`,
    );
  }
  const definitionPath = path.resolve(configuredPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(definitionPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read live provider case file ${definitionPath}: ${safeErrorName(error)}. No provider calls were made.`,
    );
  }
  const suite = parseProviderLiveSuite(raw, definitionPath);
  const requestedMode = environment[LIVE_MODE_VARIABLE]?.trim();
  if (requestedMode !== undefined && requestedMode !== "") {
    if (requestedMode !== "live" && requestedMode !== "release") {
      throw new Error(`${LIVE_MODE_VARIABLE} must be live or release. No provider calls were made.`);
    }
    if (suite.mode !== requestedMode) {
      throw new Error(
        `Live case file mode ${suite.mode} does not match requested mode ${requestedMode}. No provider calls were made.`,
      );
    }
  }

  const missingCredentials = suite.cases.flatMap((testCase) => {
    if (testCase.auth.kind !== "environment") return [];
    return environment[testCase.auth.sourceVariable]?.trim()
      ? []
      : [`${testCase.caseId}:${testCase.auth.sourceVariable}`];
  });
  if (missingCredentials.length > 0) {
    throw new Error(
      `Configured live provider credentials are missing [${missingCredentials.join(", ")}]. Every listed case must run; use a smaller case file for a smaller live run. No provider calls were made.`,
    );
  }
  if (suite.mode === "release") await assertReleaseRepositoryState(suite, environment);
  return suite;
}

export function selectedLiveEnvironment(
  testCase: ProviderLiveCase,
  isolatedHomeRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safeNames = [
    "PATH",
    "TMPDIR",
    "HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "KIMI_CODE_HOME",
  ];
  if (testCase.auth.kind === "environment") safeNames.push(testCase.auth.sourceVariable);
  const selected = Object.fromEntries(safeNames.flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [[name, value]];
  }));
  if (testCase.auth.kind !== "environment") return selected;
  return {
    ...selected,
    HOME: path.join(isolatedHomeRoot, "home"),
    CODEX_HOME: path.join(isolatedHomeRoot, "codex"),
    CLAUDE_CONFIG_DIR: path.join(isolatedHomeRoot, "claude"),
    PI_CODING_AGENT_DIR: path.join(isolatedHomeRoot, "pi"),
    KIMI_CODE_HOME: path.join(isolatedHomeRoot, "kimi"),
  };
}

export function providerConfigForLiveCase(
  testCase: ProviderLiveCase,
  isolatedHomeRoot: string,
): ResolvedAgentProviderConfig {
  const runtime = (command: string) => ({
    command,
    heartbeatIntervalMs: 1_000,
    environmentAllowlist: ["PATH", "TMPDIR"],
  });
  const selectedRuntime = {
    ...runtime(testCase.runtime.command),
    requiredVersion: testCase.runtime.requiredVersion,
    ...(testCase.auth.kind !== "environment" ? {} : {
      ...(testCase.executionProviderId === "pi-cli"
        ? { agentDirectory: path.join(isolatedHomeRoot, "pi") }
        : { parentHome: path.join(isolatedHomeRoot, providerHomeName(testCase.executionProviderId)) }),
    }),
    ...(testCase.executionProviderId === "pi-cli"
      ? { offline: true, telemetry: false, versionCheck: false }
      : {}),
  };
  const executionProviders: ResolvedAgentProviderConfig["executionProviders"] = {
    "codex-cli": runtime("codex"),
    "pi-cli": { ...runtime("pi"), offline: true, telemetry: false, versionCheck: false },
    "claude-code-cli": runtime("claude"),
    "kimi-code-cli": runtime("kimi"),
    [testCase.executionProviderId]: selectedRuntime,
  };
  const auth: AgentAuthProviderConfig = testCase.auth.kind === "environment"
    ? {
        kind: "environment",
        sourceVariable: testCase.auth.sourceVariable,
        targetVariable: testCase.auth.targetVariable,
      }
    : {
        kind: "runtime-native",
        runtime: testCase.executionProviderId,
        modelProvider: testCase.modelProvider,
      };
  return {
    schemaVersion: 1,
    executionProviders,
    authProviders: { [testCase.auth.authProviderId]: auth },
    legacyEnvironmentOverrides: [],
  };
}

function providerHomeName(executionProviderId: ExecutionProviderId): string {
  if (executionProviderId === "codex-cli") return "codex";
  if (executionProviderId === "claude-code-cli") return "claude";
  if (executionProviderId === "kimi-code-cli") return "kimi";
  return "pi";
}

export function parseProviderLiveSuite(value: unknown, definitionPath: string): ProviderLiveSuite {
  const record = requiredRecord(value, "Live provider suite");
  exactKeys(record, [
    "schemaVersion",
    "mode",
    "conformanceSetId",
    "arkimuxRevision",
    "evidenceDirectory",
    "requiredCaseIds",
    "cases",
  ], "Live provider suite");
  if (record.schemaVersion !== 1) throw configError("schemaVersion must be 1");
  if (record.mode !== "live" && record.mode !== "release") {
    throw configError("mode must be live or release");
  }
  const conformanceSetId = identifier(record.conformanceSetId, "conformanceSetId", safeId);
  const arkimuxRevision = nonEmptyString(record.arkimuxRevision, "arkimuxRevision");
  if (record.mode === "release" && !/^[a-f0-9]{40}$/.test(arkimuxRevision)) {
    throw configError("release mode requires arkimuxRevision to be an exact 40-character Git commit");
  }
  const evidenceDirectoryValue = nonEmptyString(record.evidenceDirectory, "evidenceDirectory");
  const evidenceDirectory = path.resolve(path.dirname(definitionPath), evidenceDirectoryValue);
  const requiredCaseIds = stringArray(record.requiredCaseIds, "requiredCaseIds")
    .map((caseId) => identifier(caseId, "requiredCaseIds entry", safeId));
  unique(requiredCaseIds, "requiredCaseIds");
  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    throw configError("cases must contain at least one explicit live case");
  }
  const cases = record.cases.map((testCase, index) => parseCase(testCase, index));
  unique(cases.map((testCase) => testCase.caseId), "case IDs");
  const configuredIds = new Set(cases.map((testCase) => testCase.caseId));
  const requiredIds = new Set(requiredCaseIds);
  const unknownRequired = requiredCaseIds.filter((caseId) => !configuredIds.has(caseId));
  if (unknownRequired.length > 0) {
    throw configError(`requiredCaseIds contains unconfigured cases [${unknownRequired.join(", ")}]`);
  }
  for (const testCase of cases) {
    if (testCase.required !== requiredIds.has(testCase.caseId)) {
      throw configError(
        `case ${testCase.caseId} required must match its presence in requiredCaseIds`,
      );
    }
  }
  if (record.mode === "release") {
    const optional = cases.filter((testCase) => !testCase.required).map((testCase) => testCase.caseId);
    if (optional.length > 0) {
      throw configError(`release mode does not permit optional cases [${optional.join(", ")}]`);
    }
    const experimental = cases.filter((testCase) => testCase.executionProviderId === "kimi-code-cli");
    if (experimental.length > 0) {
      throw configError("release mode does not permit the experimental kimi-code-cli provider");
    }
    validateManagedV2ReleaseProfile(cases, requiredCaseIds);
    const nonAbsoluteCommands = cases
      .filter((testCase) => !path.isAbsolute(testCase.runtime.command))
      .map((testCase) => testCase.caseId);
    if (nonAbsoluteCommands.length > 0) {
      throw configError(
        `release mode requires absolute runtime commands [${nonAbsoluteCommands.join(", ")}]`,
      );
    }
  }
  return {
    schemaVersion: 1,
    mode: record.mode,
    conformanceSetId,
    arkimuxRevision,
    evidenceDirectory,
    requiredCaseIds,
    cases,
    definitionPath,
  };
}

function validateManagedV2ReleaseProfile(
  cases: ProviderLiveCase[],
  requiredCaseIds: string[],
): void {
  const expectedEntries = Object.entries(managedV2ProviderReleaseProfile.cases);
  const expectedIds = expectedEntries.map(([caseId]) => caseId).sort();
  const actualIds = [...requiredCaseIds].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw configError(
      `release mode requires the exact ${managedV2ProviderReleaseProfile.profileId} cases [${expectedIds.join(", ")}]`,
    );
  }
  const caseById = new Map(cases.map((testCase) => [testCase.caseId, testCase]));
  for (const [caseId, expected] of expectedEntries) {
    const testCase = caseById.get(caseId)!;
    if (testCase.executionProviderId !== expected.executionProviderId
      || testCase.modelProvider !== expected.modelProvider
      || testCase.auth.kind !== "environment"
      || testCase.auth.authProviderId !== expected.authProviderId
      || testCase.auth.targetVariable !== expected.targetVariable
      || testCase.runtime.requiredVersion !== expected.requiredRuntimeVersion) {
      throw configError(
        `release case ${caseId} must match its checked-in provider, API-key target, and CLI version profile`,
      );
    }
  }
}

function parseCase(value: unknown, index: number): ProviderLiveCase {
  const location = `cases[${index}]`;
  const record = requiredRecord(value, location);
  exactKeys(record, [
    "caseId",
    "required",
    "executionProviderId",
    "modelProvider",
    "model",
    "runtime",
    "auth",
    "parameters",
    "timeoutMs",
    "maxReportedCostUsd",
    "maxNativeToolCalls",
    "requiredUsageFields",
  ], location);
  const caseId = identifier(record.caseId, `${location}.caseId`, safeId);
  if (typeof record.required !== "boolean") throw configError(`${location}.required must be boolean`);
  if (typeof record.executionProviderId !== "string"
    || !executionProviderIds.has(record.executionProviderId as ExecutionProviderId)) {
    throw configError(`${location}.executionProviderId is unsupported`);
  }
  const executionProviderId = record.executionProviderId as ExecutionProviderId;
  const modelProvider = identifier(record.modelProvider, `${location}.modelProvider`, providerId);
  const model = nonEmptyString(record.model, `${location}.model`);
  const runtimeRecord = requiredRecord(record.runtime, `${location}.runtime`);
  exactKeys(runtimeRecord, ["command", "requiredVersion"], `${location}.runtime`);
  const runtime = {
    command: nonEmptyString(runtimeRecord.command, `${location}.runtime.command`),
    requiredVersion: nonEmptyString(runtimeRecord.requiredVersion, `${location}.runtime.requiredVersion`),
  };
  const auth = parseAuth(record.auth, location, executionProviderId);
  const parameters = parameterRecord(record.parameters, `${location}.parameters`);
  validateParameterIdentity(executionProviderId, modelProvider, model, parameters, location);
  const timeoutMs = integerInRange(record.timeoutMs, 1_000, 60_000, `${location}.timeoutMs`);
  const maxReportedCostUsd = numberInRange(
    record.maxReportedCostUsd,
    0,
    0.10,
    `${location}.maxReportedCostUsd`,
  );
  const maxNativeToolCalls = integerInRange(
    record.maxNativeToolCalls,
    0,
    5,
    `${location}.maxNativeToolCalls`,
  );
  const requiredUsageFields = stringArray(record.requiredUsageFields, `${location}.requiredUsageFields`)
    .map((field) => {
      if (!usageFields.has(field as RequiredUsageField)) {
        throw configError(`${location}.requiredUsageFields contains unsupported field ${field}`);
      }
      return field as RequiredUsageField;
    });
  unique(requiredUsageFields, `${location}.requiredUsageFields`);
  if (requiredUsageFields.includes("cost") && maxReportedCostUsd === 0) {
    throw configError(`${location}.maxReportedCostUsd must be positive when cost is required`);
  }
  if (executionProviderId === "claude-code-cli") {
    const nativeBudget = parameters["max-budget-usd"];
    if (typeof nativeBudget !== "number" || nativeBudget <= 0
      || nativeBudget > maxReportedCostUsd) {
      throw configError(
        `${location}.parameters.max-budget-usd must be positive and no greater than maxReportedCostUsd`,
      );
    }
  }
  return {
    caseId,
    required: record.required,
    executionProviderId,
    modelProvider,
    model,
    runtime,
    auth,
    parameters,
    timeoutMs,
    maxReportedCostUsd,
    maxNativeToolCalls,
    requiredUsageFields,
  };
}

function parseAuth(
  value: unknown,
  location: string,
  executionProviderId: ExecutionProviderId,
): LiveAuth {
  const record = requiredRecord(value, `${location}.auth`);
  if (record.kind === "environment") {
    exactKeys(
      record,
      ["kind", "authProviderId", "sourceVariable", "targetVariable"],
      `${location}.auth`,
    );
    const targetVariable = identifier(
      record.targetVariable,
      `${location}.auth.targetVariable`,
      variableName,
    );
    if (reservedChildVariables.has(targetVariable)) {
      throw configError(`${location}.auth.targetVariable cannot replace a runtime control variable`);
    }
    return {
      kind: "environment",
      authProviderId: identifier(record.authProviderId, `${location}.auth.authProviderId`, providerId),
      sourceVariable: identifier(record.sourceVariable, `${location}.auth.sourceVariable`, variableName),
      targetVariable,
    };
  }
  if (record.kind === "runtime-native") {
    exactKeys(record, ["kind", "authProviderId"], `${location}.auth`);
    return {
      kind: "runtime-native",
      authProviderId: identifier(record.authProviderId, `${location}.auth.authProviderId`, providerId),
    };
  }
  throw configError(
    `${location}.auth.kind must be environment or runtime-native for ${executionProviderId}`,
  );
}

function parameterRecord(value: unknown, location: string): Record<string, ProviderParameterValue> {
  const record = requiredRecord(value, location);
  return Object.fromEntries(Object.entries(record).map(([key, candidate]) => {
    if (!key || prohibitedParameterKey.test(key)) {
      throw configError(`${location}.${key || "<empty>"} is not a safe persisted parameter`);
    }
    if (typeof candidate === "string" || typeof candidate === "boolean"
      || (typeof candidate === "number" && Number.isFinite(candidate))) {
      return [key, candidate];
    }
    if (Array.isArray(candidate) && candidate.every((item) => (
      typeof item === "string" || typeof item === "boolean"
      || (typeof item === "number" && Number.isFinite(item))
    ))) {
      return [key, candidate as ProviderParameterValue];
    }
    throw configError(`${location}.${key} must be a scalar or scalar array`);
  }));
}

function validateParameterIdentity(
  executionProviderId: ExecutionProviderId,
  modelProvider: string,
  model: string,
  parameters: Record<string, ProviderParameterValue>,
  location: string,
): void {
  if (parameters.model !== model) {
    throw configError(`${location}.parameters.model must equal ${location}.model`);
  }
  if (executionProviderId === "pi-cli" && parameters.provider !== modelProvider) {
    throw configError(`${location}.parameters.provider must equal ${location}.modelProvider`);
  }
  if (executionProviderId === "claude-code-cli" && modelProvider !== "anthropic") {
    throw configError(`${location}.modelProvider must be anthropic for claude-code-cli`);
  }
  if (executionProviderId === "codex-cli") {
    const configured = parameters.model_provider;
    if (configured !== undefined && configured !== modelProvider) {
      throw configError(`${location}.parameters.model_provider must equal ${location}.modelProvider`);
    }
    if (configured === undefined && modelProvider !== "openai") {
      throw configError(`${location}.parameters.model_provider is required for non-OpenAI Codex protocols`);
    }
  }
  if (executionProviderId === "kimi-code-cli") {
    const configured = parameters["provider-type"] ?? "kimi";
    if (configured !== modelProvider) {
      throw configError(`${location}.parameters.provider-type must equal ${location}.modelProvider`);
    }
  }
}

function requiredRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configError(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: string[], location: string): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => record[key] === undefined);
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0) throw configError(`${location} is missing fields [${missing.join(", ")}]`);
  if (unknown.length > 0) throw configError(`${location} contains unknown fields [${unknown.join(", ")}]`);
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${location} must be a non-empty string`);
  }
  return value.trim();
}

function identifier(value: unknown, location: string, pattern: RegExp): string {
  const result = nonEmptyString(value, location);
  if (!pattern.test(result)) throw configError(`${location} has an invalid format`);
  return result;
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw configError(`${location} must be an array of strings`);
  }
  return [...value];
}

function unique(values: readonly string[], location: string): void {
  if (new Set(values).size !== values.length) throw configError(`${location} must not contain duplicates`);
}

function integerInRange(value: unknown, min: number, max: number, location: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw configError(`${location} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function numberInRange(value: unknown, min: number, max: number, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw configError(`${location} must be a number from ${min} through ${max}`);
  }
  return value;
}

function configError(message: string): Error {
  return new Error(`Invalid live provider case file: ${message}. No provider calls were made.`);
}

async function assertReleaseRepositoryState(
  suite: ProviderLiveSuite,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const relativeDefinitionPath = path.relative(repositoryRoot, suite.definitionPath);
  if (relativeDefinitionPath.startsWith("..") || path.isAbsolute(relativeDefinitionPath)) {
    throw new Error(
      "Release provider conformance requires its case file to be tracked in this repository. No provider calls were made.",
    );
  }
  const gitEnvironment = environment.PATH === undefined ? {} : { PATH: environment.PATH };
  let head: string;
  let status: string;
  try {
    await execFileAsync(
      "git",
      ["ls-files", "--error-unmatch", "--", relativeDefinitionPath],
      {
        cwd: repositoryRoot,
        env: gitEnvironment,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      },
    );
    const headResult = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      env: gitEnvironment,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    head = headResult.stdout.trim();
    const statusResult = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: repositoryRoot,
        env: gitEnvironment,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    );
    status = statusResult.stdout.trim();
  } catch (error) {
    throw new Error(
      `Release provider conformance could not verify its tracked case file and repository state: ${safeErrorName(error)}. No provider calls were made.`,
    );
  }
  if (head !== suite.arkimuxRevision) {
    throw new Error(
      `Release provider conformance requires HEAD ${suite.arkimuxRevision}, but the current repository is at ${head || "an unknown revision"}. No provider calls were made.`,
    );
  }
  if (status.length > 0) {
    throw new Error(
      "Release provider conformance requires a clean tracked and untracked worktree. No provider calls were made.",
    );
  }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}
