import type { z } from "zod";
import {
  agentAuthenticationMetadataResponseSchema,
  agentCredentialListQuerySchema,
  agentCredentialListResponseSchema,
  agentCredentialResponseSchema,
  agentAuthProviderListQuerySchema,
  agentAuthProviderListResponseSchema,
  agentAuthProviderPreflightResponseSchema,
  agentAuthProviderProbeResponseSchema,
  agentAuthProviderResponseSchema,
  apiErrorResponseSchema,
  authProviderIdSchema,
  credentialIdSchema,
  createAgentCredentialRequestSchema,
  createAgentAuthProviderRequestSchema,
  replaceAgentCredentialRequestSchema,
  type AgentAuthenticationMetadataResponseDto,
  type AgentCredentialListQueryDto,
  type AgentCredentialListResponseDto,
  type AgentCredentialResponseDto,
  type CreateAgentCredentialRequestDto,
  type AgentAuthProviderListQueryDto,
  type AgentAuthProviderListResponseDto,
  type AgentAuthProviderPreflightResponseDto,
  type AgentAuthProviderProbeResponseDto,
  type AgentAuthProviderResponseDto,
  type CreateAgentAuthProviderRequestDto,
  type ReplaceAgentCredentialRequestDto,
} from "./schemas.ts";

export interface AgentAuthenticationApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  requestInit?: () => RequestInit | Promise<RequestInit>;
}

export class AgentAuthenticationApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AgentAuthenticationApiError";
  }
}

export class AgentAuthenticationApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: AgentAuthenticationApiClientOptions["requestInit"];

  constructor(options: AgentAuthenticationApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ? (...args) => options.fetch!(...args) : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }

  metadata(): Promise<AgentAuthenticationMetadataResponseDto> {
    return this.#request("/api/v1/agent-auth-providers/metadata", agentAuthenticationMetadataResponseSchema);
  }
  list(query: AgentAuthProviderListQueryDto = {}): Promise<AgentAuthProviderListResponseDto> {
    const parsed = agentAuthProviderListQuerySchema.parse(query);
    const params = new URLSearchParams();
    Object.entries(parsed).forEach(([key, value]) => value !== undefined && params.set(key, String(value)));
    return this.#request(`/api/v1/agent-auth-providers${params.size ? `?${params}` : ""}`, agentAuthProviderListResponseSchema);
  }
  create(input: CreateAgentAuthProviderRequestDto): Promise<AgentAuthProviderResponseDto> {
    return this.#request("/api/v1/agent-auth-providers", agentAuthProviderResponseSchema, { method: "POST", body: JSON.stringify(createAgentAuthProviderRequestSchema.parse(input)) });
  }
  listCredentials(query: AgentCredentialListQueryDto = {}): Promise<AgentCredentialListResponseDto> {
    const parsed = agentCredentialListQuerySchema.parse(query);
    const params = new URLSearchParams();
    Object.entries(parsed).forEach(([key, value]) => value !== undefined && params.set(key, String(value)));
    return this.#request(`/api/v1/agent-credentials${params.size ? `?${params}` : ""}`, agentCredentialListResponseSchema);
  }
  createCredential(input: CreateAgentCredentialRequestDto): Promise<AgentCredentialResponseDto> {
    return this.#request("/api/v1/agent-credentials", agentCredentialResponseSchema, { method: "POST", body: JSON.stringify(createAgentCredentialRequestSchema.parse(input)) });
  }
  replaceCredential(credentialId: string, input: ReplaceAgentCredentialRequestDto): Promise<AgentCredentialResponseDto> {
    return this.#request(`/api/v1/agent-credentials/${encodeURIComponent(credentialIdSchema.parse(credentialId))}/value`, agentCredentialResponseSchema, { method: "PUT", body: JSON.stringify(replaceAgentCredentialRequestSchema.parse(input)) });
  }
  archiveCredential(credentialId: string): Promise<AgentCredentialResponseDto> {
    return this.#request(`/api/v1/agent-credentials/${encodeURIComponent(credentialIdSchema.parse(credentialId))}/archive`, agentCredentialResponseSchema, { method: "POST" });
  }
  restoreCredential(credentialId: string): Promise<AgentCredentialResponseDto> {
    return this.#request(`/api/v1/agent-credentials/${encodeURIComponent(credentialIdSchema.parse(credentialId))}/restore`, agentCredentialResponseSchema, { method: "POST" });
  }
  preflight(authProviderId: string): Promise<AgentAuthProviderPreflightResponseDto> {
    return this.#request(`/api/v1/agent-auth-providers/${encodeURIComponent(authProviderIdSchema.parse(authProviderId))}/preflight`, agentAuthProviderPreflightResponseSchema, { method: "POST" });
  }
  probe(authProviderId: string): Promise<AgentAuthProviderProbeResponseDto> {
    return this.#request(`/api/v1/agent-auth-providers/${encodeURIComponent(authProviderIdSchema.parse(authProviderId))}/probe`, agentAuthProviderProbeResponseSchema, { method: "POST" });
  }
  archive(authProviderId: string): Promise<AgentAuthProviderResponseDto> {
    return this.#request(`/api/v1/agent-auth-providers/${encodeURIComponent(authProviderIdSchema.parse(authProviderId))}/archive`, agentAuthProviderResponseSchema, { method: "POST" });
  }
  restore(authProviderId: string): Promise<AgentAuthProviderResponseDto> {
    return this.#request(`/api/v1/agent-auth-providers/${encodeURIComponent(authProviderIdSchema.parse(authProviderId))}/restore`, agentAuthProviderResponseSchema, { method: "POST" });
  }

  async #request<T>(path: string, schema: z.ZodType<T>, request: RequestInit = {}): Promise<T> {
    const supplied = await this.#requestInit?.() ?? {};
    const headers = new Headers(supplied.headers);
    headers.set("accept", "application/json");
    if (request.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...supplied, ...request, headers });
    const value = await response.json() as unknown;
    if (!response.ok) {
      const parsed = apiErrorResponseSchema.safeParse(value);
      throw new AgentAuthenticationApiError(response.status, parsed.success ? parsed.data.error.code : "invalid-error-response", parsed.success ? parsed.data.error.message : "Authentication API returned an invalid error response.");
    }
    return schema.parse(value);
  }
}
