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
  compareRunConfigurationsRequestSchema,
  configurationIdSchema,
  pageQuerySchema,
  publishRunConfigurationRequestSchema,
  validateRunConfigurationRequestSchema,
  workflowIdentitySchema,
  type PageQueryDto,
} from "@com-pyvue/agent-execution-run-configuration-contract";
import type { RunConfigurationApplicationService } from "./services.ts";

export interface RunConfigurationRouterDependencies {
  service: RunConfigurationApplicationService;
  authenticate(request: Request): Promise<AuthorizedApplicationPrincipal>;
}

export function createRunConfigurationRouter(dependencies: RunConfigurationRouterDependencies): Hono {
  const router = new Hono();

  router.post("/api/v1/workflows/:workflowKind/:workflowVersion/run-configurations/validation", async (context) => context.json(
    await dependencies.service.validate(
      await dependencies.authenticate(context.req.raw),
      workflowFromPath(context),
      requestContract(validateRunConfigurationRequestSchema, await jsonBody(context)),
    ),
  ));
  router.post("/api/v1/workflows/:workflowKind/:workflowVersion/run-configurations", async (context) => context.json(
    await dependencies.service.publish(
      await dependencies.authenticate(context.req.raw),
      workflowFromPath(context),
      requestContract(publishRunConfigurationRequestSchema, await jsonBody(context)),
    ),
  ));
  router.get("/api/v1/workflows/:workflowKind/:workflowVersion/run-configurations", async (context) => context.json(
    await dependencies.service.list(
      await dependencies.authenticate(context.req.raw),
      workflowFromPath(context),
      parsePageQuery(context.req.query()),
    ),
  ));
  router.get("/api/v1/workflows/:workflowKind/:workflowVersion/run-configurations/:configurationId", async (context) => context.json(
    await dependencies.service.get(
      await dependencies.authenticate(context.req.raw),
      workflowFromPath(context),
      requestContract(configurationIdSchema, context.req.param("configurationId")),
    ),
  ));
  router.post("/api/v1/workflows/:workflowKind/:workflowVersion/run-configurations/:configurationId/archive", async (context) => context.json(
    await dependencies.service.archive(
      await dependencies.authenticate(context.req.raw),
      workflowFromPath(context),
      requestContract(configurationIdSchema, context.req.param("configurationId")),
    ),
  ));
  router.post("/api/v1/workflows/:workflowKind/:workflowVersion/run-configurations/:configurationId/restore", async (context) => context.json(
    await dependencies.service.restore(
      await dependencies.authenticate(context.req.raw),
      workflowFromPath(context),
      requestContract(configurationIdSchema, context.req.param("configurationId")),
    ),
  ));
  router.post("/api/v1/workflows/:workflowKind/:workflowVersion/run-configuration-comparisons", async (context) => context.json(
    await dependencies.service.compare(
      await dependencies.authenticate(context.req.raw),
      workflowFromPath(context),
      requestContract(compareRunConfigurationsRequestSchema, await jsonBody(context)),
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

function workflowFromPath(context: Context) {
  return requestContract(workflowIdentitySchema, {
    kind: context.req.param("workflowKind"),
    version: Number(context.req.param("workflowVersion")),
  });
}

async function jsonBody(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new ApplicationBoundaryError("invalid-request", 400, "Request body must be valid JSON.");
  }
}

function parsePageQuery(query: Record<string, string>): PageQueryDto {
  const unknown = Object.keys(query).filter((key) => (
    key !== "pageSize" && key !== "cursor" && key !== "lifecycleStatus"
  ));
  if (unknown.length > 0) {
    throw new ApplicationBoundaryError(
      "invalid-request",
      400,
      `Unknown run-configuration query fields: ${unknown.join(", ")}.`,
    );
  }
  return requestContract(pageQuerySchema, {
    ...(query.pageSize === undefined ? {} : { pageSize: Number(query.pageSize) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.lifecycleStatus === undefined ? {} : { lifecycleStatus: query.lifecycleStatus }),
  });
}

function mapError(error: unknown): ApplicationBoundaryError {
  if (error instanceof ZodError) {
    return new ApplicationBoundaryError(
      "internal-error",
      500,
      "Run Configuration API data did not match its response contract.",
    );
  }
  return toApplicationBoundaryError(error);
}

function requestContract<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationBoundaryError(
      "invalid-request",
      400,
      "Request did not match the Run Configuration API contract.",
    );
  }
  return parsed.data;
}
