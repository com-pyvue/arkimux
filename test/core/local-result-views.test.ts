import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountLocalResultViews } from "../../local/src/resultViews.ts";

describe("optional Local project result views", () => {
  it("uses the authorized Results route and leaves its JSON available after render failure", async () => {
    const app = new Hono();
    const payload = { schemaVersion: 1, city: "Istanbul" };
    app.get("/api/v1/runs/:run/results/:result", (c) => c.req.header("authorization") !== "Bearer fixture"
      ? c.json({ error: "unauthorized" }, 401) : c.json({ resultKind: "weather-advisor.result", payload }));
    mountLocalResultViews(app, [{ resultKind: "weather-advisor.result", payloadSchemaVersion: 1, render: () => { throw new Error("private path"); } }]);
    expect((await app.request("/arkimux/result-views/run/result")).status).toBe(401);
    const headers = { authorization: "Bearer fixture" };
    const response = await app.request("/arkimux/result-views/run/result", { headers });
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("private path");
    expect(await (await app.request("/api/v1/runs/run/results/result", { headers })).json()).toEqual({ resultKind: "weather-advisor.result", payload });
  });
  it("only serves matching versions in a sandboxed HTML response", async () => {
    const app = new Hono();
    app.get("/api/v1/runs/:run/results/:result", (c) => c.json({ resultKind: "weather-advisor.result", payload: { schemaVersion: Number(c.req.param("result")) } }));
    mountLocalResultViews(app, [{ resultKind: "weather-advisor.result", payloadSchemaVersion: 1, render: () => "<h1>Weather</h1>" }]);
    expect((await app.request("/arkimux/result-views/run/2")).status).toBe(404);
    const response = await app.request("/arkimux/result-views/run/1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toBe("<h1>Weather</h1>");
  });
});
