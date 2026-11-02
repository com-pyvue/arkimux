import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodType } from "zod";
import { ApplicationBoundaryError, toApplicationBoundaryError, type AuthorizedApplicationPrincipal } from "@com-pyvue/agent-execution-application-host";
import { agentTemplateListQuerySchema, agentTemplateMutationRequestSchema, apiErrorResponseSchema, templateIdSchema, type AgentTemplateListQueryDto } from "@com-pyvue/agent-execution-agent-template-contract";
import type { AgentTemplateApplicationService } from "./services.ts";

export function createAgentTemplateRouter(input: { service: AgentTemplateApplicationService; authenticate(request: Request): Promise<AuthorizedApplicationPrincipal> }): Hono {
  const router = new Hono();
  router.get("/api/v1/agent-templates/editor-metadata", async (context) => context.json(await input.service.metadata(await input.authenticate(context.req.raw))));
  router.post("/api/v1/agent-templates/validation", async (context) => context.json(await input.service.validate(await input.authenticate(context.req.raw), parse(agentTemplateMutationRequestSchema, await body(context)))));
  router.post("/api/v1/agent-templates", async (context) => context.json(await input.service.publish(await input.authenticate(context.req.raw), parse(agentTemplateMutationRequestSchema, await body(context))), 201));
  router.get("/api/v1/agent-templates", async (context) => context.json(await input.service.list(await input.authenticate(context.req.raw), page(context.req.query()))));
  router.get("/api/v1/agent-templates/:templateId", async (context) => context.json(await input.service.get(await input.authenticate(context.req.raw), templateIdSchema.parse(context.req.param("templateId")))));
  router.post("/api/v1/agent-templates/:templateId/archive", async (context) => context.json(await input.service.archive(await input.authenticate(context.req.raw), templateIdSchema.parse(context.req.param("templateId")))));
  router.post("/api/v1/agent-templates/:templateId/restore", async (context) => context.json(await input.service.restore(await input.authenticate(context.req.raw), templateIdSchema.parse(context.req.param("templateId")))));
  router.onError((error, context) => { const mapped = error instanceof ZodError ? new ApplicationBoundaryError("invalid-request", 400, "Request did not match the Agent Template API contract.") : toApplicationBoundaryError(error); return context.json(apiErrorResponseSchema.parse({ error: { code: mapped.code, message: mapped.message } }), mapped.status as ContentfulStatusCode); });
  return router;
}
async function body(context: Context): Promise<unknown> { try { return await context.req.json(); } catch { throw new ApplicationBoundaryError("invalid-request", 400, "Request body must be valid JSON."); } }
function parse<T>(schema: ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ApplicationBoundaryError("invalid-request", 400, "Request did not match the Agent Template API contract."); return result.data; }
function page(query: Record<string, string>): AgentTemplateListQueryDto { return agentTemplateListQuerySchema.parse({ ...(query.pageSize ? { pageSize: Number(query.pageSize) } : {}), ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.lifecycleStatus ? { lifecycleStatus: query.lifecycleStatus } : {}) }); }
