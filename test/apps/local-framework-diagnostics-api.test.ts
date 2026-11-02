import { describe, expect, it, vi } from "vitest";
import { ApplicationBoundaryError, type AuthorizedApplicationPrincipal } from "../../apps/packages/application-host/src/index.ts";
import { createAgentExecutionApiHost } from "../../apps/hosts/api/src/apiHost.ts";
import { agentExecutionUiConfiguration } from "../../apps/packages/ui-profile/contract/src/index.ts";
import { Hono } from "hono";

const ID = "00000000-0000-4000-8000-000000000001";

describe("Local framework diagnostics API", () => {
  it("observes the original child-router error after its response was sanitized", async () => {
    const original = new Error("private internal detail"), onFrameworkError = vi.fn(async () => undefined);
    const router = new Hono<{ Variables: { principal: AuthorizedApplicationPrincipal } }>();
    router.get("/api/fail", () => { throw original; });
    router.onError((_error, context) => context.json({ error: { message: "Friendly response" } }, 500));
    const host = createAgentExecutionApiHost({ uiConfiguration: agentExecutionUiConfiguration("workflow-development"),
      allowedBrowserOrigins: [], runRouter: router, onFrameworkError });
    const response = await host.request("http://api.test/api/fail");
    expect(await response.json()).toEqual({ error: { message: "Friendly response" } });
    expect(onFrameworkError).toHaveBeenCalledWith(original, "api");
  });
  it("bounds browser reports and requires a same-origin authenticated request", async () => {
    const receiveBrowser = vi.fn(async () => true), authorize = vi.fn(async () => undefined);
    const host = createAgentExecutionApiHost({ uiConfiguration: agentExecutionUiConfiguration("workflow-development"),
      allowedBrowserOrigins: [], localServerOrigin: () => "http://127.0.0.1:18985",
      localFrameworkDiagnostics: { authorize, receiveBrowser, list: async () => [], get: async () => undefined, delete: async () => {}, clear: async () => {} } });
    const send = (origin: string | undefined, body = "{}") => host.request("http://127.0.0.1:18985/api/v1/local/diagnostics/browser", {
      method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body });
    expect((await send(undefined)).status).toBe(403);
    expect((await send("https://attacker.test")).status).toBe(403);
    expect((await send("http://127.0.0.1:18985", "x".repeat(17 * 1024))).status).toBe(413);
    authorize.mockRejectedValueOnce(new Error("no session"));
    expect((await send("http://127.0.0.1:18985")).status).toBe(401);
    for (let i = 0; i < 10; i++) expect((await send("http://127.0.0.1:18985")).status).toBe(202);
    expect((await send("http://127.0.0.1:18985")).status).toBe(429);
    expect(receiveBrowser).toHaveBeenCalledTimes(10);
  });
  it("authenticates list, detail, and delete operations", async () => {
    const authorize = vi.fn(async () => undefined);
    const list = vi.fn(async () => [{ diagnosticId: ID }]);
    const get = vi.fn(async () => ({ diagnosticId: ID, error: { message: "private detail" } }));
    const remove = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const host = createAgentExecutionApiHost({
      uiConfiguration: agentExecutionUiConfiguration("workflow-development"), allowedBrowserOrigins: [],
      localFrameworkDiagnostics: { authorize, list, get, delete: remove, clear },
    });
    expect(await (await host.request("http://api.test/api/v1/local/diagnostics")).json()).toEqual({ items: [{ diagnosticId: ID }] });
    expect(await (await host.request(`http://api.test/api/v1/local/diagnostics/${ID}`)).json())
      .toEqual({ diagnosticId: ID, error: { message: "private detail" } });
    expect((await host.request(`http://api.test/api/v1/local/diagnostics/${ID}`, { method: "DELETE" })).status).toBe(204);
    expect((await host.request("http://api.test/api/v1/local/diagnostics", { method: "DELETE" })).status).toBe(204);
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(remove).toHaveBeenCalledWith(ID);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("does not expose records without a valid session and rejects unsafe IDs", async () => {
    const denied = createAgentExecutionApiHost({
      uiConfiguration: agentExecutionUiConfiguration("workflow-development"), allowedBrowserOrigins: [],
      localFrameworkDiagnostics: { authorize: async () => { throw new ApplicationBoundaryError("authentication-required", 401, "Authentication is required."); },
        list: async () => [], get: async () => undefined, delete: async () => undefined, clear: async () => undefined },
    });
    const unauthorized = await denied.request("http://api.test/api/v1/local/diagnostics");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: { code: "authentication-required", message: "Authentication is required." } });

    const host = createAgentExecutionApiHost({
      uiConfiguration: agentExecutionUiConfiguration("workflow-development"), allowedBrowserOrigins: [],
      localFrameworkDiagnostics: { authorize: async () => undefined, list: async () => [], get: async () => undefined,
        delete: async () => undefined, clear: async () => undefined },
    });
    const unsafe = await host.request("http://api.test/api/v1/local/diagnostics/../../credentials/key");
    expect(unsafe.status).not.toBe(200);
    const invalid = await host.request("http://api.test/api/v1/local/diagnostics/not-a-uuid");
    expect(invalid.status).toBe(400);
  });
});
