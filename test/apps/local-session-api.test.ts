import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountLocalSessionInstrumentation } from "../../apps/hosts/api/src/localSessionInstrumentation.ts";

function fixture() {
  const onFrameworkError = vi.fn(async () => undefined);
  const session = { begin: vi.fn(async () => "ticket"),
    finish: vi.fn(async () => undefined), fetched: vi.fn(async () => true) };
  const app = new Hono(); mountLocalSessionInstrumentation(app, session, onFrameworkError);
  app.post("/api/v1/agent-auth-providers/:id/probe", c => c.json({ probe: { status: "failed", message: "PRIVATE" } }));
  app.post("/api/v1/workflows/w/1/run-configurations", c => c.json({ configurationId: "PRIVATE" }));
  app.post("/api/v1/workflows/w/1/run-configurations/validation", c => c.json({ valid: true }));
  app.post("/api/v1/runs", c => c.json({ runRef: { executionId: "private-run" } }, 202));
  app.get("/api/v1/runs/:id/results", c => c.json({ items: [] }));
  app.get("/api/v1/runs/:id/results/:result", c => {
    if (c.req.param("result") === "missing") return c.body(null, 404);
    if (c.req.param("result") === "denied") return c.body(null, 403);
    if (c.req.param("result") === "unauthorized") return c.body(null, 401);
    if (c.req.param("result") === "broken") throw new Error("failed read");
    return c.json({ payload: "PRIVATE" });
  });
  app.onError((_error, c) => c.body(null, 500));
  return { app, session, onFrameworkError };
}
describe("Local session API instrumentation", () => {
  it("captures coded outcomes, including HTTP 200 probe failure, without copying response data", async () => {
    const { app, session } = fixture();
    const response = await app.request("/api/v1/agent-auth-providers/private/probe", { method: "POST" });
    expect(response.status).toBe(200);
    expect(session.begin).toHaveBeenCalledWith("connection_tested");
    expect(session.finish).toHaveBeenLastCalledWith("ticket", false, undefined);
    await app.request("/api/v1/workflows/w/1/run-configurations", { method: "POST" });
    expect(session.begin).toHaveBeenLastCalledWith("configuration_saved");
    await app.request("/api/v1/workflows/w/1/run-configurations/validation", { method: "POST" });
    expect(session.begin).toHaveBeenCalledTimes(2);
    await app.request("/api/v1/runs", { method: "POST" });
    expect(session.finish).toHaveBeenLastCalledWith("ticket", true, "private-run");
    expect(JSON.stringify(session.finish.mock.calls)).not.toContain("PRIVATE");
  });
  it("observes successful result payload GETs from any client without copying contents", async () => {
    const { app, session } = fixture();
    const response = await app.request("/api/v1/runs/run%3A1/results/result1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ payload: "PRIVATE" });
    expect(session.fetched).toHaveBeenCalledExactlyOnceWith("run:1");
    expect(JSON.stringify(session.fetched.mock.calls)).not.toContain("PRIVATE");
  });
  it("ignores lists, failed reads, HEAD and the removed browser reporting route", async () => {
    const { app, session } = fixture();
    for (const suffix of ["", "/missing", "/denied", "/unauthorized", "/broken"]) {
      await app.request(`/api/v1/runs/run/results${suffix}`);
    }
    await app.request("/api/v1/runs/run/results/result1", { method: "HEAD" });
    expect((await app.request("/api/v1/local/session/result-viewed", { method: "POST" })).status).toBe(404);
    expect(session.fetched).not.toHaveBeenCalled();
  });
  it("does not fail a product request when telemetry fails", async () => {
    const { app, session, onFrameworkError } = fixture();
    session.begin.mockRejectedValueOnce(new Error("disk unavailable"));
    expect((await app.request("/api/v1/runs", { method: "POST" })).status).toBe(202);
    session.finish.mockRejectedValueOnce(new Error("disk unavailable"));
    expect((await app.request("/api/v1/runs", { method: "POST" })).status).toBe(202);
    session.fetched.mockRejectedValueOnce(new Error("disk unavailable"));
    expect((await app.request("/api/v1/runs/run/results/result1")).status).toBe(200);
    expect(onFrameworkError).toHaveBeenCalledTimes(3);
    expect(onFrameworkError).toHaveBeenLastCalledWith(expect.any(Error), "telemetry");
  });
});
