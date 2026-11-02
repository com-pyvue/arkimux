import { describe, expect, it, vi } from "vitest";
import {
  RunConfigurationApiClient,
  compareRunConfigurationsRequestSchema,
  runConfigurationDefinitionSchema,
} from "../../apps/packages/run-configuration/contract/src/index.ts";

const hash = "a".repeat(64);

describe("Run Configuration transport contract", () => {
  it("exposes only explicitly redacted definition fields", () => {
    expect(() => runConfigurationDefinitionSchema.parse({
      configurationId: "fixture-v1",
      workflow: { kind: "fixture.workflow", version: 1 },
      lifecycleStatus: "active",
      contentHash: hash,
      definition: { apiKey: "secret" },
    })).toThrow();
    expect(() => compareRunConfigurationsRequestSchema.parse({
      configurationIds: ["fixture-v1", "fixture-v1"],
    })).toThrow();
  });

  it("serializes paginated lists and validates redacted definitions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/workflows/fixture.workflow/1/run-configurations");
      expect(Object.fromEntries(url.searchParams)).toEqual({ pageSize: "25", cursor: "fixture-v0" });
      return json({
        items: [{
          configurationId: "fixture-v1",
          workflow: { kind: "fixture.workflow", version: 1 },
          lifecycleStatus: "active",
          contentHash: hash,
          redactedDefinition: { configurationId: "fixture-v1", authorizationToken: "[REDACTED]" },
        }],
        pagination: {},
      });
    });
    const client = new RunConfigurationApiClient({ baseUrl: "https://configurations.example/", fetch });
    await expect(client.listDefinitions({ kind: "fixture.workflow", version: 1 }, { pageSize: 25, cursor: "fixture-v0" })).resolves.toMatchObject({
      items: [{ configurationId: "fixture-v1" }],
    });
  });

  it("exposes validated immutable-publication conflicts", async () => {
    const client = new RunConfigurationApiClient({
      baseUrl: "https://configurations.example",
      fetch: async () => json({
        error: { code: "conflict", message: "Run configuration fixture-v1 is immutable." },
      }, 409),
    });
    await expect(client.publishDefinition({ kind: "fixture.workflow", version: 1 }, { definition: definition("fixture-v1", 1) }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
  });
});

function definition(configurationId: string, value: number) {
  return {
    schemaVersion: 1,
    configurationId,
    workflow: { kind: "fixture.workflow", version: 1 },
    value,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
