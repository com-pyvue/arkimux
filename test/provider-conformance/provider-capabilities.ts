export const providerIds = [
  "codex-cli",
  "pi-cli",
  "claude-code-cli",
  "kimi-code-cli",
] as const;

export type ProviderId = typeof providerIds[number];
export type CapabilityStatus =
  | "supported"
  | "partial"
  | "unsupported"
  | "experimental"
  | "not-applicable";
export type ProductStatus = "candidate" | "experimental";
export type TestLevel = "contract" | "adapter" | "live-provider" | "managed-host";
export type GapStatus = "open" | "accepted" | "prospect";

export interface ProviderCapabilityCell {
  status: CapabilityStatus;
  note: string;
  evidenceIds: readonly string[];
  trackingIds: readonly string[];
}

export interface ProviderCapabilityDefinition {
  capabilityId: string;
  category: string;
  title: string;
  description: string;
  providers: Record<ProviderId, ProviderCapabilityCell>;
}

export interface ProviderExecutionCombination {
  combinationId: string;
  productStatus: ProductStatus;
  executionProviderId: ProviderId;
  modelProvider: string;
  authenticationKind: "runtime-native" | "environment" | "stored-credential" | "command";
  authenticationReferenceKind:
    | "current-auth-provider-id"
    | "auth-provider-preset-id"
    | "target-auth-provider-id"
    | "configured-auth-provider-id";
  authenticationReference: string;
  supportStatus: CapabilityStatus;
  journey: string;
  notes: string;
  evidenceIds: readonly string[];
  trackingIds: readonly string[];
}

export interface ProviderEvidenceDefinition {
  evidenceId: string;
  level: TestLevel;
  providerIds: readonly ProviderId[];
  sourcePath: string;
  testName: string;
  notes: string;
}

export interface ProviderGapDefinition {
  trackingId: string;
  title: string;
  status: GapStatus;
  affectedProviderIds: readonly ProviderId[];
  description: string;
}

function supported(note: string, evidenceIds: readonly string[]): ProviderCapabilityCell {
  return { status: "supported", note, evidenceIds, trackingIds: [] };
}

function partial(
  note: string,
  evidenceIds: readonly string[],
  trackingIds: readonly string[],
): ProviderCapabilityCell {
  return { status: "partial", note, evidenceIds, trackingIds };
}

function unsupported(note: string, trackingIds: readonly string[]): ProviderCapabilityCell {
  return { status: "unsupported", note, evidenceIds: [], trackingIds };
}

function experimental(
  note: string,
  evidenceIds: readonly string[],
  trackingIds: readonly string[] = [],
): ProviderCapabilityCell {
  return { status: "experimental", note, evidenceIds, trackingIds };
}

function notApplicable(note: string): ProviderCapabilityCell {
  return { status: "not-applicable", note, evidenceIds: [], trackingIds: [] };
}

export const providerEvidence = [
  {
    evidenceId: "APC-E001",
    level: "adapter",
    providerIds: ["codex-cli"],
    sourcePath: "test/core/codex-auth-integration.test.ts",
    testName: "gives Codex only allowlisted environment and selected authentication",
    notes: "Uses a fake Codex executable to prove prompt delivery, selected-key injection, environment filtering, final output, and temporary-home cleanup.",
  },
  {
    evidenceId: "APC-E002",
    level: "contract",
    providerIds: ["codex-cli"],
    sourcePath: "test/core/codex-cli-agent-runner.test.ts",
    testName: "projects comparable usage and shell-command metrics",
    notes: "Proves Codex JSONL token and shell-command metric projection.",
  },
  {
    evidenceId: "APC-E003",
    level: "contract",
    providerIds: ["codex-cli"],
    sourcePath: "test/core/codex-cli-agent-runner.test.ts",
    testName: "preserves the provider's model eligibility explanation without inventing advice",
    notes: "Proves the selected Codex access-error explanation is preserved without substituting normalized advice or exposing unrelated event fields.",
  },
  {
    evidenceId: "APC-E004",
    level: "adapter",
    providerIds: ["pi-cli"],
    sourcePath: "test/agent-input/code/pi-cli-agent-runner.test.ts",
    testName: "runs Pi ephemerally and normalizes its JSON event stream",
    notes: "Uses a fake Pi executable to prove fixed flags, prompt delivery, key isolation, artifacts, usage, and temporary-directory cleanup.",
  },
  {
    evidenceId: "APC-E005",
    level: "adapter",
    providerIds: ["pi-cli"],
    sourcePath: "test/agent-input/code/guarded-repository-tools.test.ts",
    testName: "paginates deterministic listings, searches, reads, and batch reads",
    notes: "Proves the four guarded read-only repository operations and pagination.",
  },
  {
    evidenceId: "APC-E006",
    level: "adapter",
    providerIds: ["pi-cli"],
    sourcePath: "test/agent-input/code/guarded-repository-tools.test.ts",
    testName: "rejects absolute paths, traversal, symlink escapes, binary files, and oversized reads",
    notes: "Proves the guarded repository boundary and bounded results.",
  },
  {
    evidenceId: "APC-E007",
    level: "adapter",
    providerIds: ["claude-code-cli"],
    sourcePath: "test/core/native-cli-agent-runners.test.ts",
    testName: "runs Claude Code through the provider-independent execution contract",
    notes: "Uses a fake Claude executable to prove prompt delivery, key injection, final output, tool count, usage, and estimated cost.",
  },
  {
    evidenceId: "APC-E008",
    level: "adapter",
    providerIds: ["claude-code-cli"],
    sourcePath: "test/core/native-cli-agent-runners.test.ts",
    testName: "preserves Claude's authentication error without guessing plan eligibility",
    notes: "Proves the selected Claude native-session failure is preserved without invented plan eligibility advice.",
  },
  {
    evidenceId: "APC-E009",
    level: "adapter",
    providerIds: ["kimi-code-cli"],
    sourcePath: "test/core/native-cli-agent-runners.test.ts",
    testName: "runs Kimi Code with an isolated prompt file and ephemeral model environment",
    notes: "Uses a fake Kimi executable to prove the experimental adapter's prompt file, model environment, output, usage, and tool count.",
  },
  {
    evidenceId: "APC-E010",
    level: "adapter",
    providerIds: ["kimi-code-cli"],
    sourcePath: "test/core/native-cli-agent-runners.test.ts",
    testName: "runs Kimi Code against the runtime-native session home",
    notes: "Proves that the experimental Kimi adapter can reuse its configured native-session home.",
  },
  {
    evidenceId: "APC-E011",
    level: "contract",
    providerIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    sourcePath: "test/core/agent-auth-provider.test.ts",
    testName: "maps only the selected environment credential into the target variable",
    notes: "Proves generic environment-key preparation and disposal.",
  },
  {
    evidenceId: "APC-E012",
    level: "contract",
    providerIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    sourcePath: "test/core/agent-auth-provider.test.ts",
    testName: "retrieves a credential from a fixed helper without exposing helper details",
    notes: "Proves generic command-backed credential retrieval.",
  },
  {
    evidenceId: "APC-E013",
    level: "contract",
    providerIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    sourcePath: "test/core/agent-credential-store.test.ts",
    testName: "stores a write-only local credential with restrictive permissions and resolves it only at execution",
    notes: "Proves stored-key metadata separation and invocation-time resolution.",
  },
  {
    evidenceId: "APC-E014",
    level: "contract",
    providerIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    sourcePath: "test/core/agent-execution-provider.test.ts",
    testName: "performs an isolated minimal auth probe without workflow context or tools",
    notes: "Proves the active connection-check contract.",
  },
  {
    evidenceId: "APC-E015",
    level: "adapter",
    providerIds: ["codex-cli", "claude-code-cli"],
    sourcePath: "test/core/codex-auth-integration.test.ts",
    testName: "preflights the same repository-local Codex executable that execution resolves",
    notes: "Together with the matching Claude test, proves repository-local executable resolution and preflight identity.",
  },
  {
    evidenceId: "APC-E016",
    level: "contract",
    providerIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    sourcePath: "test/core/run-configuration.test.ts",
    testName: "validates provider-native parameters and prohibits persisted secrets",
    notes: "Proves persisted parameter validation and secret-like key rejection.",
  },
  {
    evidenceId: "APC-E017",
    level: "contract",
    providerIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    sourcePath: "test/core/run-records.test.ts",
    testName: "validates deterministic performance summaries containing provider costs",
    notes: "Proves the provider-neutral attempt and run-performance aggregation contract.",
  },
  {
    evidenceId: "APC-E018",
    level: "adapter",
    providerIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    sourcePath: "test/provider-conformance/contract/agent-execution-provider.contract.test.ts",
    testName: "preflights and runs through the provider-neutral contract",
    notes: "Runs every real adapter against a controlled fake CLI to prove common preflight, prompt, configuration, key isolation, final output, artifacts, and metrics.",
  },
  {
    evidenceId: "APC-E019",
    level: "adapter",
    providerIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    sourcePath: "test/provider-conformance/contract/agent-execution-provider.contract.test.ts",
    testName: "terminates a timed-out invocation and retains provider-neutral diagnostics",
    notes: "Runs every real adapter against a controlled hanging CLI to prove timeout termination, typed failure metrics, and retained diagnostics.",
  },
  {
    evidenceId: "APC-E020",
    level: "adapter",
    providerIds: ["pi-cli"],
    sourcePath: "test/provider-conformance/contract/agent-execution-provider.contract.test.ts",
    testName: "runs Pi with an Anthropic native session through an isolated agent directory",
    notes: "Uses a fake Pi executable and a configured Anthropic auth.json session to prove the generic native-session execution path and isolated copied agent directory.",
  },
] as const satisfies readonly ProviderEvidenceDefinition[];

export const providerGaps = [
  {
    trackingId: "APC-GAP-001",
    title: "No real-provider conformance suite",
    status: "open",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "Current automated runner evidence uses fake CLI executables. It does not prove current pinned CLIs against live provider protocols, accounts, streaming, tools, or errors.",
  },
  {
    trackingId: "APC-GAP-002",
    title: "No caller-facing response streaming",
    status: "prospect",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "Runners append native output to local artifacts while executing, but return to callers only after the process closes.",
  },
  {
    trackingId: "APC-GAP-003",
    title: "No external cancellation contract",
    status: "open",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "The execution request has no AbortSignal or cancellation method. Only timeout-driven child termination exists.",
  },
  {
    trackingId: "APC-GAP-004",
    title: "No automatic retry or provider idempotency contract",
    status: "prospect",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "Attempt is metadata only. The wrapper does not retry execution or carry a provider idempotency key. Managed dispatch recovery is a separate host concern and does not provide either wrapper behavior.",
  },
  {
    trackingId: "APC-GAP-005",
    title: "No provider-native structured output",
    status: "prospect",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "ArkiMux parses final text as JSON after execution. It does not send a JSON Schema, validate a typed result, or repair invalid output at the provider boundary.",
  },
  {
    trackingId: "APC-GAP-006",
    title: "No portable tool contract",
    status: "prospect",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "Native tools differ by runner. Only Pi has a runner-owned extension point and current guarded repository implementation.",
  },
  {
    trackingId: "APC-GAP-007",
    title: "Native tool-call metrics fail shared validation",
    status: "open",
    affectedProviderIds: ["claude-code-cli", "kimi-code-cli"],
    description: "The metrics type and runners use native-tool-call, while the shared validator currently accepts only shell-command and guarded-repository-operation.",
  },
  {
    trackingId: "APC-GAP-008",
    title: "Kimi product exposure conflicts with the prospect decision",
    status: "open",
    affectedProviderIds: ["kimi-code-cli"],
    description: "Product documents exclude Kimi, but current default registry, editor metadata, templates, native-session rows, and authentication presets still contain it.",
  },
  {
    trackingId: "APC-GAP-009",
    title: "Runners still allocate their own temporary paths",
    status: "accepted",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "The target host-controlled scratch contract is not implemented. Claude also has no runner-owned isolated configuration home today. Managed V1 owns this contract for released managed providers; Kimi remains excluded.",
  },
  {
    trackingId: "APC-GAP-010",
    title: "Provider proxy is not implemented",
    status: "prospect",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli"],
    description: "There is no proxy protocol adapter, workload identity, short-lived operation grant, proxy usage policy, or proxy conformance evidence.",
  },
  {
    trackingId: "APC-GAP-011",
    title: "No common execution error taxonomy",
    status: "open",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "Runners throw provider-specific Error subclasses with messages and optional metrics. Only selected Codex and Claude failures are normalized.",
  },
  {
    trackingId: "APC-GAP-012",
    title: "No retained-output secret redaction",
    status: "open",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "The platform avoids persisting configured credentials, but native stdout, stderr, and final output are retained without a runner-level redaction guarantee.",
  },
  {
    trackingId: "APC-GAP-013",
    title: "Input is one text prompt only",
    status: "prospect",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "The common request has no message history, role-separated instructions, image, audio, or file-part input.",
  },
  {
    trackingId: "APC-GAP-014",
    title: "Preflight lifecycle event is declared but not emitted",
    status: "open",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "agent-preflight-completed exists in RunEvent, but no current producer emits it.",
  },
  {
    trackingId: "APC-GAP-015",
    title: "Command authentication is configuration-only",
    status: "prospect",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "The core authentication registry supports a credential command, but the current portal creates stored-credential bindings rather than command bindings.",
  },
  {
    trackingId: "APC-GAP-016",
    title: "Kimi session isolation is not enforced",
    status: "open",
    affectedProviderIds: ["kimi-code-cli"],
    description: "The experimental Kimi command does not request no-session behavior, and native authentication reuses the configured session home.",
  },
  {
    trackingId: "APC-GAP-017",
    title: "Usage and diagnostic metrics are not equal across runners",
    status: "prospect",
    affectedProviderIds: ["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"],
    description: "Reasoning tokens, cost, detailed tool counts, stop reason, request ID, time to first token, and rate-limit data vary or are absent.",
  },
  {
    trackingId: "APC-GAP-018",
    title: "Pi Anthropic native Connection is not productized",
    status: "open",
    affectedProviderIds: ["pi-cli"],
    description: "The generic Pi native-session runner can read an Anthropic session from auth.json, but the current default configuration and UI expose only Pi OpenAI Codex Session, and no real-provider proof exists.",
  },
] as const satisfies readonly ProviderGapDefinition[];

const noHistory = unsupported("No message-history or role-separated input.", ["APC-GAP-013"]);
const noMultimodal = unsupported("No image, audio, or file-part input.", ["APC-GAP-013"]);
const noStreaming = unsupported("Only artifact capture is live; callers wait for completion.", ["APC-GAP-002"]);
const noCancellation = unsupported("No caller cancellation signal or method.", ["APC-GAP-003"]);
const noRetry = unsupported("No automatic execution retry.", ["APC-GAP-004"]);
const noIdempotency = unsupported("No provider request idempotency key.", ["APC-GAP-004"]);
const noNativeSchema = unsupported("No provider-native JSON Schema response contract.", ["APC-GAP-005"]);
const noPortableTools = unsupported("No shared tool declaration and result contract.", ["APC-GAP-006"]);
const noProxy = unsupported("No provider proxy authentication or protocol path.", ["APC-GAP-010"]);
const noRedaction = unsupported("Retained native output has no secret-redaction guarantee.", ["APC-GAP-012"]);
const noErrorCodes = unsupported("No common machine-readable execution error code.", ["APC-GAP-011"]);
const noHostScratch = unsupported("Runner chooses temporary paths instead of receiving host scratch.", ["APC-GAP-009"]);

export const providerCapabilities = [
  {
    capabilityId: "single-text-prompt",
    category: "Input",
    title: "Single text prompt",
    description: "Send one complete text prompt to one agent invocation.",
    providers: {
      "codex-cli": supported("Delivered through stdin.", ["APC-E001", "APC-E018"]),
      "pi-cli": supported("Delivered through stdin.", ["APC-E004", "APC-E018"]),
      "claude-code-cli": supported("Delivered through stdin.", ["APC-E007", "APC-E018"]),
      "kimi-code-cli": experimental("Delivered through an isolated prompt file.", ["APC-E009", "APC-E018"]),
    },
  },
  {
    capabilityId: "working-directory",
    category: "Input",
    title: "Working directory",
    description: "Run the selected CLI against the supplied repository directory.",
    providers: {
      "codex-cli": supported("Child process uses request.cwd.", ["APC-E001"]),
      "pi-cli": supported("Child process uses request.cwd.", ["APC-E004"]),
      "claude-code-cli": supported("Child process uses request.cwd.", ["APC-E007"]),
      "kimi-code-cli": experimental("Child process uses request.cwd.", ["APC-E009"]),
    },
  },
  {
    capabilityId: "message-history",
    category: "Input",
    title: "Message history",
    description: "Supply role-separated prior messages or resume a conversation.",
    providers: {
      "codex-cli": noHistory,
      "pi-cli": noHistory,
      "claude-code-cli": noHistory,
      "kimi-code-cli": noHistory,
    },
  },
  {
    capabilityId: "multimodal-input",
    category: "Input",
    title: "Multimodal input",
    description: "Supply images, audio, or typed file parts through the common request.",
    providers: {
      "codex-cli": noMultimodal,
      "pi-cli": noMultimodal,
      "claude-code-cli": noMultimodal,
      "kimi-code-cli": noMultimodal,
    },
  },
  {
    capabilityId: "model-selection",
    category: "Configuration",
    title: "Model selection",
    description: "Select a provider-native model in the immutable run policy.",
    providers: {
      "codex-cli": supported("Forwards the model as Codex configuration.", ["APC-E001", "APC-E016", "APC-E018"]),
      "pi-cli": supported("Requires provider and model values.", ["APC-E004", "APC-E016", "APC-E018"]),
      "claude-code-cli": supported("Requires a Claude model or alias.", ["APC-E007", "APC-E016", "APC-E018"]),
      "kimi-code-cli": experimental("Requires a Kimi model value.", ["APC-E009", "APC-E016", "APC-E018"]),
    },
  },
  {
    capabilityId: "reasoning-control",
    category: "Configuration",
    title: "Reasoning or thinking control",
    description: "Select the runner's supported reasoning or thinking level.",
    providers: {
      "codex-cli": supported("Uses model_reasoning_effort.", ["APC-E002", "APC-E016", "APC-E018"]),
      "pi-cli": supported("Uses thinking, including off.", ["APC-E004", "APC-E016", "APC-E018"]),
      "claude-code-cli": supported("Uses effort.", ["APC-E007", "APC-E016", "APC-E018"]),
      "kimi-code-cli": experimental("Uses thinking-effort.", ["APC-E009", "APC-E016", "APC-E018"]),
    },
  },
  {
    capabilityId: "model-provider-routing",
    category: "Configuration",
    title: "Model-provider routing",
    description: "Select a provider protocol independently from the execution CLI where supported.",
    providers: {
      "codex-cli": partial("Accepts arbitrary Codex model_provider configuration, but candidate proof is OpenAI-focused.", ["APC-E001"], ["APC-GAP-001"]),
      "pi-cli": supported("Requires an explicit provider and installed text-model catalog entry.", ["APC-E004"]),
      "claude-code-cli": notApplicable("The adapter is fixed to the native Anthropic protocol."),
      "kimi-code-cli": experimental("Supports kimi, anthropic, or openai provider types.", ["APC-E009"]),
    },
  },
  {
    capabilityId: "provider-native-parameters",
    category: "Configuration",
    title: "Provider-native parameters",
    description: "Forward documented provider-specific configuration values.",
    providers: {
      "codex-cli": supported("Forwards scalar and scalar-array values as sorted Codex --config entries.", ["APC-E001", "APC-E016", "APC-E018"]),
      "pi-cli": supported("Strictly accepts provider, model, and thinking.", ["APC-E004", "APC-E016", "APC-E018"]),
      "claude-code-cli": supported("Accepts model, effort, permission mode, and maximum USD budget.", ["APC-E007", "APC-E016", "APC-E018"]),
      "kimi-code-cli": experimental("Accepts provider type, base URL, context size, capabilities, and thinking effort.", ["APC-E009", "APC-E016", "APC-E018"]),
    },
  },
  {
    capabilityId: "executable-preflight",
    category: "Readiness",
    title: "Executable and version preflight",
    description: "Resolve and probe the CLI before paid execution starts.",
    providers: {
      "codex-cli": supported("Resolves explicit, repository-local, then PATH executable.", ["APC-E015", "APC-E018"]),
      "pi-cli": supported("Uses the shared executable resolver and version probe.", ["APC-E004", "APC-E018"]),
      "claude-code-cli": supported("Also checks the configured required version.", ["APC-E015", "APC-E018"]),
      "kimi-code-cli": experimental("Also checks the configured required version.", ["APC-E009", "APC-E018"]),
    },
  },
  {
    capabilityId: "runtime-native-authentication",
    category: "Authentication",
    title: "Runtime-native session",
    description: "Use a login session owned by the selected CLI.",
    providers: {
      "codex-cli": supported("Uses Codex login status and isolated child home links.", ["APC-E003"]),
      "pi-cli": partial("The generic runner can use auth.json, but Pi Anthropic native Connection setup and live proof are missing.", ["APC-E020"], ["APC-GAP-001", "APC-GAP-018"]),
      "claude-code-cli": supported("Uses claude auth status and provider-reported identity when available.", ["APC-E008"]),
      "kimi-code-cli": experimental("Uses the configured Kimi native-session home.", ["APC-E010"], ["APC-GAP-016"]),
    },
  },
  {
    capabilityId: "api-key-authentication",
    category: "Authentication",
    title: "API-key authentication",
    description: "Inject one selected environment or stored API key at invocation time.",
    providers: {
      "codex-cli": supported("Supports environment and stored OpenAI keys.", ["APC-E001", "APC-E011", "APC-E013"]),
      "pi-cli": supported("Supports environment and stored keys for configured model providers.", ["APC-E004", "APC-E011", "APC-E013"]),
      "claude-code-cli": supported("Supports environment and stored Anthropic keys.", ["APC-E007", "APC-E011", "APC-E013"]),
      "kimi-code-cli": experimental("Supports environment and stored Kimi model keys.", ["APC-E009", "APC-E011", "APC-E013"]),
    },
  },
  {
    capabilityId: "command-authentication",
    category: "Authentication",
    title: "Credential command",
    description: "Run a fixed helper and inject its stdout as the selected credential.",
    providers: {
      "codex-cli": partial("Supported by core configuration, not current portal creation.", ["APC-E012"], ["APC-GAP-015"]),
      "pi-cli": partial("Supported by core configuration, not current portal creation.", ["APC-E012"], ["APC-GAP-015"]),
      "claude-code-cli": partial("Supported by core configuration, not current portal creation.", ["APC-E012"], ["APC-GAP-015"]),
      "kimi-code-cli": experimental("Implemented by the shared auth registry but outside the product promise.", ["APC-E012"], ["APC-GAP-015"]),
    },
  },
  {
    capabilityId: "active-connection-probe",
    category: "Authentication",
    title: "Active connection probe",
    description: "Perform isolated minimal inference to verify the exact auth and runtime binding.",
    providers: {
      "codex-cli": supported("Uses a low-effort tool-free probe prompt.", ["APC-E014"]),
      "pi-cli": supported("Can try later stable catalog models after a model-access failure.", ["APC-E014"]),
      "claude-code-cli": supported("Uses Haiku, low effort, and plan permission mode.", ["APC-E014"]),
      "kimi-code-cli": experimental("Uses the experimental Kimi runtime and model.", ["APC-E014"]),
    },
  },
  {
    capabilityId: "provider-proxy-authentication",
    category: "Authentication",
    title: "Provider proxy operation grant",
    description: "Authenticate the workload to an ArkiMux proxy without exposing provider keys.",
    providers: {
      "codex-cli": noProxy,
      "pi-cli": noProxy,
      "claude-code-cli": noProxy,
      "kimi-code-cli": unsupported("Kimi is not in the planned first proxy boundary.", ["APC-GAP-010"]),
    },
  },
  {
    capabilityId: "environment-isolation",
    category: "Execution",
    title: "Allowlisted child environment",
    description: "Start the runner with allowlisted host values plus only the selected authentication environment.",
    providers: {
      "codex-cli": supported("Unrelated host variables are excluded.", ["APC-E001", "APC-E018"]),
      "pi-cli": supported("Unrelated host variables are excluded.", ["APC-E004", "APC-E018"]),
      "claude-code-cli": supported("Uses the shared allowlisted environment path.", ["APC-E007", "APC-E011", "APC-E018"]),
      "kimi-code-cli": experimental("Uses the shared allowlisted environment path.", ["APC-E009", "APC-E011", "APC-E018"]),
    },
  },
  {
    capabilityId: "ephemeral-session",
    category: "Execution",
    title: "Ephemeral invocation session",
    description: "Avoid resuming or persisting an agent conversation between invocations.",
    providers: {
      "codex-cli": supported("Uses --ephemeral and removes its temporary child home.", ["APC-E001"]),
      "pi-cli": supported("Uses --no-session and removes its temporary agent directory.", ["APC-E004"]),
      "claude-code-cli": supported("Uses --no-session-persistence.", ["APC-E007"]),
      "kimi-code-cli": experimental("One-shot execution exists, but no no-session flag is enforced.", ["APC-E009", "APC-E010"], ["APC-GAP-016"]),
    },
  },
  {
    capabilityId: "timeout-termination",
    category: "Execution",
    title: "Timeout termination",
    description: "Terminate an invocation after its configured timeout.",
    providers: {
      "codex-cli": supported("Sends SIGTERM, then SIGKILL after two seconds.", ["APC-E019"]),
      "pi-cli": supported("Sends SIGTERM, then SIGKILL after two seconds.", ["APC-E019"]),
      "claude-code-cli": supported("Uses the shared streaming-process timeout.", ["APC-E019"]),
      "kimi-code-cli": experimental("Uses the shared streaming-process timeout.", ["APC-E019"]),
    },
  },
  {
    capabilityId: "external-cancellation",
    category: "Execution",
    title: "External cancellation",
    description: "Stop a running provider call from an API or workflow cancellation signal.",
    providers: {
      "codex-cli": noCancellation,
      "pi-cli": noCancellation,
      "claude-code-cli": noCancellation,
      "kimi-code-cli": noCancellation,
    },
  },
  {
    capabilityId: "automatic-retry",
    category: "Execution",
    title: "Automatic retry",
    description: "Retry failed agent execution under a declared policy.",
    providers: {
      "codex-cli": noRetry,
      "pi-cli": noRetry,
      "claude-code-cli": noRetry,
      "kimi-code-cli": noRetry,
    },
  },
  {
    capabilityId: "provider-idempotency",
    category: "Execution",
    title: "Provider request idempotency",
    description: "Prevent duplicate paid provider work across retries or infrastructure redelivery.",
    providers: {
      "codex-cli": noIdempotency,
      "pi-cli": noIdempotency,
      "claude-code-cli": noIdempotency,
      "kimi-code-cli": noIdempotency,
    },
  },
  {
    capabilityId: "host-controlled-scratch",
    category: "Execution",
    title: "Host-controlled scratch",
    description: "Receive bounded writable paths from the execution host instead of choosing temporary roots.",
    providers: {
      "codex-cli": noHostScratch,
      "pi-cli": noHostScratch,
      "claude-code-cli": noHostScratch,
      "kimi-code-cli": noHostScratch,
    },
  },
  {
    capabilityId: "final-text-result",
    category: "Output",
    title: "Provider-neutral final text",
    description: "Return one final assistant text value through AgentExecutionResult.output.",
    providers: {
      "codex-cli": supported("Reads Codex --output-last-message, with stdout fallback.", ["APC-E001", "APC-E018"]),
      "pi-cli": supported("Requires exactly one successful final assistant message.", ["APC-E004", "APC-E018"]),
      "claude-code-cli": supported("Projects the result event into the last-message artifact.", ["APC-E007", "APC-E018"]),
      "kimi-code-cli": experimental("Projects the final non-tool assistant message.", ["APC-E009", "APC-E018"]),
    },
  },
  {
    capabilityId: "native-event-artifact",
    category: "Output",
    title: "Native event-stream artifact",
    description: "Append exact native stdout to a provider-specific JSONL artifact.",
    providers: {
      "codex-cli": supported("Captures Codex JSONL stdout.", ["APC-E001", "APC-E018"]),
      "pi-cli": supported("Captures Pi JSONL stdout.", ["APC-E004", "APC-E018"]),
      "claude-code-cli": supported("Captures Claude streaming JSON stdout.", ["APC-E007", "APC-E018"]),
      "kimi-code-cli": experimental("Captures Kimi streaming JSON stdout.", ["APC-E009", "APC-E018"]),
    },
  },
  {
    capabilityId: "caller-response-streaming",
    category: "Output",
    title: "Caller-facing response streaming",
    description: "Expose normalized text or tool deltas before the invocation ends.",
    providers: {
      "codex-cli": noStreaming,
      "pi-cli": noStreaming,
      "claude-code-cli": noStreaming,
      "kimi-code-cli": noStreaming,
    },
  },
  {
    capabilityId: "provider-native-structured-output",
    category: "Output",
    title: "Provider-native structured output",
    description: "Send a response schema and receive a schema-constrained result.",
    providers: {
      "codex-cli": noNativeSchema,
      "pi-cli": noNativeSchema,
      "claude-code-cli": noNativeSchema,
      "kimi-code-cli": noNativeSchema,
    },
  },
  {
    capabilityId: "normalized-lifecycle-events",
    category: "Output",
    title: "Normalized lifecycle events",
    description: "Emit provider-neutral started, completed, failed, and timed-out events.",
    providers: {
      "codex-cli": partial("Execution events exist; declared preflight event has no producer.", ["APC-E017"], ["APC-GAP-014"]),
      "pi-cli": partial("Execution events exist; declared preflight event has no producer.", ["APC-E017"], ["APC-GAP-014"]),
      "claude-code-cli": partial("Execution events exist; declared preflight event has no producer.", ["APC-E017"], ["APC-GAP-014"]),
      "kimi-code-cli": experimental("Experimental execution uses the shared lifecycle event contract.", ["APC-E017"], ["APC-GAP-014"]),
    },
  },
  {
    capabilityId: "native-tools",
    category: "Tools",
    title: "Runner-native tools",
    description: "Allow the selected CLI to execute its own tools during one invocation.",
    providers: {
      "codex-cli": partial("Native command execution remains available, but apps and plugins are disabled and tools are not portable.", ["APC-E002"], ["APC-GAP-006", "APC-GAP-017"]),
      "pi-cli": notApplicable("All Pi built-in tools are deliberately disabled."),
      "claude-code-cli": partial("Native tool use is controlled only through permission mode and is not portable.", ["APC-E007"], ["APC-GAP-006", "APC-GAP-007"]),
      "kimi-code-cli": experimental("Native tool calls are observed but remain outside the public promise.", ["APC-E009"], ["APC-GAP-006", "APC-GAP-007"]),
    },
  },
  {
    capabilityId: "guarded-repository-tools",
    category: "Tools",
    title: "Guarded read-only repository tools",
    description: "List, search, read, and batch-read an immutable repository snapshot with limits and audit.",
    providers: {
      "codex-cli": notApplicable("Codex does not use the Pi extension contract."),
      "pi-cli": supported("Optional runner-owned extension exposes four guarded tools.", ["APC-E005", "APC-E006"]),
      "claude-code-cli": notApplicable("Claude does not use the Pi extension contract."),
      "kimi-code-cli": notApplicable("Kimi does not use the Pi extension contract."),
    },
  },
  {
    capabilityId: "portable-custom-tools",
    category: "Tools",
    title: "Portable custom tools",
    description: "Declare one tool schema and implementation once for every product provider.",
    providers: {
      "codex-cli": noPortableTools,
      "pi-cli": noPortableTools,
      "claude-code-cli": noPortableTools,
      "kimi-code-cli": noPortableTools,
    },
  },
  {
    capabilityId: "basic-execution-metrics",
    category: "Metrics",
    title: "Basic execution metrics",
    description: "Record provider, model, effort, status, duration, label, attempt, and artifacts.",
    providers: {
      "codex-cli": supported("Produces the shared metric envelope.", ["APC-E001", "APC-E017", "APC-E018", "APC-E019"]),
      "pi-cli": supported("Produces the shared metric envelope.", ["APC-E004", "APC-E017", "APC-E018", "APC-E019"]),
      "claude-code-cli": partial("Produces the envelope, but native-tool-call currently fails shared validation.", ["APC-E007", "APC-E017", "APC-E018", "APC-E019"], ["APC-GAP-007"]),
      "kimi-code-cli": experimental("Produces the envelope, but native-tool-call currently fails shared validation.", ["APC-E009", "APC-E017", "APC-E018", "APC-E019"], ["APC-GAP-007"]),
    },
  },
  {
    capabilityId: "token-usage",
    category: "Metrics",
    title: "Input, cached, and output tokens",
    description: "Project comparable token counts when the native stream supplies them.",
    providers: {
      "codex-cli": supported("Projects input, cached input, and output tokens.", ["APC-E002", "APC-E018"]),
      "pi-cli": supported("Aggregates input, cache read, and output across assistant messages.", ["APC-E004", "APC-E018"]),
      "claude-code-cli": supported("Projects input, cache-read input, and output tokens.", ["APC-E007", "APC-E018"]),
      "kimi-code-cli": experimental("Projects available input, cached input, and output tokens.", ["APC-E009", "APC-E018"]),
    },
  },
  {
    capabilityId: "reasoning-token-usage",
    category: "Metrics",
    title: "Reasoning-token usage",
    description: "Project reasoning output tokens independently from normal output.",
    providers: {
      "codex-cli": supported("Reads reasoning_output_tokens.", ["APC-E002"]),
      "pi-cli": supported("Aggregates Pi reasoning usage.", ["APC-E004"]),
      "claude-code-cli": unsupported("Current Claude parser does not project reasoning tokens.", ["APC-GAP-017"]),
      "kimi-code-cli": unsupported("Current Kimi parser does not project reasoning tokens.", ["APC-GAP-017"]),
    },
  },
  {
    capabilityId: "estimated-cost",
    category: "Metrics",
    title: "Provider-estimated cost",
    description: "Project an estimated USD cost when supplied by the native runtime.",
    providers: {
      "codex-cli": unsupported("Current Codex event projection has no cost field.", ["APC-GAP-017"]),
      "pi-cli": supported("Aggregates native usage cost totals.", ["APC-E004"]),
      "claude-code-cli": supported("Projects total_cost_usd.", ["APC-E007"]),
      "kimi-code-cli": unsupported("Current Kimi parser has no cost projection.", ["APC-GAP-017"]),
    },
  },
  {
    capabilityId: "tool-call-metrics",
    category: "Metrics",
    title: "Tool-call metrics",
    description: "Count tool activity and selected repository operations.",
    providers: {
      "codex-cli": partial("Counts command_execution items and infers search or read operations from command text.", ["APC-E002"], ["APC-GAP-017"]),
      "pi-cli": supported("Uses exact guarded repository audit metrics when the extension is installed.", ["APC-E005", "APC-E006"]),
      "claude-code-cli": partial("Counts native tool_use blocks, but shared validation rejects its unit.", ["APC-E007"], ["APC-GAP-007", "APC-GAP-017"]),
      "kimi-code-cli": experimental("Counts native tool_calls, but shared validation rejects its unit.", ["APC-E009"], ["APC-GAP-007", "APC-GAP-017"]),
    },
  },
  {
    capabilityId: "detailed-provider-metrics",
    category: "Metrics",
    title: "Detailed provider diagnostics",
    description: "Expose request ID, stop reason, time to first token, generation time, and rate-limit data.",
    providers: {
      "codex-cli": unsupported("Not present in the common metric contract.", ["APC-GAP-017"]),
      "pi-cli": unsupported("Not present in the common metric contract.", ["APC-GAP-017"]),
      "claude-code-cli": unsupported("Not present in the common metric contract.", ["APC-GAP-017"]),
      "kimi-code-cli": unsupported("Not present in the common metric contract.", ["APC-GAP-017"]),
    },
  },
  {
    capabilityId: "standard-artifacts",
    category: "Artifacts",
    title: "Standard local artifacts",
    description: "Materialize native events, stderr, final message, and heartbeat under stable artifact roles.",
    providers: {
      "codex-cli": supported("Produces all four standard local files.", ["APC-E001", "APC-E018", "APC-E019"]),
      "pi-cli": supported("Produces all four standard local files.", ["APC-E004", "APC-E018", "APC-E019"]),
      "claude-code-cli": supported("Produces all four standard local files.", ["APC-E007", "APC-E018", "APC-E019"]),
      "kimi-code-cli": experimental("Produces all four standard local files.", ["APC-E009", "APC-E018", "APC-E019"]),
    },
  },
  {
    capabilityId: "repository-tool-audit",
    category: "Artifacts",
    title: "Repository-tool audit artifact",
    description: "Retain paths, result sizes, rejection reasons, and duration for guarded repository operations.",
    providers: {
      "codex-cli": notApplicable("No runner-owned guarded repository tool adapter."),
      "pi-cli": supported("Produced when the guarded repository extension is installed.", ["APC-E005", "APC-E006"]),
      "claude-code-cli": notApplicable("No runner-owned guarded repository tool adapter."),
      "kimi-code-cli": notApplicable("No runner-owned guarded repository tool adapter."),
    },
  },
  {
    capabilityId: "retained-output-redaction",
    category: "Artifacts",
    title: "Retained-output secret redaction",
    description: "Redact known credentials from native events, stderr, and final output before retention.",
    providers: {
      "codex-cli": noRedaction,
      "pi-cli": noRedaction,
      "claude-code-cli": noRedaction,
      "kimi-code-cli": noRedaction,
    },
  },
  {
    capabilityId: "readiness-status",
    category: "Errors",
    title: "Typed readiness status",
    description: "Return ready, unavailable, or indeterminate authentication readiness with safe remediation.",
    providers: {
      "codex-cli": supported("Reports native login method and actionable remediation.", ["APC-E003", "APC-E014"]),
      "pi-cli": supported("Reports runtime and selected authentication availability.", ["APC-E004", "APC-E014"]),
      "claude-code-cli": supported("Reports account and plan metadata when exposed by Claude.", ["APC-E008", "APC-E014"]),
      "kimi-code-cli": experimental("Reports experimental Kimi session availability.", ["APC-E010", "APC-E014"]),
    },
  },
  {
    capabilityId: "execution-errors-with-metrics",
    category: "Errors",
    title: "Execution failures with metrics",
    description: "Attach status, duration, artifacts, and observed usage to handled runner failures.",
    providers: {
      "codex-cli": supported("Uses CodexCliAgentRunError.", ["APC-E003", "APC-E019"]),
      "pi-cli": supported("Uses PiCliAgentRunError for exit and output-contract failures.", ["APC-E004", "APC-E019"]),
      "claude-code-cli": partial("Uses ClaudeCodeCliAgentRunError, subject to the native-tool metric validation gap.", ["APC-E008", "APC-E019"], ["APC-GAP-007"]),
      "kimi-code-cli": experimental("Uses KimiCodeCliAgentRunError outside the public promise.", ["APC-E009", "APC-E019"], ["APC-GAP-007"]),
    },
  },
  {
    capabilityId: "normalized-provider-errors",
    category: "Errors",
    title: "Normalized provider errors",
    description: "Map provider-native failures to safe, actionable, provider-neutral categories.",
    providers: {
      "codex-cli": partial("Preserves selected provider explanations and keeps credential redaction separate; a shared error taxonomy is not claimed.", ["APC-E003"], ["APC-GAP-011"]),
      "pi-cli": unsupported("Preserves selected provider explanations; no shared provider-neutral error taxonomy.", ["APC-GAP-011"]),
      "claude-code-cli": partial("Preserves the native-session failure explanation without guessing plan eligibility; no shared error taxonomy.", ["APC-E008"], ["APC-GAP-011"]),
      "kimi-code-cli": unsupported("Preserves selected provider explanations; no shared provider-neutral error taxonomy.", ["APC-GAP-011"]),
    },
  },
  {
    capabilityId: "common-error-codes",
    category: "Errors",
    title: "Common execution error codes",
    description: "Return one machine-readable error taxonomy across every runner.",
    providers: {
      "codex-cli": noErrorCodes,
      "pi-cli": noErrorCodes,
      "claude-code-cli": noErrorCodes,
      "kimi-code-cli": noErrorCodes,
    },
  },
  {
    capabilityId: "secret-free-run-configuration",
    category: "Security",
    title: "Secret-free run configuration",
    description: "Reject secret-like parameter keys and keep credential values outside persisted run policy.",
    providers: {
      "codex-cli": supported("Credential references remain separate from parameters.", ["APC-E013", "APC-E016"]),
      "pi-cli": supported("Credential references remain separate from parameters.", ["APC-E013", "APC-E016"]),
      "claude-code-cli": supported("Credential references remain separate from parameters.", ["APC-E013", "APC-E016"]),
      "kimi-code-cli": experimental("Uses the shared secret-free configuration contract.", ["APC-E013", "APC-E016"]),
    },
  },
] as const satisfies readonly ProviderCapabilityDefinition[];

export const providerExecutionCombinations = [
  {
    combinationId: "codex-openai-native-session",
    productStatus: "candidate",
    executionProviderId: "codex-cli",
    modelProvider: "openai",
    authenticationKind: "runtime-native",
    authenticationReferenceKind: "current-auth-provider-id",
    authenticationReference: "codex-native-session",
    supportStatus: "supported",
    journey: "Local V2",
    notes: "Uses the logged-in Codex CLI session. Readiness can remain indeterminate until execution confirms model and quota eligibility.",
    evidenceIds: ["APC-E003", "APC-E014"],
    trackingIds: ["APC-GAP-001"],
  },
  {
    combinationId: "codex-openai-api-key",
    productStatus: "candidate",
    executionProviderId: "codex-cli",
    modelProvider: "openai",
    authenticationKind: "stored-credential",
    authenticationReferenceKind: "auth-provider-preset-id",
    authenticationReference: "codex-openai-api-key",
    supportStatus: "supported",
    journey: "Local V2 optional; Managed V1; Managed V2 gate",
    notes: "Managed V1 reference combination and one row of the Managed V2 portability gate. The key is resolved at invocation and injected as OPENAI_API_KEY.",
    evidenceIds: ["APC-E001", "APC-E013"],
    trackingIds: ["APC-GAP-001"],
  },
  {
    combinationId: "pi-openai-codex-native-session",
    productStatus: "candidate",
    executionProviderId: "pi-cli",
    modelProvider: "openai-codex",
    authenticationKind: "runtime-native",
    authenticationReferenceKind: "current-auth-provider-id",
    authenticationReference: "pi-openai-codex-session",
    supportStatus: "supported",
    journey: "Local V2",
    notes: "Uses the Pi runtime with its OpenAI Codex session and installed model catalog.",
    evidenceIds: ["APC-E004", "APC-E014"],
    trackingIds: ["APC-GAP-001"],
  },
  {
    combinationId: "pi-openai-api-key",
    productStatus: "candidate",
    executionProviderId: "pi-cli",
    modelProvider: "openai",
    authenticationKind: "stored-credential",
    authenticationReferenceKind: "auth-provider-preset-id",
    authenticationReference: "pi-openai-api-key",
    supportStatus: "supported",
    journey: "Local V2 optional; Managed V2 gate",
    notes: "Uses Pi's OpenAI protocol and the installed text-model catalog.",
    evidenceIds: ["APC-E004", "APC-E013"],
    trackingIds: ["APC-GAP-001"],
  },
  {
    combinationId: "pi-anthropic-api-key",
    productStatus: "candidate",
    executionProviderId: "pi-cli",
    modelProvider: "anthropic",
    authenticationKind: "stored-credential",
    authenticationReferenceKind: "auth-provider-preset-id",
    authenticationReference: "pi-anthropic-api-key",
    supportStatus: "partial",
    journey: "Local V2 revision 7 required; Managed V2 gate",
    notes: "The configuration and catalog path exist, but current automated runner evidence does not call Anthropic through the real Pi CLI.",
    evidenceIds: ["APC-E004", "APC-E013"],
    trackingIds: ["APC-GAP-001"],
  },
  {
    combinationId: "pi-anthropic-native-session",
    productStatus: "candidate",
    executionProviderId: "pi-cli",
    modelProvider: "anthropic",
    authenticationKind: "runtime-native",
    authenticationReferenceKind: "target-auth-provider-id",
    authenticationReference: "pi-anthropic-session",
    supportStatus: "partial",
    journey: "Historical Local V2 revision 6; not a revision 7 requirement",
    notes: "A native Pi Anthropic request was rejected for third-party extra-usage billing. Revision 7 requires the separate API-key path instead. Existing native records are preserved, not promoted to API-key evidence.",
    evidenceIds: ["APC-E020"],
    trackingIds: ["APC-GAP-001", "APC-GAP-018"],
  },
  {
    combinationId: "claude-anthropic-native-session",
    productStatus: "candidate",
    executionProviderId: "claude-code-cli",
    modelProvider: "anthropic",
    authenticationKind: "runtime-native",
    authenticationReferenceKind: "current-auth-provider-id",
    authenticationReference: "claude-code-native-session",
    supportStatus: "partial",
    journey: "Local V2",
    notes: "Native auth status and failure normalization exist, but there is no real-provider success test in the repository.",
    evidenceIds: ["APC-E008", "APC-E014"],
    trackingIds: ["APC-GAP-001", "APC-GAP-007"],
  },
  {
    combinationId: "claude-anthropic-api-key",
    productStatus: "candidate",
    executionProviderId: "claude-code-cli",
    modelProvider: "anthropic",
    authenticationKind: "stored-credential",
    authenticationReferenceKind: "auth-provider-preset-id",
    authenticationReference: "claude-code-anthropic-api-key",
    supportStatus: "partial",
    journey: "Local V2 optional; Managed V2 gate",
    notes: "Key injection and stream parsing have fake-adapter evidence. Shared native-tool metrics validation and live evidence remain open.",
    evidenceIds: ["APC-E007", "APC-E013"],
    trackingIds: ["APC-GAP-001", "APC-GAP-007"],
  },
  {
    combinationId: "pi-command-credential",
    productStatus: "candidate",
    executionProviderId: "pi-cli",
    modelProvider: "configured",
    authenticationKind: "command",
    authenticationReferenceKind: "configured-auth-provider-id",
    authenticationReference: "user-defined",
    supportStatus: "partial",
    journey: "Prospect only",
    notes: "The core registry can run a fixed helper, but the portal does not create this binding and no live provider combination is certified.",
    evidenceIds: ["APC-E012"],
    trackingIds: ["APC-GAP-001", "APC-GAP-015"],
  },
  {
    combinationId: "pi-kimi-platform-api-key",
    productStatus: "experimental",
    executionProviderId: "pi-cli",
    modelProvider: "moonshotai",
    authenticationKind: "stored-credential",
    authenticationReferenceKind: "auth-provider-preset-id",
    authenticationReference: "pi-kimi-platform-api-key",
    supportStatus: "experimental",
    journey: "Prospect only",
    notes: "Implementation hooks and presets exist, but Kimi-related portability was removed from known journeys.",
    evidenceIds: ["APC-E004", "APC-E013"],
    trackingIds: ["APC-GAP-001", "APC-GAP-008"],
  },
  {
    combinationId: "kimi-native-session",
    productStatus: "experimental",
    executionProviderId: "kimi-code-cli",
    modelProvider: "kimi",
    authenticationKind: "runtime-native",
    authenticationReferenceKind: "current-auth-provider-id",
    authenticationReference: "kimi-code-native-session",
    supportStatus: "experimental",
    journey: "Prospect only",
    notes: "Adapter groundwork exists, but it is excluded from the public compatibility promise.",
    evidenceIds: ["APC-E009", "APC-E010"],
    trackingIds: ["APC-GAP-008", "APC-GAP-016"],
  },
  {
    combinationId: "kimi-platform-api-key",
    productStatus: "experimental",
    executionProviderId: "kimi-code-cli",
    modelProvider: "kimi",
    authenticationKind: "stored-credential",
    authenticationReferenceKind: "auth-provider-preset-id",
    authenticationReference: "kimi-code-platform-api-key",
    supportStatus: "experimental",
    journey: "Prospect only",
    notes: "The model environment and key path exist only as experimental groundwork.",
    evidenceIds: ["APC-E009", "APC-E013"],
    trackingIds: ["APC-GAP-008"],
  },
] as const satisfies readonly ProviderExecutionCombination[];

const statusLabels: Record<CapabilityStatus, string> = {
  supported: "Supported",
  partial: "Partial",
  unsupported: "Unsupported",
  experimental: "Experimental",
  "not-applicable": "N/A",
};

const providerLabels: Record<ProviderId, string> = {
  "codex-cli": "Codex CLI",
  "pi-cli": "Pi CLI",
  "claude-code-cli": "Claude Code CLI",
  "kimi-code-cli": "Kimi Code CLI",
};

const authenticationReferenceLabels: Record<
  ProviderExecutionCombination["authenticationReferenceKind"],
  string
> = {
  "current-auth-provider-id": "current auth-provider ID",
  "auth-provider-preset-id": "auth-provider preset ID",
  "target-auth-provider-id": "target auth-provider ID",
  "configured-auth-provider-id": "configured auth-provider ID",
};

function markdown(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function references(label: string, values: readonly string[]): string {
  return values.length === 0 ? "" : `${label}: ${values.map((value) => `\`${value}\``).join(", ")}.`;
}

function capabilityCell(value: ProviderCapabilityCell): string {
  return markdown([
    `**${statusLabels[value.status]}** — ${value.note}`,
    references("Evidence", value.evidenceIds),
    references("Tracking", value.trackingIds),
  ].filter(Boolean).join(" "));
}

export function renderProviderCapabilityMatrix(): string {
  const header = `| Capability | ${providerIds.map((providerId) => providerLabels[providerId]).join(" | ")} |`;
  const divider = `| --- | ${providerIds.map(() => "---").join(" | ")} |`;
  const rows = providerCapabilities.map((capability) => (
    `| **${markdown(capability.category)} / ${markdown(capability.title)}**<br>\`${capability.capabilityId}\` | ${providerIds.map((providerId) => capabilityCell(capability.providers[providerId])).join(" | ")} |`
  ));
  return [header, divider, ...rows].join("\n") + "\n";
}

export function renderProviderExecutionCombinationMatrix(): string {
  const rows = providerExecutionCombinations.map((combination) => `| \`${combination.combinationId}\` | ${combination.productStatus} | \`${combination.executionProviderId}\` | ${markdown(combination.modelProvider)} | ${combination.authenticationKind}; ${authenticationReferenceLabels[combination.authenticationReferenceKind]}: \`${combination.authenticationReference}\` | ${statusLabels[combination.supportStatus]} | ${markdown(combination.journey)} | ${markdown(combination.notes)} | ${markdown(references("Evidence", combination.evidenceIds) || "—")} | ${markdown(references("Tracking", combination.trackingIds) || "—")} |`);
  return [
    "| Combination | Product status | Execution provider | Model provider | Authentication target | Wrapper support | Journey | Notes | Evidence | Tracking |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n") + "\n";
}

export function renderProviderEvidenceTable(): string {
  const rows = providerEvidence.map((evidence) => `| \`${evidence.evidenceId}\` | ${evidence.level} | ${evidence.providerIds.map((providerId) => `\`${providerId}\``).join(", ")} | \`${markdown(evidence.sourcePath)}\` | ${markdown(evidence.testName)} | ${markdown(evidence.notes)} |`);
  return [
    "| Evidence ID | Level | Providers | Test file | Test name | What it proves |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n") + "\n";
}

export function renderProviderGapTable(): string {
  const rows = providerGaps.map((gap) => `| \`${gap.trackingId}\` | ${markdown(gap.title)} | ${gap.status} | ${gap.affectedProviderIds.map((providerId) => `\`${providerId}\``).join(", ")} | ${markdown(gap.description)} |`);
  return [
    "| Tracking ID | Gap | Status | Providers | Current meaning |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n") + "\n";
}
