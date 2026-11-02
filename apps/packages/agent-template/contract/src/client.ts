import type { z } from "zod";
import {
  agentTemplateDetailResponseSchema,
  agentTemplateEditorMetadataResponseSchema,
  agentTemplateListQuerySchema,
  agentTemplateListResponseSchema,
  agentTemplateMutationRequestSchema,
  agentTemplateMutationResponseSchema,
  apiErrorResponseSchema,
  templateIdSchema,
  type AgentTemplateDetailResponseDto,
  type AgentTemplateEditorMetadataResponseDto,
  type AgentTemplateListQueryDto,
  type AgentTemplateListResponseDto,
  type AgentTemplateMutationRequestDto,
  type AgentTemplateMutationResponseDto,
} from "./schemas.ts";

export interface AgentTemplateApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  requestInit?: () => RequestInit | Promise<RequestInit>;
}

export class AgentTemplateApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AgentTemplateApiError";
  }
}

export class AgentTemplateApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: AgentTemplateApiClientOptions["requestInit"];

  constructor(options: AgentTemplateApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ? (...args) => options.fetch!(...args) : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }

  metadata(): Promise<AgentTemplateEditorMetadataResponseDto> {
    return this.#request("/api/v1/agent-templates/editor-metadata", agentTemplateEditorMetadataResponseSchema);
  }
  validate(request: AgentTemplateMutationRequestDto): Promise<AgentTemplateMutationResponseDto> {
    return this.#request("/api/v1/agent-templates/validation", agentTemplateMutationResponseSchema, {
      method: "POST", body: JSON.stringify(agentTemplateMutationRequestSchema.parse(request)),
    });
  }
  publish(request: AgentTemplateMutationRequestDto): Promise<AgentTemplateMutationResponseDto> {
    return this.#request("/api/v1/agent-templates", agentTemplateMutationResponseSchema, {
      method: "POST", body: JSON.stringify(agentTemplateMutationRequestSchema.parse(request)),
    });
  }
  list(query: AgentTemplateListQueryDto = {}): Promise<AgentTemplateListResponseDto> {
    const parsed = agentTemplateListQuerySchema.parse(query);
    const params = new URLSearchParams();
    if (parsed.pageSize !== undefined) params.set("pageSize", String(parsed.pageSize));
    if (parsed.cursor !== undefined) params.set("cursor", parsed.cursor);
    if (parsed.lifecycleStatus !== undefined) params.set("lifecycleStatus", parsed.lifecycleStatus);
    return this.#request(`/api/v1/agent-templates${params.size ? `?${params}` : ""}`, agentTemplateListResponseSchema);
  }
  get(templateId: string): Promise<AgentTemplateDetailResponseDto> {
    return this.#request(`/api/v1/agent-templates/${encodeURIComponent(templateIdSchema.parse(templateId))}`, agentTemplateDetailResponseSchema);
  }
  archive(templateId: string): Promise<AgentTemplateDetailResponseDto> {
    return this.#request(`/api/v1/agent-templates/${encodeURIComponent(templateIdSchema.parse(templateId))}/archive`, agentTemplateDetailResponseSchema, { method: "POST" });
  }
  restore(templateId: string): Promise<AgentTemplateDetailResponseDto> {
    return this.#request(`/api/v1/agent-templates/${encodeURIComponent(templateIdSchema.parse(templateId))}/restore`, agentTemplateDetailResponseSchema, { method: "POST" });
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
      throw new AgentTemplateApiError(response.status, parsed.success ? parsed.data.error.code : "invalid-error-response", parsed.success ? parsed.data.error.message : "Agent Template API returned an invalid error response.");
    }
    return schema.parse(value);
  }
}
