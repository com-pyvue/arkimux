import type { z } from "zod";
import {
  apiErrorResponseSchema,
  deploymentListResponseSchema,
  deploymentResponseSchema,
  publishDeploymentRequestSchema,
  publishReleaseRequestSchema,
  releaseResponseSchema,
  updateReadinessRequestSchema,
  type DeploymentListResponseDto,
  type DeploymentResponseDto,
  type PublishDeploymentRequestDto,
  type PublishReleaseRequestDto,
  type ReleaseResponseDto,
  type UpdateReadinessRequestDto,
} from "./schemas.ts";

export class WorkflowApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: () => RequestInit | Promise<RequestInit>;
  constructor(options: { baseUrl: string; fetch?: typeof fetch; requestInit?: () => RequestInit | Promise<RequestInit> }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ? (...args) => options.fetch!(...args) : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }
  listDeployments(organizationId: string, environmentId?: string): Promise<DeploymentListResponseDto> {
    const query = environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : "";
    return this.#request(`/api/v1/organizations/${encodeURIComponent(organizationId)}/workflow-deployments${query}`, deploymentListResponseSchema);
  }
  publishRelease(organizationId: string, input: PublishReleaseRequestDto): Promise<ReleaseResponseDto> {
    return this.#request(`/api/v1/organizations/${encodeURIComponent(organizationId)}/workflow-releases`, releaseResponseSchema, { method: "POST", body: JSON.stringify(publishReleaseRequestSchema.parse(input)) });
  }
  publishDeployment(organizationId: string, input: PublishDeploymentRequestDto): Promise<DeploymentResponseDto> {
    return this.#request(`/api/v1/organizations/${encodeURIComponent(organizationId)}/workflow-deployments`, deploymentResponseSchema, { method: "POST", body: JSON.stringify(publishDeploymentRequestSchema.parse(input)) });
  }
  updateReadiness(organizationId: string, workflowDeploymentId: string, input: UpdateReadinessRequestDto): Promise<DeploymentResponseDto> {
    return this.#request(`/api/v1/organizations/${encodeURIComponent(organizationId)}/workflow-deployments/${encodeURIComponent(workflowDeploymentId)}/readiness`, deploymentResponseSchema, { method: "PATCH", body: JSON.stringify(updateReadinessRequestSchema.parse(input)) });
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
      throw new Error(error.success ? error.data.error.message : "Workflow API returned an invalid error response.");
    }
    return schema.parse(value);
  }
}
