import type { Hono } from "hono";

export interface LocalResultView {
  resultKind: string;
  payloadSchemaVersion: number;
  render(payload: unknown): string | Promise<string>;
}

export interface LocalResultViewSource {
  snapshot(): { revision: number; status: "ready" | "unavailable" | "error"; views: readonly LocalResultView[] };
  close(): Promise<void>;
}

/** Optional project views read payloads through the same authorized Results API. */
export function mountLocalResultViews(app: Hono, views: readonly LocalResultView[], source?: LocalResultViewSource): void {
  const snapshot = () => source?.snapshot() ?? { revision: 0, status: "ready" as const, views };
  app.get("/arkimux/result-renderers", (context) => {
    const current = snapshot();
    context.header("Cache-Control", "no-store");
    context.header("X-ArkiMux-Renderer-Revision", String(current.revision));
    context.header("X-ArkiMux-Renderer-Status", current.status);
    context.header("Access-Control-Expose-Headers", "X-ArkiMux-Renderer-Revision, X-ArkiMux-Renderer-Status");
    return context.json(current.views.map(({ resultKind, payloadSchemaVersion }) => ({ resultKind, payloadSchemaVersion })));
  });
  app.get("/arkimux/result-views/:run/:result", async (context) => {
    const run = encodeURIComponent(context.req.param("run"));
    const result = encodeURIComponent(context.req.param("result"));
    const response = await app.request(`/api/v1/runs/${run}/results/${result}`, { headers: context.req.raw.headers });
    if (!response.ok) return new Response(null, { status: response.status });
    const value = await response.json() as { resultKind: string; payload?: { schemaVersion?: number } };
    const current = snapshot();
    if (current.status === "error") return context.json({ error: "The project renderer failed. The original JSON remains available." }, 422);
    const view = current.views.find((item) => item.resultKind === value.resultKind && item.payloadSchemaVersion === value.payload?.schemaVersion);
    if (!view) return context.json({ error: "No compatible view." }, 404);
    try {
      const html = await view.render(value.payload);
      return context.html(html, 200, { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    } catch {
      return context.json({ error: "The project renderer failed. The original JSON remains available." }, 422);
    }
  });
}
