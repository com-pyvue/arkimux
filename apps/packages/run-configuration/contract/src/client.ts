import type { z } from "zod";
import {
  apiErrorResponseSchema,
  compareRunConfigurationsRequestSchema,
  compareRunConfigurationsResponseSchema,
  configurationIdSchema,
  pageQuerySchema,
  publishRunConfigurationRequestSchema,
  publishRunConfigurationResponseSchema,
  runConfigurationDetailResponseSchema,
  runConfigurationListResponseSchema,
  validateRunConfigurationRequestSchema,
  validateRunConfigurationResponseSchema,
  workflowIdentitySchema,
  type CompareRunConfigurationsRequestDto,
  type CompareRunConfigurationsResponseDto,
  type PageQueryDto,
  type PublishRunConfigurationRequestDto,
  type PublishRunConfigurationResponseDto,
  type RunConfigurationDetailResponseDto,
  type RunConfigurationListResponseDto,
  type ValidateRunConfigurationRequestDto,
  type ValidateRunConfigurationResponseDto,
  type WorkflowIdentityDto,
} from "./schemas.ts";

export interface RunConfigurationApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  requestInit?: () => RequestInit | Promise<RequestInit>;
}

export class RunConfigurationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RunConfigurationApiError";
  }
}

export class RunConfigurationApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: RunConfigurationApiClientOptions["requestInit"];

  constructor(options: RunConfigurationApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ? (...args) => options.fetch!(...args) : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }

  validateDefinition(workflow: WorkflowIdentityDto, request: ValidateRunConfigurationRequestDto): Promise<ValidateRunConfigurationResponseDto> {
    return this.#request(`${workflowPath(workflow)}/run-configurations/validation`, validateRunConfigurationResponseSchema, {
      method: "POST",
      body: JSON.stringify(validateRunConfigurationRequestSchema.parse(request)),
    });
  }

  publishDefinition(workflow: WorkflowIdentityDto, request: PublishRunConfigurationRequestDto): Promise<PublishRunConfigurationResponseDto> {
    return this.#request(`${workflowPath(workflow)}/run-configurations`, publishRunConfigurationResponseSchema, {
      method: "POST",
      body: JSON.stringify(publishRunConfigurationRequestSchema.parse(request)),
    });
  }

  listDefinitions(workflow: WorkflowIdentityDto, query: PageQueryDto = {}): Promise<RunConfigurationListResponseDto> {
    const parsed = pageQuerySchema.parse(query);
    const params = new URLSearchParams();
    if (parsed.pageSize !== undefined) params.set("pageSize", String(parsed.pageSize));
    if (parsed.cursor !== undefined) params.set("cursor", parsed.cursor);
    if (parsed.lifecycleStatus !== undefined) params.set("lifecycleStatus", parsed.lifecycleStatus);
    const suffix = params.size === 0 ? "" : `?${params}`;
    return this.#request(`${workflowPath(workflow)}/run-configurations${suffix}`, runConfigurationListResponseSchema);
  }

  getDefinition(workflow: WorkflowIdentityDto, configurationId: string): Promise<RunConfigurationDetailResponseDto> {
    const id = configurationIdSchema.parse(configurationId);
    return this.#request(
      `${workflowPath(workflow)}/run-configurations/${encodeURIComponent(id)}`,
      runConfigurationDetailResponseSchema,
    );
  }

  archiveDefinition(workflow: WorkflowIdentityDto, configurationId: string): Promise<RunConfigurationDetailResponseDto> {
    const id = configurationIdSchema.parse(configurationId);
    return this.#request(
      `${workflowPath(workflow)}/run-configurations/${encodeURIComponent(id)}/archive`,
      runConfigurationDetailResponseSchema,
      { method: "POST" },
    );
  }

  restoreDefinition(workflow: WorkflowIdentityDto, configurationId: string): Promise<RunConfigurationDetailResponseDto> {
    const id = configurationIdSchema.parse(configurationId);
    return this.#request(
      `${workflowPath(workflow)}/run-configurations/${encodeURIComponent(id)}/restore`,
      runConfigurationDetailResponseSchema,
      { method: "POST" },
    );
  }

  compareDefinitions(workflow: WorkflowIdentityDto, request: CompareRunConfigurationsRequestDto): Promise<CompareRunConfigurationsResponseDto> {
    return this.#request(
      `${workflowPath(workflow)}/run-configuration-comparisons`,
      compareRunConfigurationsResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(compareRunConfigurationsRequestSchema.parse(request)),
      },
    );
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
      if (parsed.success) {
        throw new RunConfigurationApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        );
      }
      throw new RunConfigurationApiError(
        response.status,
        "invalid-error-response",
        "Run Configuration API returned an invalid error response.",
      );
    }
    return schema.parse(value);
  }
}

function workflowPath(workflow: WorkflowIdentityDto): string {
  const parsed = workflowIdentitySchema.parse(workflow);
  return `/api/v1/workflows/${encodeURIComponent(parsed.kind)}/${parsed.version}`;
}
