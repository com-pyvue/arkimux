import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodType } from "zod";
import {
  ApplicationBoundaryError,
  toApplicationBoundaryError,
  type AuthenticatedIdentity,
  type AuthorizedApplicationPrincipal,
} from "@com-pyvue/agent-execution-application-host";
import {
  apiErrorResponseSchema,
  registerCurrentUserRequestSchema,
  safeIdentifierSchema,
  setUserStatusRequestSchema,
  userListQuerySchema,
  type UserListQueryDto,
} from "@com-pyvue/agent-execution-user-contract";
import type { UserApplicationService } from "./services.ts";

export interface UserRouterDependencies {
  service: UserApplicationService;
  identify(request: Request): Promise<AuthenticatedIdentity>;
  authenticate(request: Request): Promise<AuthorizedApplicationPrincipal>;
}

export function createUserRouter(dependencies: UserRouterDependencies): Hono {
  const router = new Hono();

  router.post("/api/v1/users/me/registration", async (context) => context.json(
    await dependencies.service.registerCurrent(
      await dependencies.identify(context.req.raw),
      requestContract(registerCurrentUserRequestSchema, await jsonBody(context)),
    ),
  ));

  router.get("/api/v1/users", async (context) => context.json(
    await dependencies.service.list(
      await dependencies.authenticate(context.req.raw),
      parseUserListQuery(context.req.query()),
    ),
  ));

  router.get("/api/v1/users/:userId", async (context) => context.json(
    await dependencies.service.get(
      await dependencies.authenticate(context.req.raw),
      requestContract(safeIdentifierSchema, context.req.param("userId")),
    ),
  ));

  router.patch("/api/v1/users/:userId/status", async (context) => context.json(
    await dependencies.service.setStatus(
      await dependencies.authenticate(context.req.raw),
      requestContract(safeIdentifierSchema, context.req.param("userId")),
      requestContract(setUserStatusRequestSchema, await jsonBody(context)),
    ),
  ));

  router.onError((error, context) => {
    const mapped = mapError(error);
    return context.json(apiErrorResponseSchema.parse({
      error: { code: mapped.code, message: mapped.message },
    }), mapped.status as ContentfulStatusCode);
  });

  return router;
}

async function jsonBody(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new ApplicationBoundaryError("invalid-request", 400, "Request body must be valid JSON.");
  }
}

function parseUserListQuery(query: Record<string, string>): UserListQueryDto {
  const supported = new Set(["status", "pageSize", "cursor"]);
  const unknown = Object.keys(query).filter((key) => !supported.has(key));
  if (unknown.length > 0) {
    throw new ApplicationBoundaryError("invalid-request", 400, `Unknown user query fields: ${unknown.join(", ")}.`);
  }
  return requestContract(userListQuerySchema, {
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.pageSize === undefined ? {} : { pageSize: Number(query.pageSize) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
}

function mapError(error: unknown): ApplicationBoundaryError {
  if (error instanceof ZodError) {
    return new ApplicationBoundaryError("internal-error", 500, "User API data did not match its response contract.");
  }
  return toApplicationBoundaryError(error);
}

function requestContract<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationBoundaryError("invalid-request", 400, "Request did not match the User API contract.");
  }
  return parsed.data;
}
