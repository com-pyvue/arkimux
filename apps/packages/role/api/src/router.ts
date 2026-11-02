import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodType } from "zod";
import {
  ApplicationBoundaryError,
  toApplicationBoundaryError,
  type AuthorizedApplicationPrincipal,
} from "@com-pyvue/agent-execution-application-host";
import {
  apiErrorResponseSchema,
  assignRoleRequestSchema,
  defineRoleRequestSchema,
  pageQuerySchema,
  roleAssignmentListQuerySchema,
  safeIdentifierSchema,
  type PageQueryDto,
  type RoleAssignmentListQueryDto,
} from "@com-pyvue/agent-execution-role-contract";
import type { RoleApplicationService } from "./services.ts";

export interface RoleRouterDependencies {
  service: RoleApplicationService;
  authenticate(request: Request): Promise<AuthorizedApplicationPrincipal>;
}

export function createRoleRouter(dependencies: RoleRouterDependencies): Hono {
  const router = new Hono();

  router.post("/api/v1/roles", async (context) => context.json(
    await dependencies.service.define(
      await dependencies.authenticate(context.req.raw),
      requestContract(defineRoleRequestSchema, await jsonBody(context)),
    ),
  ));
  router.get("/api/v1/roles", async (context) => context.json(
    await dependencies.service.listRoles(
      await dependencies.authenticate(context.req.raw),
      parsePageQuery(context.req.query(), "role"),
    ),
  ));
  router.get("/api/v1/roles/:roleId", async (context) => context.json(
    await dependencies.service.getRole(
      await dependencies.authenticate(context.req.raw),
      requestContract(safeIdentifierSchema, context.req.param("roleId")),
    ),
  ));
  router.get("/api/v1/role-assignments", async (context) => context.json(
    await dependencies.service.listAssignments(
      await dependencies.authenticate(context.req.raw),
      parseAssignmentQuery(context.req.query()),
    ),
  ));
  router.post("/api/v1/role-assignments", async (context) => context.json(
    await dependencies.service.assign(
      await dependencies.authenticate(context.req.raw),
      requestContract(assignRoleRequestSchema, await jsonBody(context)),
    ),
  ));
  router.delete("/api/v1/role-assignments/:userId/:roleId", async (context) => context.json(
    await dependencies.service.revoke(
      await dependencies.authenticate(context.req.raw),
      requestContract(safeIdentifierSchema, context.req.param("userId")),
      requestContract(safeIdentifierSchema, context.req.param("roleId")),
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

function parsePageQuery(query: Record<string, string>, resource: string): PageQueryDto {
  const unknown = Object.keys(query).filter((key) => key !== "pageSize" && key !== "cursor");
  if (unknown.length > 0) {
    throw new ApplicationBoundaryError("invalid-request", 400, `Unknown ${resource} query fields: ${unknown.join(", ")}.`);
  }
  return requestContract(pageQuerySchema, {
    ...(query.pageSize === undefined ? {} : { pageSize: Number(query.pageSize) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
}

function parseAssignmentQuery(query: Record<string, string>): RoleAssignmentListQueryDto {
  const unknown = Object.keys(query).filter((key) => !["userId", "roleId", "pageSize", "cursor"].includes(key));
  if (unknown.length > 0) {
    throw new ApplicationBoundaryError("invalid-request", 400, `Unknown role-assignment query fields: ${unknown.join(", ")}.`);
  }
  return requestContract(roleAssignmentListQuerySchema, {
    ...(query.userId === undefined ? {} : { userId: query.userId }),
    ...(query.roleId === undefined ? {} : { roleId: query.roleId }),
    ...(query.pageSize === undefined ? {} : { pageSize: Number(query.pageSize) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
}

function mapError(error: unknown): ApplicationBoundaryError {
  if (error instanceof ZodError) {
    return new ApplicationBoundaryError("internal-error", 500, "Role API data did not match its response contract.");
  }
  return toApplicationBoundaryError(error);
}

function requestContract<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationBoundaryError("invalid-request", 400, "Request did not match the Role API contract.");
  }
  return parsed.data;
}
