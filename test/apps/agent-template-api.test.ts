import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthorizedApplicationPrincipal } from "../../apps/packages/application-host/src/index.ts";
import {
  AgentTemplateApplicationService,
  createAgentTemplateRouter,
} from "../../apps/packages/agent-template/api/src/index.ts";
import { AgentTemplateApiClient } from "../../apps/packages/agent-template/contract/src/index.ts";
import {
  FileAgentTemplateStore,
  createDefaultAgentExecutionProviderEditorDescriptors,
  defaultAgentTemplateDefinitions,
} from "@com-pyvue/agent-execution-core";

async function fixture() {
  const store = new FileAgentTemplateStore(await mkdtemp(path.join(os.tmpdir(), "agent-template-api-")));
  for (const template of defaultAgentTemplateDefinitions) await store.publish(template);
  const router = createAgentTemplateRouter({
    service: new AgentTemplateApplicationService(store, createDefaultAgentExecutionProviderEditorDescriptors({
      piOpenAiCodexModels: piModels,
    })),
    authenticate: async (request) => request.headers.get("x-principal") === "admin"
      ? principal(["agent-templates:admin"])
      : principal(["runs:read-own"]),
  });
  const client = (admin = true) => new AgentTemplateApiClient({
    baseUrl: "http://templates.test",
    requestInit: () => ({ headers: admin ? { "x-principal": "admin" } : {} }),
    fetch: (input, init) => router.request(input, init),
  });
  return { client, store };
}

describe("Agent Template API", () => {
  it("requires Agent Template administration permission", async () => {
    const reader = (await fixture()).client(false);
    await expect(reader.list()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.metadata()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.publish({ definition: customTemplate() }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("publishes immutable custom presets and exposes installed provider fields", async () => {
    const admin = (await fixture()).client();
    const metadata = await admin.metadata();
    expect(metadata).toMatchObject({
      executionProviders: expect.arrayContaining([
        expect.objectContaining({ providerId: "codex-cli", schemaVersion: 1 }),
        expect.objectContaining({ providerId: "pi-cli", schemaVersion: 1 }),
      ]),
    });
    const piModel = metadata.executionProviders
      .find(({ providerId }) => providerId === "pi-cli")?.fields
      .find(({ key }) => key === "model");
    expect(piModel).toMatchObject({
      kind: "string",
      allowsCustomValue: false,
      conditionalSuggestions: [{
        parameterKey: "provider",
        parameterValue: "openai-codex",
        options: [
          { value: "gpt-5.3-codex-spark" },
          { value: "gpt-5.4" },
          { value: "gpt-5.4-mini" },
          { value: "gpt-5.5" },
          { value: "gpt-5.6-luna" },
          { value: "gpt-5.6-sol" },
          { value: "gpt-5.6-terra" },
        ],
      }],
    });
    const published = await admin.publish({ definition: customTemplate() });
    expect(published.definition).toMatchObject({
      templateId: "custom-pi-v1",
      origin: "custom",
      lifecycleStatus: "active",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(admin.publish({ definition: customTemplate() })).resolves.toEqual(published);
    await expect(admin.publish({ definition: { ...customTemplate(), title: "Changed" } }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("validates provider parameters and never accepts browser-published platform templates or secrets", async () => {
    const admin = (await fixture()).client();
    await expect(admin.validate({ definition: { ...customTemplate(), origin: "platform" } }))
      .rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.validate({
      definition: {
        ...customTemplate(),
        policy: {
          ...customTemplate().policy,
          execution: {
            ...customTemplate().policy.execution,
            parameters: { provider: "openai-codex", model: "gpt-5.6-luna", unsupported: "value" },
          },
        },
      },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.validate({
      definition: { ...customTemplate(), policy: { ...customTemplate().policy, apiKey: "must-not-persist" } },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.validate({
      definition: {
        ...customTemplate(),
        policy: {
          ...customTemplate().policy,
          execution: { ...customTemplate().policy.execution, authProvider: "openai-api-key" },
        },
      },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.validate({
      definition: {
        ...customTemplate(),
        policy: {
          ...customTemplate().policy,
          execution: {
            ...customTemplate().policy.execution,
            parameters: { provider: "anthropic", model: "gpt-5.6-luna" },
          },
        },
      },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.validate({
      definition: {
        ...customTemplate(),
        policy: {
          ...customTemplate().policy,
          execution: {
            ...customTemplate().policy.execution,
            parameters: { provider: "openai-codex", model: "not-in-pi-catalog" },
          },
        },
      },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
  });

  it("soft-deletes custom templates but keeps platform templates active", async () => {
    const admin = (await fixture()).client();
    await admin.publish({ definition: customTemplate() });
    await expect(admin.archive("custom-pi-v1")).resolves.toMatchObject({
      definition: { lifecycleStatus: "archived" },
    });
    await expect(admin.list()).resolves.toMatchObject({
      items: expect.not.arrayContaining([expect.objectContaining({ templateId: "custom-pi-v1" })]),
    });
    await expect(admin.list({ lifecycleStatus: "archived" })).resolves.toMatchObject({
      items: [expect.objectContaining({ templateId: "custom-pi-v1" })],
    });
    await expect(admin.restore("custom-pi-v1")).resolves.toMatchObject({
      definition: { lifecycleStatus: "active" },
    });
    await expect(admin.archive("pi-cli-default-v1"))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
  });
});

function customTemplate() {
  return {
    schemaVersion: 1 as const,
    templateId: "custom-pi-v1",
    title: "Custom Pi",
    origin: "custom" as const,
    providerSchema: { executionProvider: "pi-cli", schemaVersion: 1 },
    policy: {
      timeoutMs: 120_000,
      execution: {
        provider: "pi-cli",
        authProvider: "pi-openai-codex-session",
        parameters: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      },
    },
  };
}

const piModels = [
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
].map((value) => ({ value, label: value }));

function principal(permissions: string[]): AuthorizedApplicationPrincipal {
  return {
    user: {
      schemaVersion: 1,
      userId: "admin",
      status: "active",
      identity: { providerId: "fixture", subjectId: "admin" },
      registeredAt: "2026-08-19T00:00:00.000Z",
    },
    roles: [{ schemaVersion: 1, roleId: "admin-role", permissions }],
    permissions,
  };
}
