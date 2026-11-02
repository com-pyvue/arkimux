import type { z } from "zod";
import {
  apiErrorResponseSchema,
  environmentListResponseSchema,
  environmentResponseSchema,
  publishEnvironmentRequestSchema,
  updateEnvironmentStatusRequestSchema,
  type EnvironmentListResponseDto,
  type EnvironmentResponseDto,
  type PublishEnvironmentRequestDto,
  type UpdateEnvironmentStatusRequestDto,
} from "./schemas.ts";

export class EnvironmentApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: () => RequestInit | Promise<RequestInit>;
  constructor(options: { baseUrl: string; fetch?: typeof fetch; requestInit?: () => RequestInit | Promise<RequestInit> }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ? (...args) => options.fetch!(...args) : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }
  list(organizationId: string): Promise<EnvironmentListResponseDto> {
    return this.#request(`/api/v1/organizations/${encodeURIComponent(organizationId)}/environments`, environmentListResponseSchema);
  }
  publish(organizationId: string, input: PublishEnvironmentRequestDto): Promise<EnvironmentResponseDto> {
    return this.#request(`/api/v1/organizations/${encodeURIComponent(organizationId)}/environments`, environmentResponseSchema, { method: "POST", body: JSON.stringify(publishEnvironmentRequestSchema.parse(input)) });
  }
  updateStatus(organizationId: string, environmentId: string, input: UpdateEnvironmentStatusRequestDto): Promise<EnvironmentResponseDto> {
    return this.#request(`/api/v1/organizations/${encodeURIComponent(organizationId)}/environments/${encodeURIComponent(environmentId)}/status`, environmentResponseSchema, { method: "PATCH", body: JSON.stringify(updateEnvironmentStatusRequestSchema.parse(input)) });
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
      throw new Error(error.success ? error.data.error.message : "Environment API returned an invalid error response.");
    }
    return schema.parse(value);
  }
}
