import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";

export interface AgentExecutionApiServerOptions {
  app: Hono;
  port?: number;
  hostname?: string;
}

export function startAgentExecutionApiServer(options: AgentExecutionApiServerOptions): ServerType {
  return serve({
    fetch: options.app.fetch,
    port: options.port ?? 8787,
    hostname: options.hostname ?? "127.0.0.1",
  });
}
