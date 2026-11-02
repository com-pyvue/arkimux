import type { Hono } from "hono";
import { observeFrameworkError, type FrameworkErrorObserver } from "@com-pyvue/agent-execution-application-host/internal/frameworkErrors.ts";

export interface LocalSessionInstrumentation {
  begin(action: "connection_created" | "connection_tested" | "configuration_saved" | "invocation_submitted"): Promise<string | undefined>;
  finish(ticket: string, succeeded: boolean, executionId?: string): Promise<void>;
  fetched(executionId: string): Promise<boolean>;
}

/** Observe bounded outcomes only. Request contents and error text never leave their feature. */
export function mountLocalSessionInstrumentation(app: Hono, session: LocalSessionInstrumentation, onFrameworkError?: FrameworkErrorObserver) {
  app.use("/api/*", async (c, next) => {
    const route = c.req.path;
    const action = c.req.method !== "POST" ? undefined
      : route === "/api/v1/agent-auth-providers" ? "connection_created"
      : /^\/api\/v1\/agent-auth-providers\/[^/]+\/probe$/.test(route) ? "connection_tested"
      : /^\/api\/v1\/workflows\/[^/]+\/[^/]+\/run-configurations$/.test(route) ? "configuration_saved"
      : route === "/api/v1/runs" ? "invocation_submitted" : undefined;
    const ticket = action ? await session.begin(action).catch(async error => { await observeFrameworkError(onFrameworkError, error, "telemetry"); return undefined; }) : undefined;
    try { await next(); }
    finally {
      // Observe the authorized payload response, not the result list or a browser signal.
      // A successful response means fetched, not displayed or read by a human.
      const result = c.req.method === "GET" && !c.error && c.res.status === 200
        ? /^\/api\/v1\/runs\/([^/]+)\/results\/[^/]+$/.exec(route) : null;
      if (result) {
        try { await session.fetched(decodeURIComponent(result[1])); } catch (error) { await observeFrameworkError(onFrameworkError, error, "telemetry"); }
      }
      if (ticket) {
        let succeeded = c.res.status >= 200 && c.res.status < 300;
        let executionId: string | undefined;
        if (succeeded && (action === "connection_tested" || action === "invocation_submitted")) {
          const value: unknown = await c.res.clone().json().catch(() => undefined);
          const data = value && typeof value === 'object'
            ? value as {probe?: {status?: unknown}; runRef?: {executionId?: unknown}} : undefined;
          if (action === "connection_tested") succeeded = data?.probe?.status === "connected";
          else if (typeof data?.runRef?.executionId === "string") executionId = data.runRef.executionId;
        }
        await session.finish(ticket, succeeded, executionId).catch(error => observeFrameworkError(onFrameworkError, error, "telemetry"));
      }
    }
  });
}
