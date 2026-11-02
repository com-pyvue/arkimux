import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

export function mountLocalWebApplication(app: Hono, webRoot: string): Hono {
  // Maps are private diagnostic artifacts, never public web assets.
  app.use("*", async (context, next) => {
    try { if (decodeURIComponent(context.req.path).endsWith(".map")) return context.notFound(); }
    catch { return context.notFound(); }
    return next();
  });
  const assets = serveStatic({ root: webRoot });
  const index = serveStatic({ root: webRoot, path: "index.html" });
  app.use("*", assets);
  app.get("*", async (context, next) => {
    if (context.req.path === "/api" || context.req.path.startsWith("/api/")) return next();
    return index(context, next);
  });
  return app;
}
