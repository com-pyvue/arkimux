import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AuthorizedApplicationPrincipal } from "../../apps/packages/application-host/src/index.ts";
import {
  RunConfigurationApplicationService,
  RunConfigurationDefinitionValidatorRegistry,
  createRunConfigurationRouter,
  type RunConfigurationDefinition,
} from "../../apps/packages/run-configuration/api/src/index.ts";
import { RunConfigurationApiClient } from "../../apps/packages/run-configuration/contract/src/index.ts";
import {
  createDefaultAgentExecutionProviderEditorDescriptors,
  FileWorkflowRunConfigurationStore,
  type AgentExecutionProviderEditorDescriptor,
} from "@com-pyvue/agent-execution-core";

const workflow = { kind: "fixture.workflow", version: 1 } as const;
const registeredAt = "2026-08-05T12:00:00.000Z";

async function fixture(
  providers: readonly AgentExecutionProviderEditorDescriptor[] | (() => Promise<readonly AgentExecutionProviderEditorDescriptor[]>) = createDefaultAgentExecutionProviderEditorDescriptors({
    piOpenAiCodexModels: [{ value: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
  }),
) {
  const store = new FileWorkflowRunConfigurationStore<RunConfigurationDefinition>(
    await mkdtemp(path.join(os.tmpdir(), "run-configuration-api-")),
  );
  const validators = new RunConfigurationDefinitionValidatorRegistry([fixtureValidator]);
  const router = createRunConfigurationRouter({
    service: new RunConfigurationApplicationService(
      store,
      validators,
      providers,
    ),
    authenticate: async (request) => request.headers.get("x-principal") === "admin"
      ? principal(["workflow:fixture.workflow:configure"])
      : principal(["runs:read-own"]),
  });
  const client = (admin = true) => new RunConfigurationApiClient({
    baseUrl: "http://configurations.test",
    requestInit: () => ({ headers: admin ? { "x-principal": "admin" } : {} }),
    fetch: (input, init) => router.request(input, init),
  });
  return { store, validators, router, client };
}

describe("Run Configuration API administration", () => {
  it("rechecks active Connections on validation and publication without changing historical configurations", async () => {
    let catalog = createDefaultAgentExecutionProviderEditorDescriptors({ piOpenAiCodexModels: [{ value: "gpt-5.6-luna", label: "Luna" }] })
      .map((provider) => ({ ...provider, connectionDriven: true }));
    const test = await fixture(async () => catalog);
    const admin = test.client();
    const input = definition("fixture-connection-v1", 1, piPolicy());
    const published = await admin.publishDefinition(workflow, { definition: input });
    catalog = catalog.map((provider) => ({ ...provider, authProviderOptions: [] }));
    for (const method of ["validateDefinition", "publishDefinition"] as const) {
      await expect(admin[method](workflow, { definition: definition("fixture-connection-v2", 1, piPolicy()) })).rejects.toMatchObject({ status: 400 });
    }
    await expect(admin.getDefinition(workflow, "fixture-connection-v1")).resolves.toEqual(published);
    catalog = [];
    await expect(admin.publishDefinition(workflow, { definition: definition("fixture-connection-v3", 1, piPolicy()) })).rejects.toMatchObject({ status: 400 });
    expect((await test.store.list(workflow)).items).toHaveLength(1);
  });

  it("requires the workflow configure permission for validation, publication, reads, and comparison", async () => {
    const reader = (await fixture()).client(false);
    await expect(reader.listDefinitions(workflow)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.validateDefinition(workflow, { definition: definition("fixture-v1", 1) }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.publishDefinition(workflow, { definition: definition("fixture-v1", 1) }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.compareDefinitions(workflow, { configurationIds: ["fixture-v1", "fixture-v2"] }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.archiveDefinition(workflow, "fixture-v1"))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.restoreDefinition(workflow, "fixture-v1"))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("validates and publishes canonical immutable definitions", async () => {
    const admin = (await fixture()).client();
    const input = definition("fixture-v1", 1);
    const validated = await admin.validateDefinition(workflow, { definition: input });
    expect(validated.definition).toMatchObject({ configurationId: "fixture-v1", workflow });
    expect(validated.definition.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const published = await admin.publishDefinition(workflow, { definition: input });
    expect(published.definition).toEqual({
      ...validated.definition,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    await expect(admin.publishDefinition(workflow, { definition: input })).resolves.toEqual(published);
    await expect(admin.publishDefinition(workflow, { definition: definition("fixture-v1", 2) }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("rejects unknown workflows, secrets, and executable plugin paths before persistence", async () => {
    const test = await fixture();
    const admin = test.client();
    await expect(admin.validateDefinition(workflow, {
      definition: { ...definition("fixture-v1", 1), workflow: { kind: "unknown.workflow", version: 1 } },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.publishDefinition(workflow, {
      definition: { ...definition("fixture-secret-v1", 1), options: { apiKey: "must-not-persist" } },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.publishDefinition(workflow, {
      definition: { ...definition("fixture-plugin-v1", 1), options: { pluginPath: "/tmp/plugin.js" } },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    expect((await test.store.list(workflow)).items).toEqual([]);
  });

  it("rejects provider, authentication, and model combinations outside the installed provider contract", async () => {
    const admin = (await fixture()).client();
    await expect(admin.validateDefinition(workflow, {
      definition: definition("fixture-pi-v1", 1, piPolicy()),
    })).resolves.toMatchObject({ definition: { configurationId: "fixture-pi-v1" } });
    await expect(admin.validateDefinition(workflow, {
      definition: definition("fixture-auth-v1", 1, piPolicy({ authProvider: "openai-api-key" })),
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.validateDefinition(workflow, {
      definition: definition("fixture-provider-v1", 1, piPolicy({ modelProvider: "anthropic" })),
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(admin.validateDefinition(workflow, {
      definition: definition("fixture-model-v1", 1, piPolicy({ model: "unknown-model" })),
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
  });

  it("requires an authentication provider's model provider", async () => {
    const descriptors = createDefaultAgentExecutionProviderEditorDescriptors({
      piModelCatalogs: {
        "openai-codex": [{ value: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
        openai: [{ value: "gpt-4.1-mini", label: "GPT-4.1 mini" }],
      },
    }).map((provider) => provider.providerId === "pi-cli" ? {
      ...provider,
      authProviderOptions: [
        ...(provider.authProviderOptions ?? []),
        { value: "arkimux-dev-key", label: "ArkiMux development key", modelProvider: "openai" },
      ],
    } : provider);
    const admin = (await fixture(descriptors)).client();
    await expect(admin.validateDefinition(workflow, {
      definition: definition("fixture-apikey-v1", 1, piPolicy({
        authProvider: "arkimux-dev-key",
        modelProvider: "openai",
        model: "gpt-4.1-mini",
      })),
    })).resolves.toMatchObject({ definition: { configurationId: "fixture-apikey-v1" } });
    await expect(admin.validateDefinition(workflow, {
      definition: definition("fixture-invalid-v1", 1, piPolicy({
        authProvider: "arkimux-dev-key",
        modelProvider: "openai-codex",
      })),
    })).rejects.toMatchObject({
      status: 400,
      code: "invalid-request",
      message: expect.stringContaining("requires model provider openai"),
    });
  });

  it("paginates, resolves, compares, and redacts stored definitions", async () => {
    const test = await fixture();
    await test.store.publish({ ...definition("fixture-v1", 1), options: { authorizationToken: "stored-legacy" } });
    await test.store.publish(definition("fixture-v2", 2));
    const admin = test.client();
    const first = await admin.listDefinitions(workflow, { pageSize: 1 });
    expect(first.items[0]).toMatchObject({
      configurationId: "fixture-v1",
      redactedDefinition: { options: { authorizationToken: "[REDACTED]" } },
    });
    expect(first.pagination.nextCursor).toBe("fixture-v1");
    await expect(admin.listDefinitions(workflow, { pageSize: 1, cursor: first.pagination.nextCursor }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ configurationId: "fixture-v2" })] });
    await expect(admin.getDefinition(workflow, "fixture-v2")).resolves.toMatchObject({
      definition: { configurationId: "fixture-v2" },
    });
    await expect(admin.getDefinition(workflow, "missing-v1")).rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(admin.compareDefinitions(workflow, { configurationIds: ["fixture-v1", "fixture-v2"] }))
      .resolves.toMatchObject({ items: [
        expect.objectContaining({ configurationId: "fixture-v1" }),
        expect.objectContaining({ configurationId: "fixture-v2" }),
      ] });
  });

  it("archives custom definitions without changing historical resolution and restores them", async () => {
    const test = await fixture();
    await test.store.publish(definition("fixture-v1", 1));
    const admin = test.client();
    await expect(admin.archiveDefinition(workflow, "fixture-v1")).resolves.toMatchObject({
      definition: { configurationId: "fixture-v1", lifecycleStatus: "archived" },
    });
    await expect(admin.listDefinitions(workflow)).resolves.toMatchObject({ items: [] });
    await expect(admin.listDefinitions(workflow, { lifecycleStatus: "archived" })).resolves.toMatchObject({
      items: [expect.objectContaining({ configurationId: "fixture-v1", lifecycleStatus: "archived" })],
    });
    await expect(admin.getDefinition(workflow, "fixture-v1")).resolves.toMatchObject({
      definition: { lifecycleStatus: "archived" },
    });
    await expect(admin.restoreDefinition(workflow, "fixture-v1")).resolves.toMatchObject({
      definition: { lifecycleStatus: "active" },
    });
    await expect(admin.listDefinitions(workflow)).resolves.toMatchObject({
      items: [expect.objectContaining({ configurationId: "fixture-v1" })],
    });
  });
});

const fixtureValidator = {
  workflow,
  validate(value: unknown, expectedConfigurationId?: string): RunConfigurationDefinition {
    const parsed = z.object({
      schemaVersion: z.literal(1),
      configurationId: z.string().regex(/^fixture(?:-[a-z]+)?-v[1-9][0-9]*$/),
      workflow: z.object({ kind: z.literal(workflow.kind), version: z.literal(workflow.version) }).strict(),
      value: z.number().int(),
      options: z.record(z.string(), z.unknown()).optional(),
      agents: z.record(z.string(), z.unknown()).optional(),
    }).strict().parse(value);
    if (expectedConfigurationId !== undefined && parsed.configurationId !== expectedConfigurationId) {
      throw new Error(`Expected ${expectedConfigurationId}.`);
    }
    return parsed;
  },
};

function definition(configurationId: string, value: number, agents?: Record<string, unknown>) {
  return { schemaVersion: 1, configurationId, workflow, value, ...(agents ? { agents } : {}) };
}

function piPolicy(overrides: {
  authProvider?: string;
  modelProvider?: string;
  model?: string;
} = {}) {
  return {
    author: {
      timeoutMs: 300_000,
      execution: {
        provider: "pi-cli",
        authProvider: overrides.authProvider ?? "pi-openai-codex-session",
        parameters: {
          provider: overrides.modelProvider ?? "openai-codex",
          model: overrides.model ?? "gpt-5.6-luna",
          thinking: "high",
        },
      },
    },
  };
}

function principal(permissions: string[]): AuthorizedApplicationPrincipal {
  return {
    user: {
      schemaVersion: 1,
      userId: "admin",
      status: "active",
      identity: { providerId: "fixture", subjectId: "admin" },
      registeredAt,
    },
    roles: [{ schemaVersion: 1, roleId: "admin-role", permissions }],
    permissions,
  };
}
