import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodType } from "zod";
import { ApplicationBoundaryError, toApplicationBoundaryError, type AuthorizedApplicationPrincipal } from "@com-pyvue/agent-execution-application-host";
import {
  agentAuthProviderListQuerySchema,
  agentCredentialListQuerySchema,
  apiErrorResponseSchema,
  authProviderIdSchema,
  credentialIdSchema,
  createAgentCredentialRequestSchema,
  createAgentAuthProviderRequestSchema,
  replaceAgentCredentialRequestSchema,
  type AgentAuthProviderListQueryDto,
  type AgentCredentialListQueryDto,
} from "@com-pyvue/agent-execution-agent-authentication-contract";
import type { AgentAuthenticationApplicationService } from "./services.ts";

export function createAgentAuthenticationRouter(input: {
  service: AgentAuthenticationApplicationService;
  authenticate(request: Request): Promise<AuthorizedApplicationPrincipal>;
}): Hono {
  const router = new Hono();
  router.get("/api/v1/agent-auth-providers/metadata", async (context) => context.json(input.service.metadata(await input.authenticate(context.req.raw))));
  router.get("/api/v1/agent-auth-providers", async (context) => context.json(await input.service.list(await input.authenticate(context.req.raw), query(context.req.query()))));
  router.post("/api/v1/agent-auth-providers", async (context) => context.json(await input.service.create(await input.authenticate(context.req.raw), parse(createAgentAuthProviderRequestSchema, await body(context))), 201));
  router.post("/api/v1/agent-auth-providers/:authProviderId/preflight", async (context) => context.json(await input.service.preflight(await input.authenticate(context.req.raw), id(context))));
  router.post("/api/v1/agent-auth-providers/:authProviderId/probe", async (context) => context.json(await input.service.probe(await input.authenticate(context.req.raw), id(context))));
  router.post("/api/v1/agent-auth-providers/:authProviderId/archive", async (context) => context.json(await input.service.archive(await input.authenticate(context.req.raw), id(context))));
  router.post("/api/v1/agent-auth-providers/:authProviderId/restore", async (context) => context.json(await input.service.restore(await input.authenticate(context.req.raw), id(context))));
  router.get("/api/v1/agent-credentials", async (context) => context.json(await input.service.listCredentials(await input.authenticate(context.req.raw), credentialQuery(context.req.query()))));
  router.post("/api/v1/agent-credentials", async (context) => context.json(await input.service.createCredential(await input.authenticate(context.req.raw), parse(createAgentCredentialRequestSchema, await body(context))), 201));
  router.put("/api/v1/agent-credentials/:credentialId/value", async (context) => context.json(await input.service.replaceCredential(await input.authenticate(context.req.raw), credentialId(context), parse(replaceAgentCredentialRequestSchema, await body(context)))));
  router.post("/api/v1/agent-credentials/:credentialId/archive", async (context) => context.json(await input.service.archiveCredential(await input.authenticate(context.req.raw), credentialId(context))));
  router.post("/api/v1/agent-credentials/:credentialId/restore", async (context) => context.json(await input.service.restoreCredential(await input.authenticate(context.req.raw), credentialId(context))));
  router.onError((error, context) => {
    const mapped = error instanceof ZodError ? new ApplicationBoundaryError("invalid-request", 400, "Request did not match the Agent Authentication API contract.") : toApplicationBoundaryError(error);
    return context.json(apiErrorResponseSchema.parse({ error: { code: mapped.code, message: mapped.message } }), mapped.status as ContentfulStatusCode);
  });
  return router;
}

function id(context: Context): string { return authProviderIdSchema.parse(context.req.param("authProviderId")); }
function credentialId(context: Context): string { return credentialIdSchema.parse(context.req.param("credentialId")); }
async function body(context: Context): Promise<unknown> { try { return await context.req.json(); } catch { throw new ApplicationBoundaryError("invalid-request", 400, "Request body must be valid JSON."); } }
function parse<T>(schema: ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) throw new ApplicationBoundaryError("invalid-request", 400, "Request did not match the Agent Authentication API contract."); return parsed.data; }
function query(value: Record<string, string>): AgentAuthProviderListQueryDto {
  const unknown = Object.keys(value).filter((key) => !["pageSize", "cursor", "lifecycleStatus", "executionProviderId"].includes(key));
  if (unknown.length) throw new ApplicationBoundaryError("invalid-request", 400, `Unknown authentication-provider query fields: ${unknown.join(", ")}.`);
  return agentAuthProviderListQuerySchema.parse({
    ...(value.pageSize ? { pageSize: Number(value.pageSize) } : {}),
    ...(value.cursor ? { cursor: value.cursor } : {}),
    ...(value.lifecycleStatus ? { lifecycleStatus: value.lifecycleStatus } : {}),
    ...(value.executionProviderId ? { executionProviderId: value.executionProviderId } : {}),
  });
}

function credentialQuery(value: Record<string, string>): AgentCredentialListQueryDto {
  const unknown = Object.keys(value).filter((key) => !["pageSize", "cursor", "lifecycleStatus", "modelProvider"].includes(key));
  if (unknown.length) throw new ApplicationBoundaryError("invalid-request", 400, `Unknown credential query fields: ${unknown.join(", ")}.`);
  return agentCredentialListQuerySchema.parse({
    ...(value.pageSize ? { pageSize: Number(value.pageSize) } : {}),
    ...(value.cursor ? { cursor: value.cursor } : {}),
    ...(value.lifecycleStatus ? { lifecycleStatus: value.lifecycleStatus } : {}),
    ...(value.modelProvider ? { modelProvider: value.modelProvider } : {}),
  });
}
