import {
  ApplicationBoundaryError,
  requireApplicationPermission,
  type AuthorizedApplicationPrincipal,
} from "@com-pyvue/agent-execution-application-host";
import {
  agentAuthenticationMetadataResponseSchema,
  agentAuthProviderListQuerySchema,
  agentAuthProviderListResponseSchema,
  agentAuthProviderPreflightResponseSchema,
  agentAuthProviderProbeResponseSchema,
  agentAuthProviderResponseSchema,
  agentCredentialListQuerySchema,
  agentCredentialListResponseSchema,
  agentCredentialResponseSchema,
  createAgentAuthProviderRequestSchema,
  createAgentCredentialRequestSchema,
  replaceAgentCredentialRequestSchema,
  type AgentAuthenticationMetadataResponseDto,
  type AgentAuthProviderListQueryDto,
  type AgentAuthProviderListResponseDto,
  type AgentAuthProviderPreflightResponseDto,
  type AgentAuthProviderProbeResponseDto,
  type AgentAuthProviderResponseDto,
  type AgentCredentialListQueryDto,
  type AgentCredentialListResponseDto,
  type AgentCredentialResponseDto,
  type CreateAgentAuthProviderRequestDto,
  type CreateAgentCredentialRequestDto,
  type ReplaceAgentCredentialRequestDto,
} from "@com-pyvue/agent-execution-agent-authentication-contract";
import {
  AgentAuthProviderDefinitionConflictError,
  AgentCredentialDefinitionConflictError,
  validateAgentAuthProviderDefinition,
  validateAgentCredentialDefinition,
  type AgentAuthProviderDefinition,
  type AgentAuthConnectionProbe,
  type AgentAuthConnectionTarget,
  type AgentAuthProviderStore,
  type AgentCredentialStore,
  type ResolvedAgentAuthProviderDefinition,
  type ResolvedAgentCredentialDefinition,
  type ResolvedAgentProviderConfig,
} from "@com-pyvue/agent-execution-core";
import { nativeConnectionPresets } from "@com-pyvue/agent-execution-core/internal/application/nativeConnectionCatalog.ts";
import { nativeConnectionSetupEvidence } from "@com-pyvue/agent-execution-core/internal/application/nativeConnectionSetupEvidence.ts";
import { admittedLocalApiKeyPresets } from "@com-pyvue/agent-execution-core/internal/application/localApiKeyConnectionCatalog.ts";

const authProviderPresets = [
  { presetId: "codex-openai-api-key", label: "Codex CLI with OpenAI API key", executionProviderId: "codex-cli" as const, modelProvider: "openai", targetVariable: "OPENAI_API_KEY" },
  { presetId: "pi-openai-api-key", label: "Pi CLI with OpenAI API key", executionProviderId: "pi-cli" as const, modelProvider: "openai", targetVariable: "OPENAI_API_KEY" },
  { presetId: "pi-anthropic-api-key", label: "Pi CLI with Anthropic API key", executionProviderId: "pi-cli" as const, modelProvider: "anthropic", targetVariable: "ANTHROPIC_API_KEY" },
  { presetId: "pi-kimi-platform-api-key", label: "Pi CLI with Kimi Platform API key", executionProviderId: "pi-cli" as const, modelProvider: "moonshotai", targetVariable: "MOONSHOT_API_KEY" },
  { presetId: "pi-kimi-coding-api-key", label: "Pi CLI with Kimi Coding API key", executionProviderId: "pi-cli" as const, modelProvider: "kimi-coding", targetVariable: "KIMI_API_KEY" },
  { presetId: "claude-code-anthropic-api-key", label: "Claude Code with Anthropic API key", executionProviderId: "claude-code-cli" as const, modelProvider: "anthropic", targetVariable: "ANTHROPIC_API_KEY" },
  { presetId: "kimi-code-platform-api-key", label: "Kimi Code with Kimi Platform API key", executionProviderId: "kimi-code-cli" as const, modelProvider: "kimi", targetVariable: "KIMI_MODEL_API_KEY" },
] as const;

const credentialPresets = [
  { presetId: "openai-api-key", label: "OpenAI API key", modelProvider: "openai" },
  { presetId: "anthropic-api-key", label: "Anthropic API key", modelProvider: "anthropic" },
  { presetId: "moonshot-platform-api-key", label: "Kimi Platform API key", modelProvider: "moonshotai" },
  { presetId: "kimi-coding-api-key", label: "Kimi Coding API key", modelProvider: "kimi-coding" },
  { presetId: "kimi-code-api-key", label: "Kimi Code API key", modelProvider: "kimi" },
] as const;

export class AgentAuthenticationApplicationService {
  constructor(
    private readonly providers: AgentAuthProviderStore,
    private readonly credentials: AgentCredentialStore,
    private readonly options: {
      providerConfig?: ResolvedAgentProviderConfig;
      connectionProbe?: AgentAuthConnectionProbe;
      nativeSessionsOnly?: boolean;
      localV2Connections?: boolean;
      nativeSetupEvidence?: readonly { presetId: string; requiredVersion: string }[];
    } = {},
  ) {}

  metadata(principal: AuthorizedApplicationPrincipal): AgentAuthenticationMetadataResponseDto {
    requirePermission(principal);
    return agentAuthenticationMetadataResponseSchema.parse({
      authProviderPresets: this.apiKeyPresets(),
      credentialPresets: this.restrictedCatalog() ? credentialPresets.filter(credential => this.apiKeyPresets().some(preset => preset.modelProvider === credential.modelProvider)) : credentialPresets,
      nativeSessionPresets: this.nativePresets(),
    });
  }

  async createCredential(principal: AuthorizedApplicationPrincipal, input: CreateAgentCredentialRequestDto): Promise<AgentCredentialResponseDto> {
    requirePermission(principal);
    const request = createAgentCredentialRequestSchema.parse(input);
    const definition = validateAgentCredentialDefinition(request.definition);
    if (this.options.localV2Connections && !this.apiKeyPresets().some(preset => preset.modelProvider === definition.modelProvider)) {
      throw new ApplicationBoundaryError("invalid-request", 400, "Choose a Credential type from this host's pinned setup catalog.");
    }
    if (await this.credentials.getDefinition(definition.credentialId)) {
      throw new ApplicationBoundaryError("conflict", 409, `Credential ${definition.credentialId} already exists.`);
    }
    try {
      await this.credentials.create(definition, request.credential);
    } catch (error) {
      if (error instanceof AgentCredentialDefinitionConflictError) {
        throw new ApplicationBoundaryError("conflict", 409, error.message);
      }
      throw error;
    }
    return agentCredentialResponseSchema.parse({ credential: await this.requiredCredential(definition.credentialId) });
  }

  async replaceCredential(principal: AuthorizedApplicationPrincipal, credentialId: string, input: ReplaceAgentCredentialRequestDto): Promise<AgentCredentialResponseDto> {
    requirePermission(principal);
    const request = replaceAgentCredentialRequestSchema.parse(input);
    await this.requiredCredential(credentialId);
    await this.credentials.putValue(credentialId, request.credential);
    return agentCredentialResponseSchema.parse({ credential: await this.requiredCredential(credentialId) });
  }

  async listCredentials(principal: AuthorizedApplicationPrincipal, input: AgentCredentialListQueryDto): Promise<AgentCredentialListResponseDto> {
    requirePermission(principal);
    const page = await this.credentials.list(agentCredentialListQuerySchema.parse(input));
    return agentCredentialListResponseSchema.parse({
      items: page.items,
      pagination: page.nextCursor ? { nextCursor: page.nextCursor } : {},
    });
  }

  async archiveCredential(principal: AuthorizedApplicationPrincipal, credentialId: string): Promise<AgentCredentialResponseDto> {
    requirePermission(principal);
    await this.requiredCredential(credentialId);
    const references = (await this.providers.list({ lifecycleStatus: "active", pageSize: 500 })).items
      .filter(({ definition }) => definition.kind === "stored-credential" && definition.credentialId === credentialId);
    if (references.length > 0) {
      throw new ApplicationBoundaryError("conflict", 409, `Credential ${credentialId} is used by active authentication configurations [${references.map(({ definition }) => definition.authProviderId).join(", ")}].`);
    }
    await this.credentials.setLifecycleStatus(credentialId, "archived");
    return agentCredentialResponseSchema.parse({ credential: await this.requiredCredential(credentialId) });
  }

  async restoreCredential(principal: AuthorizedApplicationPrincipal, credentialId: string): Promise<AgentCredentialResponseDto> {
    requirePermission(principal);
    await this.requiredCredential(credentialId);
    await this.credentials.setLifecycleStatus(credentialId, "active");
    return agentCredentialResponseSchema.parse({ credential: await this.requiredCredential(credentialId) });
  }

  async create(principal: AuthorizedApplicationPrincipal, input: CreateAgentAuthProviderRequestDto): Promise<AgentAuthProviderResponseDto> {
    requirePermission(principal);
    const request = createAgentAuthProviderRequestSchema.parse(input);
    const definition = validateAgentAuthProviderDefinition(request.definition);
    if (definition.kind === "runtime-native") {
      if (!this.nativePresets().some((preset) => preset.executionProviderId === definition.executionProviderId && preset.modelProvider === definition.modelProvider)) {
        throw new ApplicationBoundaryError("invalid-request", 400, "Choose a native Connection type from this host's pinned setup catalog.");
      }
    } else {
      if (this.options.nativeSessionsOnly) throw new ApplicationBoundaryError("invalid-request", 400, "This Local setup supports native-session Connections only. Existing credentials are preserved separately.");
      if (this.options.localV2Connections && !this.admittedDefinition(definition)) throw new ApplicationBoundaryError("invalid-request", 400, "Connection is outside this host's pinned setup catalog.");
      assertSupportedDefinition(definition);
      const credential = await this.requiredCredential(definition.credentialId);
      if (credential.lifecycleStatus !== "active" || !credential.valueAvailable) {
        throw new ApplicationBoundaryError("invalid-request", 400, `Credential ${definition.credentialId} is not active and ready.`);
      }
      if (definition.modelProvider !== undefined && credential.definition.modelProvider !== definition.modelProvider) {
        throw new ApplicationBoundaryError("invalid-request", 400, `Credential ${definition.credentialId} belongs to model provider ${credential.definition.modelProvider}, not ${definition.modelProvider}.`);
      }
    }
    if (this.options.providerConfig?.authProviders[definition.authProviderId] || await this.providers.get(definition.authProviderId)) {
      throw new ApplicationBoundaryError("conflict", 409, `Authentication configuration ${definition.authProviderId} already exists.`);
    }
    try {
      await this.providers.create(definition);
    } catch (error) {
      if (error instanceof AgentAuthProviderDefinitionConflictError) throw new ApplicationBoundaryError("conflict", 409, error.message);
      throw error;
    }
    return agentAuthProviderResponseSchema.parse({ provider: await this.required(definition.authProviderId) });
  }

  async list(principal: AuthorizedApplicationPrincipal, input: AgentAuthProviderListQueryDto): Promise<AgentAuthProviderListResponseDto> {
    requirePermission(principal);
    const query = agentAuthProviderListQuerySchema.parse(input);
    const stored = await this.allStoredProviders();
    const platform = this.platformSessionTargets();
    const requestedStatus = query.lifecycleStatus ?? "active";
    const targets = [
      ...platform
        .filter(() => requestedStatus === "active" || requestedStatus === "all")
        .map(({ target, displayName, loginRequirement }) => ({
          authProviderId: target.authProviderId,
          displayName,
          origin: "platform" as const,
          kind: "runtime-native" as const,
          executionProviderId: target.executionProviderId,
          ...(target.modelProvider ? { modelProvider: target.modelProvider } : {}),
          lifecycleStatus: "active" as const,
          loginRequirement,
        })),
      ...stored
        .filter(({ lifecycleStatus }) => requestedStatus === "all" || lifecycleStatus === requestedStatus)
        .filter(({ definition }) => !this.restrictedCatalog() || this.admittedDefinition(definition))
        .map(({ definition, lifecycleStatus }) => ({
          authProviderId: definition.authProviderId,
          displayName: definition.displayName,
          origin: "user" as const,
          kind: definition.kind,
          executionProviderId: definition.executionProviderId,
          ...(definition.modelProvider ? { modelProvider: definition.modelProvider } : {}),
          ...(definition.kind === "stored-credential" ? { credentialId: definition.credentialId } : {
            loginRequirement: nativeLoginRequirement(definition.executionProviderId, definition.modelProvider),
          }),
          lifecycleStatus,
        })),
    ].filter(({ executionProviderId }) => query.executionProviderId === undefined || executionProviderId === query.executionProviderId)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.authProviderId.localeCompare(right.authProviderId));
    const offset = decodeCatalogCursor(query.cursor);
    const pageSize = query.pageSize ?? 100;
    const page = targets.slice(offset, offset + pageSize);
    const items = await Promise.all(page.map(async (item) => {
      const latestProbe = await this.providers.getLatestProbe(item.authProviderId);
      return { ...item, ...(latestProbe ? { latestProbe } : {}) };
    }));
    const nextOffset = offset + page.length;
    return agentAuthProviderListResponseSchema.parse({
      items,
      pagination: nextOffset < targets.length ? { nextCursor: encodeCatalogCursor(nextOffset) } : {},
    });
  }

  async probe(principal: AuthorizedApplicationPrincipal, authProviderId: string): Promise<AgentAuthProviderProbeResponseDto> {
    requirePermission(principal);
    if (!this.options.connectionProbe) throw new ApplicationBoundaryError("provider-unavailable", 503, "Authentication connection probes are not configured for this host.");
    const target = await this.connectionTarget(authProviderId);
    const probe = await this.options.connectionProbe.probe(target);
    await this.providers.recordProbe(probe);
    return agentAuthProviderProbeResponseSchema.parse({ probe });
  }

  async preflight(principal: AuthorizedApplicationPrincipal, authProviderId: string): Promise<AgentAuthProviderPreflightResponseDto> {
    requirePermission(principal);
    const provider = await this.required(authProviderId);
    if (provider.definition.kind === "runtime-native") return agentAuthProviderPreflightResponseSchema.parse({
      authProviderId, available: false,
      message: provider.lifecycleStatus === "archived" ? "Authentication configuration is archived." : "Native login and model access are not verified by the stored definition. Use Test connection; it may consume provider quota.",
    });
    const credential = await this.credentials.getDefinition(provider.definition.credentialId);
    const available = provider.lifecycleStatus === "active" && credential?.lifecycleStatus === "active" && credential.valueAvailable;
    return agentAuthProviderPreflightResponseSchema.parse({
      authProviderId,
      available,
      ...(available ? {} : { message: provider.lifecycleStatus === "archived" ? "Authentication configuration is archived." : "Referenced credential is unavailable." }),
    });
  }

  async archive(principal: AuthorizedApplicationPrincipal, authProviderId: string): Promise<AgentAuthProviderResponseDto> {
    requirePermission(principal);
    await this.required(authProviderId);
    await this.providers.setLifecycleStatus(authProviderId, "archived");
    return agentAuthProviderResponseSchema.parse({ provider: await this.required(authProviderId) });
  }

  async restore(principal: AuthorizedApplicationPrincipal, authProviderId: string): Promise<AgentAuthProviderResponseDto> {
    requirePermission(principal);
    const provider = await this.required(authProviderId);
    if (provider.definition.kind === "stored-credential") {
      const credential = await this.requiredCredential(provider.definition.credentialId);
      if (credential.lifecycleStatus !== "active" || !credential.valueAvailable) {
        throw new ApplicationBoundaryError("invalid-request", 400, `Credential ${provider.definition.credentialId} is not active and ready.`);
      }
    }
    await this.providers.setLifecycleStatus(authProviderId, "active");
    return agentAuthProviderResponseSchema.parse({ provider: await this.required(authProviderId) });
  }

  private async required(authProviderId: string): Promise<ResolvedAgentAuthProviderDefinition> {
    const provider = await this.providers.get(authProviderId);
    if (!provider) throw new ApplicationBoundaryError("not-found", 404, `Authentication configuration ${authProviderId} does not exist.`);
    return provider;
  }

  private async requiredCredential(credentialId: string): Promise<ResolvedAgentCredentialDefinition> {
    const credential = await this.credentials.getDefinition(credentialId);
    if (!credential) throw new ApplicationBoundaryError("not-found", 404, `Credential ${credentialId} does not exist.`);
    return credential;
  }

  private async allStoredProviders(): Promise<ResolvedAgentAuthProviderDefinition[]> {
    const items: ResolvedAgentAuthProviderDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.providers.list({ lifecycleStatus: "all", pageSize: 500, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }

  private nativePresets() {
    return nativeConnectionPresets.filter((preset) =>
      this.options.providerConfig?.executionProviders[preset.executionProviderId]?.requiredVersion === preset.requiredVersion
      && (this.options.nativeSetupEvidence ?? nativeConnectionSetupEvidence).some((record) => record.presetId === preset.presetId && record.requiredVersion === preset.requiredVersion));
  }

  private restrictedCatalog() {
    return this.options.nativeSessionsOnly || this.options.localV2Connections;
  }

  private apiKeyPresets() {
    if (this.options.nativeSessionsOnly) return [];
    return this.options.localV2Connections ? admittedLocalApiKeyPresets(this.options.providerConfig).map(({ requiredVersion: _pin, ...preset }) => preset) : authProviderPresets;
  }

  private admittedDefinition(definition: AgentAuthProviderDefinition) {
    if (definition.kind === "runtime-native") return this.nativePresets().some(preset => preset.executionProviderId === definition.executionProviderId && preset.modelProvider === definition.modelProvider);
    return this.apiKeyPresets().some(preset => preset.executionProviderId === definition.executionProviderId && preset.modelProvider === definition.modelProvider && preset.targetVariable === definition.targetVariable);
  }

  private platformSessionTargets(): Array<{
    target: AgentAuthConnectionTarget;
    displayName: string;
    loginRequirement: { application: string; instruction: string };
  }> {
    return Object.entries(this.options.providerConfig?.authProviders ?? {}).flatMap(([authProviderId, provider]) => {
      if (provider.kind !== "runtime-native") return [];
      const modelProvider = provider.modelProvider ?? (provider.runtime === "codex-cli" ? "openai" : undefined);
      if (this.restrictedCatalog() && !this.nativePresets().some((preset) => preset.executionProviderId === provider.runtime && preset.modelProvider === modelProvider)) return [];
      if (this.restrictedCatalog() && authProviderId === "codex-native-session" && this.options.providerConfig?.authProviders["codex-openai-native-session"]) return [];
      const runtime = nativeRuntimePresentation(provider.runtime, authProviderId);
      const preset = nativeConnectionPresets.find((item) => item.executionProviderId === provider.runtime && item.modelProvider === modelProvider);
      return [{
        target: {
          authProviderId,
          executionProviderId: provider.runtime,
          ...(modelProvider ? { modelProvider } : {}),
        },
        displayName: preset?.label ?? runtime.displayName,
        loginRequirement: nativeLoginRequirement(provider.runtime, modelProvider),
      }];
    });
  }

  private async connectionTarget(authProviderId: string): Promise<AgentAuthConnectionTarget> {
    const platform = this.platformSessionTargets().find(({ target }) => target.authProviderId === authProviderId);
    if (platform) return platform.target;
    const stored = await this.required(authProviderId);
    if (this.restrictedCatalog() && !this.admittedDefinition(stored.definition)) {
      throw new ApplicationBoundaryError("invalid-request", 400, "Connection is outside this host's pinned setup catalog.");
    }
    if (stored.lifecycleStatus !== "active") throw new ApplicationBoundaryError("invalid-request", 400, "Authentication configuration is archived.");
    return {
      authProviderId,
      executionProviderId: stored.definition.executionProviderId,
      ...(stored.definition.modelProvider ? { modelProvider: stored.definition.modelProvider } : {}),
    };
  }
}

function requirePermission(principal: AuthorizedApplicationPrincipal): void {
  requireApplicationPermission(principal, "agent-auth-providers:admin");
}

function assertSupportedDefinition(definition: Extract<AgentAuthProviderDefinition, { kind: "stored-credential" }>): void {
  const supported = authProviderPresets.some((preset) => (
    preset.executionProviderId === definition.executionProviderId
    && ("modelProvider" in preset ? preset.modelProvider : undefined) === definition.modelProvider
    && preset.targetVariable === definition.targetVariable
  ));
  if (!supported) throw new ApplicationBoundaryError("invalid-request", 400, "Authentication configuration does not match a supported runtime and model-provider preset.");
}

function nativeLoginRequirement(runtime: AgentAuthConnectionTarget["executionProviderId"], modelProvider?: string) {
  const preset = nativeConnectionPresets.find((item) => item.executionProviderId === runtime && item.modelProvider === modelProvider);
  const presentation = nativeRuntimePresentation(runtime, "");
  return { application: presentation.application, instruction: preset?.loginInstruction ?? presentation.loginInstruction };
}

function nativeRuntimePresentation(runtime: AgentAuthConnectionTarget["executionProviderId"], authProviderId: string): {
  displayName: string;
  application: string;
  loginInstruction: string;
} {
  if (runtime === "codex-cli") return { displayName: "Codex native session", application: "Codex CLI", loginInstruction: "Requires login to Codex CLI. Run codex login." };
  if (runtime === "claude-code-cli") return { displayName: "Claude Code native session", application: "Claude Code", loginInstruction: "Requires login to Claude Code. Run /login inside Claude Code." };
  if (runtime === "kimi-code-cli") return { displayName: "Kimi Code native session", application: "Kimi Code", loginInstruction: "Requires login to Kimi Code. Run kimi login." };
  return { displayName: authProviderId === "pi-openai-codex-session" ? "Pi OpenAI Codex session" : "Pi native session", application: "Pi CLI", loginInstruction: "Requires login to the corresponding provider inside Pi CLI." };
}

function encodeCatalogCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCatalogCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (!Number.isInteger(value.offset) || Number(value.offset) < 0) throw new Error("invalid offset");
    return Number(value.offset);
  } catch {
    throw new ApplicationBoundaryError("invalid-request", 400, "Authentication catalog cursor is invalid.");
  }
}
