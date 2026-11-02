import { projectionListQuerySchema, projectionListResponseSchema, type ProjectionListQueryDto, type ProjectionListResponseDto } from "./schemas.ts";
export class RunProjectionApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: () => RequestInit | Promise<RequestInit>;
  constructor(options: { baseUrl: string; fetch?: typeof fetch; requestInit?: () => RequestInit | Promise<RequestInit> }) { this.#baseUrl = options.baseUrl.replace(/\/$/, ""); this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis); this.#requestInit = options.requestInit; }
  async list(organizationId: string, input: string | ProjectionListQueryDto = {}): Promise<ProjectionListResponseDto> {
    const query = projectionListQuerySchema.parse(typeof input === "string" ? { environmentId: input } : input);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const suffix = params.size > 0 ? `?${params}` : "";
    const supplied = await this.#requestInit?.() ?? {};
    const response = await this.#fetch(`${this.#baseUrl}/api/v1/organizations/${encodeURIComponent(organizationId)}/run-projections${suffix}`, supplied);
    if (!response.ok) throw new Error(`Run Projection API returned HTTP ${response.status}.`);
    return projectionListResponseSchema.parse(await response.json());
  }
}
