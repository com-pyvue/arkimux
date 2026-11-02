import { describe, expect, it, vi } from "vitest";
import { createAgentExecutionApiHost } from "../../apps/hosts/api/src/apiHost.ts";
import { agentExecutionUiConfiguration } from "../../apps/packages/ui-profile/contract/src/index.ts";

describe("Local usage privacy API", () => {
  it("exposes status and accepts only the three public choices", async () => {
    const choose = vi.fn(async (choice: "yes" | "no" | "ask-later") => ({ choice }));
    const host = createAgentExecutionApiHost({
      uiConfiguration: agentExecutionUiConfiguration("workflow-development"), allowedBrowserOrigins: [],
      localUsageTelemetry: { status: async () => ({ choice: "undecided" }), choose },
    });
    expect(await (await host.request("http://api.test/api/v1/local/privacy")).json()).toEqual({ choice: "undecided" });
    const accepted = await host.request("http://api.test/api/v1/local/privacy", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice: "yes" }),
    });
    expect(accepted.status).toBe(200);
    expect(choose).toHaveBeenCalledWith("yes");
    const invalid = await host.request("http://api.test/api/v1/local/privacy", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice: "always" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "invalid-request", message: "Choose Yes, No, or Ask later." } });
  });
});
