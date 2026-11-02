export interface AgentExecutionParameterOption {
  value: string;
  label: string;
}

export interface AgentExecutionAuthProviderOption extends AgentExecutionParameterOption {
  modelProvider?: string;
}

export type AgentExecutionParameterEditorField =
  | {
      key: string;
      label: string;
      kind: "string";
      required: boolean;
      placeholder?: string;
      defaultValue?: string;
      allowsCustomValue: boolean;
      suggestions?: readonly AgentExecutionParameterOption[];
      conditionalSuggestions?: readonly {
        parameterKey: string;
        parameterValue: string;
        options: readonly AgentExecutionParameterOption[];
      }[];
    }
  | {
      key: string;
      label: string;
      kind: "enum";
      required: boolean;
      options: readonly AgentExecutionParameterOption[];
    };

export interface AgentExecutionProviderEditorDescriptor {
  providerId: string;
  schemaVersion: number;
  /** Connections are the authoritative bindings; default IDs are not implicit options. */
  connectionDriven?: boolean;
  displayName: string;
  defaultAuthProviderId: string;
  authProviderOptions?: readonly AgentExecutionAuthProviderOption[];
  allowsCustomAuthProvider: boolean;
  allowsAdditionalParameters: boolean;
  fields: readonly AgentExecutionParameterEditorField[];
}

const reasoningOptions = ["minimal", "low", "medium", "high", "xhigh", "max"]
  .map((value) => ({ value, label: value }));
const thinkingOptions = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
  .map((value) => ({ value, label: value }));
export interface DefaultAgentExecutionProviderEditorDescriptorOptions {
  piOpenAiCodexModels?: readonly AgentExecutionParameterOption[];
  piModelCatalogs?: Readonly<Record<string, readonly AgentExecutionParameterOption[]>>;
}

export function createDefaultAgentExecutionProviderEditorDescriptors(
  options: DefaultAgentExecutionProviderEditorDescriptorOptions = {},
): readonly AgentExecutionProviderEditorDescriptor[] {
  const piModelCatalogs: Readonly<Record<string, readonly AgentExecutionParameterOption[]>> = {
    ...(options.piOpenAiCodexModels ? { "openai-codex": options.piOpenAiCodexModels } : {}),
    ...options.piModelCatalogs,
  };
  const piModelProviders = Object.keys(piModelCatalogs).sort();
  return [
  {
    providerId: "codex-cli",
    schemaVersion: 1,
    displayName: "Codex CLI",
    defaultAuthProviderId: "codex-native-session",
    authProviderOptions: [{ value: "codex-native-session", label: "Codex native session" }],
    allowsCustomAuthProvider: false,
    allowsAdditionalParameters: true,
    fields: [
      {
        key: "model",
        label: "Model",
        kind: "string",
        required: true,
        allowsCustomValue: true,
        placeholder: "gpt-5.6-luna",
        suggestions: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"]
          .map((value) => ({ value, label: value })),
      },
      {
        key: "model_reasoning_effort",
        label: "Reasoning effort",
        kind: "enum",
        required: false,
        options: reasoningOptions,
      },
    ],
  },
  {
    providerId: "pi-cli",
    schemaVersion: 1,
    displayName: "Pi CLI",
    defaultAuthProviderId: "pi-openai-codex-session",
    authProviderOptions: [{
      value: "pi-openai-codex-session",
      label: "Pi OpenAI Codex session",
      modelProvider: "openai-codex",
    }],
    allowsCustomAuthProvider: false,
    allowsAdditionalParameters: false,
    fields: [
      {
        key: "provider",
        label: "Model provider",
        kind: "string",
        required: true,
        placeholder: "openai-codex",
        defaultValue: "openai-codex",
        allowsCustomValue: false,
        suggestions: [...new Set(["openai-codex", ...piModelProviders])]
          .map((value) => ({ value, label: modelProviderLabel(value) })),
      },
      {
        key: "model",
        label: "Model",
        kind: "string",
        required: true,
        allowsCustomValue: false,
        placeholder: "gpt-5.6-luna",
        ...(piModelProviders.length > 0 ? {
          conditionalSuggestions: piModelProviders
            .filter((provider) => (piModelCatalogs[provider]?.length ?? 0) > 0)
            .map((provider) => ({
              parameterKey: "provider",
              parameterValue: provider,
              options: piModelCatalogs[provider]!,
            })),
        } : {}),
      },
      { key: "thinking", label: "Thinking", kind: "enum", required: false, options: thinkingOptions },
    ],
  },
  {
    providerId: "claude-code-cli",
    schemaVersion: 1,
    displayName: "Claude Code CLI",
    defaultAuthProviderId: "claude-code-native-session",
    authProviderOptions: [{ value: "claude-code-native-session", label: "Claude Code native session", modelProvider: "anthropic" }],
    allowsCustomAuthProvider: false,
    allowsAdditionalParameters: true,
    fields: [
      {
        key: "model",
        label: "Model",
        kind: "string",
        required: true,
        defaultValue: "sonnet",
        placeholder: "sonnet",
        allowsCustomValue: true,
        suggestions: ["sonnet", "opus", "haiku"].map((value) => ({ value, label: value })),
      },
      { key: "effort", label: "Effort", kind: "enum", required: false, options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })) },
      { key: "permission-mode", label: "Permission mode", kind: "enum", required: false, options: ["default", "acceptEdits", "plan", "auto", "manual", "dontAsk", "bypassPermissions"].map((value) => ({ value, label: value })) },
    ],
  },
  {
    providerId: "kimi-code-cli",
    schemaVersion: 1,
    displayName: "Kimi Code CLI",
    defaultAuthProviderId: "kimi-code-native-session",
    authProviderOptions: [{ value: "kimi-code-native-session", label: "Kimi Code native session", modelProvider: "kimi" }],
    allowsCustomAuthProvider: false,
    allowsAdditionalParameters: true,
    fields: [
      {
        key: "model",
        label: "Model",
        kind: "string",
        required: true,
        defaultValue: "kimi-k2.5",
        placeholder: "kimi-k2.5",
        allowsCustomValue: true,
        suggestions: [{ value: "kimi-k2.5", label: "Kimi K2.5" }],
      },
      { key: "provider-type", label: "Provider type", kind: "enum", required: false, options: ["kimi", "anthropic", "openai"].map((value) => ({ value, label: value })) },
      { key: "thinking-effort", label: "Thinking effort", kind: "enum", required: false, options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })) },
    ],
  },
  ];
}

export const defaultAgentExecutionProviderEditorDescriptors =
  createDefaultAgentExecutionProviderEditorDescriptors();

export function validateAgentRunPolicyProviderSchema(
  policy: {
    execution: {
      provider: string;
      authProvider: string;
      parameters: Record<string, unknown>;
    };
  },
  providers: readonly AgentExecutionProviderEditorDescriptor[],
  location = "Agent policy",
): void {
  const provider = providers.find(({ providerId }) => providerId === policy.execution.provider);
  if (!provider) {
    throw new Error(`${location} execution provider ${policy.execution.provider} is not installed.`);
  }

  if (!provider.allowsCustomAuthProvider) {
    const allowed = new Set([
      ...(provider.connectionDriven ? [] : [provider.defaultAuthProviderId]),
      ...(provider.authProviderOptions ?? []).map(({ value }) => value),
    ]);
    if (!allowed.has(policy.execution.authProvider)) {
      throw new Error(
        `${location} authentication provider ${policy.execution.authProvider} is not supported by ${provider.providerId}.`,
      );
    }
  }

  const authProvider = provider.authProviderOptions
    ?.find(({ value }) => value === policy.execution.authProvider);
  if (authProvider?.modelProvider !== undefined
    && executionModelProvider(policy.execution.provider, policy.execution.parameters) !== authProvider.modelProvider) {
    throw new Error(
      `${location} authentication provider ${policy.execution.authProvider} requires model provider ${authProvider.modelProvider}.`,
    );
  }

  const parameters = policy.execution.parameters;
  const known = new Set(provider.fields.map(({ key }) => key));
  const unknown = Object.keys(parameters).filter((key) => !known.has(key));
  if (!provider.allowsAdditionalParameters && unknown.length > 0) {
    throw new Error(`${location} contains unsupported provider parameters [${unknown.join(", ")}].`);
  }

  for (const field of provider.fields) {
    const candidate = parameters[field.key];
    if (field.required && (typeof candidate !== "string" || candidate.trim().length === 0)) {
      throw new Error(`${location} provider parameter ${field.key} is required.`);
    }
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") {
      throw new Error(`${location} provider parameter ${field.key} must be a string.`);
    }
    if (field.kind === "enum") {
      if (!field.options.some(({ value }) => value === candidate)) {
        throw new Error(`${location} provider parameter ${field.key} has unsupported value ${candidate}.`);
      }
      continue;
    }
    if (field.allowsCustomValue) continue;
    const declaredOptions = [
      ...(field.suggestions ?? []),
      ...(field.conditionalSuggestions ?? [])
        .filter(({ parameterKey, parameterValue }) => parameters[parameterKey] === parameterValue)
        .flatMap(({ options }) => options),
    ];
    if (declaredOptions.length === 0) {
      throw new Error(`${location} provider parameter catalog ${field.key} is unavailable for ${provider.providerId}.`);
    }
    if (!declaredOptions.some(({ value }) => value === candidate)) {
      throw new Error(`${location} provider parameter ${field.key} has unsupported value ${candidate}.`);
    }
  }
}

function executionModelProvider(providerId: string, parameters: Record<string, unknown>): string | undefined {
  if (providerId === "pi-cli") return typeof parameters.provider === "string" ? parameters.provider : undefined;
  if (providerId === "claude-code-cli") return "anthropic";
  if (providerId === "kimi-code-cli") return typeof parameters["provider-type"] === "string" ? parameters["provider-type"] as string : "kimi";
  if (providerId === "codex-cli") return "openai";
  return undefined;
}

function modelProviderLabel(value: string): string {
  if (value === "openai-codex") return "OpenAI Codex";
  if (value === "openai") return "OpenAI";
  if (value === "moonshotai") return "Kimi Platform (Moonshot AI)";
  if (value === "kimi-coding") return "Kimi Coding";
  return value;
}
