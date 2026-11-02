import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { createRunRouter } from "@com-pyvue/agent-execution-run-api";
import type { createUserRouter } from "@com-pyvue/agent-execution-user-api";
import type { createRoleRouter } from "@com-pyvue/agent-execution-role-api";
import type { createRunConfigurationRouter } from "@com-pyvue/agent-execution-run-configuration-api";
import type { createAgentTemplateRouter } from "@com-pyvue/agent-execution-agent-template-api";
import type { createAgentAuthenticationRouter } from "@com-pyvue/agent-execution-agent-authentication-api";
import type { AgentExecutionUiConfiguration } from "@com-pyvue/agent-execution-ui-profile-contract";
import { ApplicationBoundaryError, toApplicationBoundaryError } from "@com-pyvue/agent-execution-application-host";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { mountLocalSessionInstrumentation, type LocalSessionInstrumentation } from "./localSessionInstrumentation.ts";
import { observeFrameworkError, type FrameworkErrorObserver } from "@com-pyvue/agent-execution-application-host/internal/frameworkErrors.ts";

export interface AgentExecutionApiHostOptions {
  runRouter?: ReturnType<typeof createRunRouter>;
  userRouter?: ReturnType<typeof createUserRouter>;
  roleRouter?: ReturnType<typeof createRoleRouter>;
  runConfigurationRouter?: ReturnType<typeof createRunConfigurationRouter>;
  agentTemplateRouter?: ReturnType<typeof createAgentTemplateRouter>;
  agentAuthenticationRouter?: ReturnType<typeof createAgentAuthenticationRouter>;
  uiConfiguration: AgentExecutionUiConfiguration;
  allowedBrowserOrigins: readonly string[];
  /** Exact bound Local address, supplied by the server, never request headers. */
  localServerOrigin?: () => string | undefined;
  onFrameworkError?: FrameworkErrorObserver;
  localSession?: LocalSessionInstrumentation;
  localUsageTelemetry?: {
    status(): Promise<unknown>;
    choose(choice: "yes" | "no" | "ask-later"): Promise<unknown>;
    requestDeletion?(): Promise<unknown>;
    authorizeDeletion?(request: Request): Promise<unknown>;
  };
  localFrameworkDiagnostics?: {
    receiveBrowser?(value: unknown, origin: string): Promise<boolean>;
    authorize(request: Request): Promise<unknown>;
    list(): Promise<unknown>;
    get(diagnosticId: string): Promise<unknown | undefined>;
    delete(diagnosticId: string): Promise<void>;
    clear(): Promise<void>;
  };
}

export function createAgentExecutionApiHost(options: AgentExecutionApiHostOptions): Hono {
  const allowedOrigins = new Set(options.allowedBrowserOrigins);
  const originAllowed = (origin: string) => allowedOrigins.has(origin) || origin === options.localServerOrigin?.();
  const app = new Hono();
  app.use("/api/*", async (context, next) => {
    await next();
    // Child routers may already have sanitized the response. Hono retains the
    // original error on the request context, so never reconstruct it from JSON.
    if (context.error && context.res.status >= 500) await observeFrameworkError(options.onFrameworkError, context.error, "api");
  });
  app.onError(async (error, context) => {
    await observeFrameworkError(options.onFrameworkError, error, "api");
    const mapped = toApplicationBoundaryError(error);
    return context.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status as ContentfulStatusCode);
  });
  app.use("/api/*", cors({
    origin: (origin) => originAllowed(origin) ? origin : undefined,
    credentials: true,
  }));
  app.get("/api/v1/ui-configuration", (context) => context.json(options.uiConfiguration));
  if (options.localSession) mountLocalSessionInstrumentation(app, options.localSession, options.onFrameworkError);
  if (options.localUsageTelemetry) {
    app.get("/api/v1/local/privacy", async context => context.json(await options.localUsageTelemetry!.status()));
    app.post("/api/v1/local/privacy/deletion", async context => {
      const service = options.localUsageTelemetry!;
      if (!service.requestDeletion || !service.authorizeDeletion) return context.json({ error: { message: "Deletion is not available." } }, 404);
      const origin = context.req.header("origin");
      if (origin && !originAllowed(origin)) return context.json({ error: { message: "This origin is not allowed." } }, 403);
      try { await service.authorizeDeletion(context.req.raw); }
      catch { return context.json({ error: { message: "A Local session is required." } }, 401); }
      if (!context.req.header("content-type")?.startsWith("application/json")) return context.json({ error: { message: "Confirm deletion." } }, 400);
      const input = await context.req.json().catch(() => undefined);
      if (!input || input.confirm !== true || Object.keys(input).length !== 1) return context.json({ error: { message: "Confirm deletion." } }, 400);
      try { return context.json(await service.requestDeletion(), 202); }
      catch { return context.json({ error: { message: "Deletion could not start. Check that sharing has an authenticated connection, then try again." } }, 409); }
    });
    app.put("/api/v1/local/privacy", async context => {
      const value = await context.req.json().catch(() => undefined) as { choice?: unknown } | undefined;
      if (!value || !["yes", "no", "ask-later"].includes(String(value.choice))) {
        return context.json({ error: { code: "invalid-request", message: "Choose Yes, No, or Ask later." } }, 400);
      }
      return context.json(await options.localUsageTelemetry!.choose(value.choice as "yes" | "no" | "ask-later"));
    });
  }
  if (options.localFrameworkDiagnostics) {
    const diagnostics = options.localFrameworkDiagnostics;
    let windowStart = 0, count = 0;
    app.post("/api/v1/local/diagnostics/browser", bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: { message: "Diagnostic is too large." } }, 413) }), async context => {
      const origin = context.req.header("origin");
      if (!origin || !originAllowed(origin)) return context.json({ error: { message: "This origin is not allowed." } }, 403);
      try { await diagnostics.authorize(context.req.raw); } catch { return context.json({ error: { message: "A Local session is required." } }, 401); }
      if (!context.req.header("content-type")?.startsWith("application/json")) return context.body(null, 415);
      const now = Date.now(); if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
      if (++count > 10) return context.body(null, 429);
      const value = await context.req.json().catch(() => undefined);
      // A receiver failure must not report itself through this route again.
      try { return context.body(null, await diagnostics.receiveBrowser?.(value, origin) ? 202 : 400); }
      catch { return context.body(null, 503); }
    });
    app.route("/", createLocalFrameworkDiagnosticsRouter(diagnostics));
  }
  if (options.runRouter) app.route("/", options.runRouter);
  if (options.userRouter) app.route("/", options.userRouter);
  if (options.roleRouter) app.route("/", options.roleRouter);
  if (options.runConfigurationRouter) app.route("/", options.runConfigurationRouter);
  if (options.agentTemplateRouter) app.route("/", options.agentTemplateRouter);
  if (options.agentAuthenticationRouter) app.route("/", options.agentAuthenticationRouter);
  return app;
}

function createLocalFrameworkDiagnosticsRouter(diagnostics: NonNullable<AgentExecutionApiHostOptions["localFrameworkDiagnostics"]>): Hono {
  const router = new Hono();
  router.get("/api/v1/local/diagnostics", async context => {
    await diagnostics.authorize(context.req.raw);
    return context.json({ items: await diagnostics.list() });
  });
  router.get("/api/v1/local/diagnostics/:diagnosticId", async context => {
    await diagnostics.authorize(context.req.raw);
    const diagnosticId = diagnosticIdParameter(context.req.param("diagnosticId"));
    const value = await diagnostics.get(diagnosticId);
    if (value === undefined) throw new ApplicationBoundaryError("not-found", 404, "Diagnostic record was not found.");
    return context.json(value);
  });
  router.delete("/api/v1/local/diagnostics/:diagnosticId", async context => {
    await diagnostics.authorize(context.req.raw);
    await diagnostics.delete(diagnosticIdParameter(context.req.param("diagnosticId")));
    return context.body(null, 204);
  });
  router.delete("/api/v1/local/diagnostics", async context => {
    await diagnostics.authorize(context.req.raw);
    await diagnostics.clear();
    return context.body(null, 204);
  });
  router.onError((error, context) => {
    const mapped = toApplicationBoundaryError(error);
    return context.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status as ContentfulStatusCode);
  });
  return router;
}

function diagnosticIdParameter(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApplicationBoundaryError("invalid-request", 400, "Diagnostic ID is invalid.");
  }
  return value;
}
