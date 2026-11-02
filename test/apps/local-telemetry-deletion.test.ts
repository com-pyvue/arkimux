import { expect, it, vi } from "vitest";
import { createAgentExecutionApiHost } from "../../apps/hosts/api/src/apiHost.ts";
import { agentExecutionUiConfiguration } from "../../apps/packages/ui-profile/contract/src/index.ts";

function fixture() {
  const requestDeletion = vi.fn(async () => ({ sharingEnabled: false, deletionRequest: { status: "pending" } }));
  const authorizeDeletion = vi.fn(async (request: Request) => {
    if (request.headers.get("authorization") !== "Bearer local-session") throw new Error("private details");
  });
  const app = createAgentExecutionApiHost({ allowedBrowserOrigins: ["http://localhost:1234"],
    uiConfiguration: agentExecutionUiConfiguration("workflow-development"),
    localUsageTelemetry: { status: async () => ({}), choose: async () => ({}), requestDeletion, authorizeDeletion } });
  return { app, requestDeletion };
}
const headers = { "content-type": "application/json", authorization: "Bearer local-session", origin: "http://localhost:1234" };
it("requires a Local session, allowed origin and explicit confirmation", async () => {
  const f = fixture();
  for (const input of [
    { headers: { ...headers, authorization: "" }, body: { confirm: true }, code: 401 },
    { headers: { ...headers, origin: "https://attacker.example" }, body: { confirm: true }, code: 403 },
    { headers, body: {}, code: 400 }, { headers, body: { confirm: true, installation_id: "someone-else" }, code: 400 },
  ]) {
    const reply = await f.app.request("/api/v1/local/privacy/deletion", { method: "POST", headers: input.headers, body: JSON.stringify(input.body) });
    expect(reply.status).toBe(input.code); expect(await reply.text()).not.toContain("private details");
  }
  expect(f.requestDeletion).not.toHaveBeenCalled();
  const reply = await f.app.request("/api/v1/local/privacy/deletion", { method: "POST", headers, body: JSON.stringify({ confirm: true }) });
  expect(reply.status).toBe(202); expect(f.requestDeletion).toHaveBeenCalledTimes(1);
});
it("shows a safe actionable failure rather than raw internal details", async () => {
  const f = fixture(); f.requestDeletion.mockRejectedValueOnce(new Error("/private/credential"));
  const reply = await f.app.request("/api/v1/local/privacy/deletion", { method: "POST", headers, body: JSON.stringify({ confirm: true }) });
  expect(reply.status).toBe(409); expect(await reply.text()).not.toContain("/private/credential");
});

it("accepts the exact runtime Local origin without trusting Host or forwarded headers", async () => {
  let origin: string | undefined;
  const requestDeletion = vi.fn(async () => ({ pending: true }));
  const app = createAgentExecutionApiHost({ allowedBrowserOrigins: [], localServerOrigin: () => origin,
    uiConfiguration: agentExecutionUiConfiguration("workflow-development"),
    localUsageTelemetry: { status: async () => ({}), choose: async () => ({}), requestDeletion, authorizeDeletion: async () => {} } });
  const send = (browserOrigin: string, body = { confirm: true }) => app.request("http://attacker.example/api/v1/local/privacy/deletion", {
    method: "POST", headers: { origin: browserOrigin, host: "attacker.example", "x-forwarded-host": "attacker.example", "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await send("http://127.0.0.1:18985")).status).toBe(403);
  origin = "http://127.0.0.1:18985";
  for (const invalid of ["http://127.0.0.1:18986", "https://127.0.0.1:18985", "http://attacker.example", "null"]) expect((await send(invalid)).status).toBe(403);
  expect((await send(origin, { confirm: false })).status).toBe(400);
  expect(requestDeletion).not.toHaveBeenCalled();
  expect((await send(origin)).status).toBe(202);
  expect(requestDeletion).toHaveBeenCalledTimes(1);
});
