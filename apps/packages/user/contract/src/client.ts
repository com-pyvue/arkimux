import type { z } from "zod";
import {
  apiErrorResponseSchema,
  registerCurrentUserRequestSchema,
  registerCurrentUserResponseSchema,
  setUserStatusRequestSchema,
  setUserStatusResponseSchema,
  userDetailResponseSchema,
  userListQuerySchema,
  userListResponseSchema,
  type RegisterCurrentUserRequestDto,
  type RegisterCurrentUserResponseDto,
  type SetUserStatusRequestDto,
  type SetUserStatusResponseDto,
  type UserDetailResponseDto,
  type UserListQueryDto,
  type UserListResponseDto,
} from "./schemas.ts";

export interface UserApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  requestInit?: () => RequestInit | Promise<RequestInit>;
}

export class UserApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "UserApiError";
  }
}

export class UserApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: UserApiClientOptions["requestInit"];

  constructor(options: UserApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch
      ? (...args) => options.fetch!(...args)
      : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }

  registerCurrentUser(request: RegisterCurrentUserRequestDto): Promise<RegisterCurrentUserResponseDto> {
    return this.#request("/api/v1/users/me/registration", registerCurrentUserResponseSchema, {
      method: "POST",
      body: JSON.stringify(registerCurrentUserRequestSchema.parse(request)),
    });
  }

  listUsers(query: UserListQueryDto = {}): Promise<UserListResponseDto> {
    const parsed = userListQuerySchema.parse(query);
    return this.#request(`/api/v1/users${userListQueryString(parsed)}`, userListResponseSchema);
  }

  getUser(userId: string): Promise<UserDetailResponseDto> {
    return this.#request(`/api/v1/users/${encodeURIComponent(userId)}`, userDetailResponseSchema);
  }

  setUserStatus(userId: string, request: SetUserStatusRequestDto): Promise<SetUserStatusResponseDto> {
    return this.#request(`/api/v1/users/${encodeURIComponent(userId)}/status`, setUserStatusResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(setUserStatusRequestSchema.parse(request)),
    });
  }

  async #request<T>(path: string, schema: z.ZodType<T>, request: RequestInit = {}): Promise<T> {
    const supplied = await this.#requestInit?.() ?? {};
    const headers = new Headers(supplied.headers);
    headers.set("accept", "application/json");
    if (request.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...supplied,
      ...request,
      headers,
    });
    const value = await response.json() as unknown;
    if (!response.ok) {
      const parsed = apiErrorResponseSchema.safeParse(value);
      if (parsed.success) {
        throw new UserApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        );
      }
      throw new UserApiError(response.status, "invalid-error-response", "User API returned an invalid error response.");
    }
    return schema.parse(value);
  }
}

function userListQueryString(query: UserListQueryDto): string {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set("status", query.status);
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const serialized = params.toString();
  return serialized.length === 0 ? "" : `?${serialized}`;
}
