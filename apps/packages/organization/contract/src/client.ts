import type { z } from "zod";
import {
  apiErrorResponseSchema,
  createOrganizationRequestSchema,
  organizationListResponseSchema,
  organizationResponseSchema,
  setOrganizationStatusRequestSchema,
  type CreateOrganizationRequestDto,
  type OrganizationListResponseDto,
  type OrganizationResponseDto,
  type SetOrganizationStatusRequestDto,
} from "./schemas.ts";

export interface OrganizationApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  requestInit?: () => RequestInit | Promise<RequestInit>;
}

export class OrganizationApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: OrganizationApiClientOptions["requestInit"];

  constructor(options: OrganizationApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ? (...args) => options.fetch!(...args) : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }

  list(): Promise<OrganizationListResponseDto> {
    return this.#request("/api/v1/organizations", organizationListResponseSchema);
  }

  create(input: CreateOrganizationRequestDto): Promise<OrganizationResponseDto> {
    return this.#request("/api/v1/organizations", organizationResponseSchema, {
      method: "POST",
      body: JSON.stringify(createOrganizationRequestSchema.parse(input)),
    });
  }

  setStatus(organizationId: string, input: SetOrganizationStatusRequestDto): Promise<OrganizationResponseDto> {
    return this.#request(`/api/v1/organizations/${encodeURIComponent(organizationId)}/status`, organizationResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(setOrganizationStatusRequestSchema.parse(input)),
    });
  }

  async #request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const supplied = await this.#requestInit?.() ?? {};
    const headers = new Headers(supplied.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...supplied, ...init, headers });
    const value = await response.json() as unknown;
    if (!response.ok) {
      const error = apiErrorResponseSchema.safeParse(value);
      throw new Error(error.success ? error.data.error.message : "Organization API returned an invalid error response.");
    }
    return schema.parse(value);
  }
}
