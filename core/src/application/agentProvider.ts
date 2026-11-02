export type ProviderParameterScalar = string | number | boolean;
export type ProviderParameterValue = ProviderParameterScalar | ProviderParameterScalar[];

export interface CodexCliExecutionConfig {
  provider: "codex-cli";
  authProvider: string;
  /** Exact Codex configuration keys and TOML-compatible values. */
  parameters: Record<string, ProviderParameterValue>;
}

export interface PiCliExecutionConfig {
  provider: "pi-cli";
  authProvider: string;
  /** Exact Pi CLI option names and values. */
  parameters: {
    provider: string;
    model: string;
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
}

export interface ClaudeCodeCliExecutionConfig {
  provider: "claude-code-cli";
  authProvider: string;
  /** Exact Claude Code CLI option names and values supported by the adapter. */
  parameters: {
    model: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    "permission-mode"?: "default" | "acceptEdits" | "plan" | "auto" | "manual" | "dontAsk" | "bypassPermissions";
    "max-budget-usd"?: number;
  };
}

export interface KimiCodeCliExecutionConfig {
  provider: "kimi-code-cli";
  authProvider: string;
  /** Exact Kimi Code model/runtime values supported by the adapter. */
  parameters: {
    model: string;
    "provider-type"?: "kimi" | "anthropic" | "openai";
    "base-url"?: string;
    "max-context-size"?: number;
    capabilities?: string[];
    "thinking-effort"?: "low" | "medium" | "high" | "xhigh" | "max";
  };
}

export interface AgentExecutionConfigByProvider {
  "codex-cli": CodexCliExecutionConfig;
  "pi-cli": PiCliExecutionConfig;
  "claude-code-cli": ClaudeCodeCliExecutionConfig;
  "kimi-code-cli": KimiCodeCliExecutionConfig;
}

export type AgentExecutionConfig =
  AgentExecutionConfigByProvider[keyof AgentExecutionConfigByProvider];

export interface AgentRunPolicy {
  timeoutMs: number;
  execution: AgentExecutionConfig;
}

export interface ResolvedAgentProviderConfigArtifact {
  schemaVersion: 1;
  executionProviders: Record<string, {
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
  }>;
  authProviders: Record<string, {
    kind: string;
    preflightStatus: "not-checked" | "available" | "unavailable";
    [key: string]: unknown;
  }>;
  legacyEnvironmentOverrides: string[];
}

export interface AgentExecutionArtifacts {
  eventsPath: string;
  stderrPath: string;
  lastMessagePath: string;
  heartbeatPath: string;
  repositoryToolAuditPath?: string;
}

export interface AgentExecutionToolMetrics {
  nativeToolCalls: number;
  toolCallUnit: "shell-command" | "guarded-repository-operation" | "native-tool-call";
  repositorySearchCalls?: number;
  fileReadCalls?: number;
  repositoryResultBytes?: number;
  rejectedRepositoryCalls?: number;
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cost?: {
    amount: number;
    currency: string;
    kind: "provider-estimate" | "billed";
  };
}

export interface AgentExecutionMetrics extends AgentExecutionToolMetrics {
  providerId: string;
  label?: string;
  attempt?: number;
  model?: string;
  reasoningEffort?: string;
  status: "complete" | "failed" | "timed-out";
  elapsedMs: number;
  artifacts: AgentExecutionArtifacts;
  usage?: AgentUsage;
}

export interface AgentExecutionRequest {
  /** Host-owned cancellation, never serialized into configuration or artifacts.
   * Runners must settle their process and artifact work before rejecting. */
  signal?: AbortSignal;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  authProviderId: string;
  artifactPrefix?: string;
  label?: string;
  attempt?: number;
  /** Exact provider-native configuration keys and values. */
  parameters: Record<string, ProviderParameterValue>;
}

export interface AgentExecutionResult {
  output: string;
  metrics: AgentExecutionMetrics;
}

export interface AgentAuthContext {
  cwd: string;
  executionProviderId: string;
  modelProvider?: string;
  model?: string;
  executable?: {
    path: string;
    version?: string;
  };
}

export type AgentAuthReadinessStatus = "ready" | "unavailable" | "indeterminate";
export type AgentAuthReadinessReason =
  | "session-missing"
  | "session-rejected"
  | "plan-or-billing-required"
  | "credential-invalid"
  | "provider-unavailable"
  | "unknown";

export interface AgentAuthIdentity {
  authMethod?: string;
  accountEmail?: string;
  reportedPlan?: string;
}

export interface AgentAuthRemediation {
  kind: "login" | "upgrade" | "configure-api-key" | "retry";
  label: string;
}

export interface AuthAvailability {
  authProviderId: string;
  kind: "runtime-native" | "environment" | "command" | "stored-credential";
  available: boolean;
  status: AgentAuthReadinessStatus;
  reason?: AgentAuthReadinessReason;
  identity?: AgentAuthIdentity;
  executable?: {
    path: string;
    version?: string;
  };
  remediation?: AgentAuthRemediation[];
  message?: string;
  /** Safe external diagnostic supplied by the authentication adapter, not inferred by callers. */
  externalDiagnostic?: import("./externalError.ts").ExternalErrorDiagnostic;
}

export interface PreparedAgentAuth {
  environment: Record<string, string>;
  credentialDirectory?: string;
  dispose(): Promise<void>;
}

export interface AgentAuthProvider {
  readonly authProviderId: string;
  readonly kind: AuthAvailability["kind"];
  preflight(context: AgentAuthContext): Promise<AuthAvailability>;
  prepare(context: AgentAuthContext): Promise<PreparedAgentAuth>;
}

export interface AgentAuthProviderRegistry {
  get(authProviderId: string): AgentAuthProvider;
}

export interface AgentExecutionPreflightRequest {
  cwd: string;
  authProviderId: string;
  parameters: Record<string, ProviderParameterValue>;
}

export interface AgentExecutionPreflightResult {
  providerId: string;
  auth: AuthAvailability;
  available: boolean;
  resolvedCommand?: string;
  commandSource?: "explicit" | "repository-local" | "path";
  message?: string;
  externalDiagnostic?: import("./externalError.ts").ExternalErrorDiagnostic;
}

export interface AgentExecutionProvider {
  readonly providerId: string;
  preflight(request: AgentExecutionPreflightRequest): Promise<AgentExecutionPreflightResult>;
  run(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  /** Optional runtime-owned, metadata-only selection for a connection check. */
  getConnectionProbeParameters?(request: AgentExecutionPreflightRequest & { timeoutMs: number }): Promise<Record<string, ProviderParameterValue>>;
}

export interface AgentExecutionProviderRegistry {
  get(providerId: string): AgentExecutionProvider;
}

export interface PiAgentExtensionContext {
  cwd: string;
  agentDirectory: string;
  artifactPrefix: string;
}

export interface PreparedPiAgentExtension {
  arguments: string[];
  environment: Record<string, string>;
  artifacts: Pick<AgentExecutionArtifacts, "repositoryToolAuditPath">;
  collectToolMetrics(): Promise<AgentExecutionToolMetrics | undefined>;
  dispose(): Promise<void>;
}

export interface PiAgentExtensionProvider {
  prepare(context: PiAgentExtensionContext): Promise<PreparedPiAgentExtension>;
}

export class NoopPiAgentExtensionProvider implements PiAgentExtensionProvider {
  async prepare(_context: PiAgentExtensionContext): Promise<PreparedPiAgentExtension> {
    return {
      arguments: [],
      environment: {},
      artifacts: {},
      collectToolMetrics: async () => undefined,
      dispose: async () => undefined,
    };
  }
}
