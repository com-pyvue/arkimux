import type { z } from "zod";
import {
  apiErrorResponseSchema,
  assignRoleRequestSchema,
  assignRoleResponseSchema,
  defineRoleRequestSchema,
  defineRoleResponseSchema,
  pageQuerySchema,
  revokeRoleResponseSchema,
  roleAssignmentListQuerySchema,
  roleAssignmentListResponseSchema,
  roleDetailResponseSchema,
  roleListResponseSchema,
  type AssignRoleRequestDto,
  type AssignRoleResponseDto,
  type DefineRoleRequestDto,
  type DefineRoleResponseDto,
  type PageQueryDto,
  type RevokeRoleResponseDto,
  type RoleAssignmentListQueryDto,
  type RoleAssignmentListResponseDto,
  type RoleDetailResponseDto,
  type RoleListResponseDto,
} from "./schemas.ts";

export interface RoleApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  requestInit?: () => RequestInit | Promise<RequestInit>;
}

export class RoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RoleApiError";
  }
}

export class RoleApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: RoleApiClientOptions["requestInit"];

  constructor(options: RoleApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch
      ? (...args) => options.fetch!(...args)
      : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }

  defineRole(request: DefineRoleRequestDto): Promise<DefineRoleResponseDto> {
    return this.#request("/api/v1/roles", defineRoleResponseSchema, {
      method: "POST",
      body: JSON.stringify(defineRoleRequestSchema.parse(request)),
    });
  }

  listRoles(query: PageQueryDto = {}): Promise<RoleListResponseDto> {
    const parsed = pageQuerySchema.parse(query);
    return this.#request(`/api/v1/roles${queryString(parsed)}`, roleListResponseSchema);
  }

  getRole(roleId: string): Promise<RoleDetailResponseDto> {
    return this.#request(`/api/v1/roles/${encodeURIComponent(roleId)}`, roleDetailResponseSchema);
  }

  listAssignments(query: RoleAssignmentListQueryDto = {}): Promise<RoleAssignmentListResponseDto> {
    const parsed = roleAssignmentListQuerySchema.parse(query);
    return this.#request(`/api/v1/role-assignments${queryString(parsed)}`, roleAssignmentListResponseSchema);
  }

  assignRole(request: AssignRoleRequestDto): Promise<AssignRoleResponseDto> {
    return this.#request("/api/v1/role-assignments", assignRoleResponseSchema, {
      method: "POST",
      body: JSON.stringify(assignRoleRequestSchema.parse(request)),
    });
  }

  revokeRole(userId: string, roleId: string): Promise<RevokeRoleResponseDto> {
    return this.#request(
      `/api/v1/role-assignments/${encodeURIComponent(userId)}/${encodeURIComponent(roleId)}`,
      revokeRoleResponseSchema,
      { method: "DELETE" },
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
        throw new RoleApiError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
      }
      throw new RoleApiError(response.status, "invalid-error-response", "Role API returned an invalid error response.");
    }
    return schema.parse(value);
  }
}

function queryString(query: PageQueryDto | RoleAssignmentListQueryDto): string {
  const params = new URLSearchParams();
  if ("userId" in query && query.userId !== undefined) params.set("userId", query.userId);
  if ("roleId" in query && query.roleId !== undefined) params.set("roleId", query.roleId);
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const serialized = params.toString();
  return serialized.length === 0 ? "" : `?${serialized}`;
}
