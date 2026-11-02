import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthorizedApplicationPrincipal } from "../../apps/packages/application-host/src/index.ts";
import { AgentAuthenticationApplicationService, createAgentAuthenticationRouter } from "../../apps/packages/agent-authentication/api/src/index.ts";
import { AgentAuthenticationApiClient, agentAuthProbeResultSchema } from "../../apps/packages/agent-authentication/contract/src/index.ts";
import { nativeConnectionPresets } from "@com-pyvue/agent-execution-core/internal/application/nativeConnectionCatalog.ts";
import { ExecutionAgentAuthConnectionProbe } from "@com-pyvue/agent-execution-core/internal/infrastructure/agents/agentAuthConnectionProbe.ts";
import {
  ExternalProviderError,
  FileAgentAuthProviderStore,
  FilePlaintextAgentCredentialStore,
  validateAgentAuthProbeResult,
  type AgentAuthConnectionProbe,
  type ResolvedAgentProviderConfig,
} from "@com-pyvue/agent-execution-core";

async function fixture(options: { pinned?: boolean; allCandidates?: boolean; nativeOnly?: boolean; localV2?: boolean; connectionProbe?: AgentAuthConnectionProbe } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-authentication-api-"));
  const providers = new FileAgentAuthProviderStore(path.join(root, "providers"));
  const credentials = new FilePlaintextAgentCredentialStore(path.join(root, "credentials"));
  const router = createAgentAuthenticationRouter({
    service: new AgentAuthenticationApplicationService(providers, credentials, {
      providerConfig: (() => {
        const config = fixtureProviderConfig();
        if (options.pinned) for (const preset of nativeConnectionPresets) config.executionProviders[preset.executionProviderId].requiredVersion = preset.requiredVersion;
        return config;
      })(),
      nativeSessionsOnly: options.nativeOnly,
      localV2Connections: options.localV2,
      ...(options.allCandidates ? { nativeSetupEvidence: nativeConnectionPresets } : {}),
      connectionProbe: options.connectionProbe ?? fixtureConnectionProbe,
    }),
    authenticate: async (request) => principal(request.headers.get("x-admin") === "yes" ? ["agent-auth-providers:admin"] : ["runs:read-own"]),
  });
  const client = (admin = true) => new AgentAuthenticationApiClient({
    baseUrl: "http://authentication.test",
    requestInit: () => ({ headers: admin ? { "x-admin": "yes" } : {} }),
    fetch: (input, init) => router.request(input, init),
  });
  return { root, client };
}

describe("Agent Authentication API", () => {
  it("returns and persists an actionable redacted failure through the real probe boundary", async () => {
    const message = "Error: transport disconnected [retryable].\napi_key=private-key\nRetry after 42 seconds. Help: https://provider.example/help";
    const connectionProbe = failingConnectionProbe(new ExternalProviderError("codex-cli", message, {
      code: "transport_disconnected", httpStatus: 503, secretValues: ["private-key"],
    }));
    const admin = (await fixture({ connectionProbe })).client();
    const { probe } = await admin.probe("codex-native-session");
    expect(probe).toMatchObject({ status: "failed", message: message.replace("private-key", "[redacted]") });
    expect(probe.externalDiagnostic).toEqual({ origin: "external", provider: "codex-cli", code: "transport_disconnected", httpStatus: 503, message: probe.message });
    const stored = (await admin.list()).items.find((item) => item.authProviderId === probe.authProviderId)?.latestProbe;
    expect(stored).toEqual(probe);
    expect(JSON.stringify(stored)).not.toMatch(/private-key|\/private\/|thread.started/);
  });

  it("roundtrips a multiline provider explanation longer than 1000 characters without truncating", async () => {
    const message = '\n  Rate limit [requests_per_minute] exceeded.\n' + 'Retry after 42 seconds. Choose {"model":"small"}.\n'.repeat(60)
      + "Help: https://provider.example/help\nrequest_id=public-123\n";
    expect(message.length).toBeGreaterThan(1000);
    const connectionProbe = failingConnectionProbe(new ExternalProviderError("codex-cli", message, { code: "rate_limit_exceeded", httpStatus: 429 }));
    const admin = (await fixture({ connectionProbe })).client();
    const { probe } = await admin.probe("codex-native-session");
    expect(probe).toMatchObject({ status: "failed", message });
    expect(probe.externalDiagnostic).toEqual({ origin: "external", provider: "codex-cli", code: "rate_limit_exceeded", httpStatus: 429, message });
    expect((await admin.list()).items.find((item) => item.authProviderId === probe.authProviderId)?.latestProbe).toEqual(probe);
  });

  it("returns and persists a friendly message for an unknown internal probe error", async () => {
    const connectionProbe = failingConnectionProbe(new TypeError("private implementation /private/probe/events.jsonl api_key=private-key"));
    const admin = (await fixture({ connectionProbe })).client();
    const { probe } = await admin.probe("codex-native-session");
    expect(probe).toMatchObject({ status: "failed", message: "The connection check failed inside ArkiMux. Retry the check; if it persists, inspect the local server diagnostics." });
    expect(probe).not.toHaveProperty("externalDiagnostic");
    const stored = (await admin.list()).items.find((item) => item.authProviderId === probe.authProviderId)?.latestProbe;
    expect(stored).toEqual(probe);
    expect(JSON.stringify(stored)).not.toMatch(/private-key|\/private\/|private implementation|TypeError/);
  });

  it("scrubs the probe environment credential from both public message and diagnostic metadata", async () => {
    const connectionProbe = failingConnectionProbe(new ExternalProviderError("codex-cli", "Rejected opaque-probe-key. Retry after 42 seconds.", {
      code: "provider_error_opaque-probe-key", httpStatus: 401,
    }), { PROVIDER_TOKEN: "opaque-probe-key" });
    const admin = (await fixture({ connectionProbe })).client();
    const { probe } = await admin.probe("codex-native-session");
    expect(probe.message).toBe("Rejected [redacted]. Retry after 42 seconds.");
    expect(probe.externalDiagnostic).toEqual({ origin: "external", provider: "codex-cli", code: "provider_error_[redacted]", httpStatus: 401, message: probe.message });
    const stored = (await admin.list()).items.find((item) => item.authProviderId === probe.authProviderId)?.latestProbe;
    expect(stored).toEqual(probe);
    expect(JSON.stringify(stored)).not.toContain("opaque-probe-key");
  });

  it("accepts old probe records and validates/copies only public diagnostic fields", () => {
    const probe = { schemaVersion: 1, authProviderId: "codex-native-session", checkedAt: "2026-09-15T12:00:00.000Z", status: "failed", mechanism: "minimal-inference", latencyMs: 1, message: "Retry after 42 seconds." };
    for (const parse of [validateAgentAuthProbeResult, agentAuthProbeResultSchema.parse]) {
      expect(parse(probe)).toEqual(probe);
      const externalDiagnostic = { origin: "external", provider: "codex-cli", message: probe.message, code: "quota_exceeded", httpStatus: 429 };
      expect(parse({ ...probe, externalDiagnostic: { ...externalDiagnostic, stack: "private stack", cause: "private cause" } })).toEqual({ ...probe, externalDiagnostic });
      for (const invalid of [null, { ...externalDiagnostic, origin: "internal" }, { ...externalDiagnostic, httpStatus: 600 }, { ...externalDiagnostic, code: 401 }]) {
        expect(() => parse({ ...probe, externalDiagnostic: invalid })).toThrow();
      }
    }
  });

  it.each(nativeConnectionPresets)("creates, probes, archives and restores $label without a Credential", async (preset) => {
    const admin = (await fixture({ pinned: true, allCandidates: true, nativeOnly: true })).client();
    const definition = { schemaVersion: 2 as const, authProviderId: `my-${preset.presetId}`, displayName: preset.label,
      kind: "runtime-native" as const, executionProviderId: preset.executionProviderId, modelProvider: preset.modelProvider };
    const created = await admin.create({ definition });
    expect(created.provider.definition).toEqual(definition);
    expect((await admin.listCredentials()).items).toEqual([]);
    expect((await admin.preflight(definition.authProviderId)).available).toBe(false);
    expect((await admin.list()).items.find(item => item.authProviderId === definition.authProviderId)).toMatchObject({ kind: "runtime-native", origin: "user", loginRequirement: { instruction: preset.loginInstruction } });
    expect((await admin.probe(definition.authProviderId)).probe.status).toBe("connected");
    await admin.archive(definition.authProviderId);
    await expect(admin.probe(definition.authProviderId)).rejects.toMatchObject({ status: 400 });
    await admin.restore(definition.authProviderId);
    expect((await admin.probe(definition.authProviderId)).probe.status).toBe("connected");
  });

  it("admits only matching pinned setup evidence and refuses hidden types or native secret fields", async () => {
    const admin = (await fixture({ pinned: true, nativeOnly: true })).client();
    const metadata = await admin.metadata();
    expect(metadata.nativeSessionPresets.map(preset => preset.presetId)).toEqual(["codex-native", "claude-native", "pi-codex"]);
    expect(metadata.authProviderPresets).toEqual([]);
    expect(metadata.credentialPresets).toEqual([]);
    expect((await admin.list()).items.some(item => item.executionProviderId === "claude-code-cli")).toBe(true);
    await expect(admin.create({ definition: { schemaVersion: 2, authProviderId: "unproven", displayName: "Unproven", kind: "runtime-native", executionProviderId: "pi-cli", modelProvider: "anthropic" } })).rejects.toMatchObject({ status: 400 });
    const raw = { schemaVersion: 2 as const, authProviderId: "with-secret", displayName: "Bad", kind: "runtime-native" as const, executionProviderId: "codex-cli" as const, modelProvider: "openai", credentialId: "not-allowed" };
    expect(() => admin.create({ definition: raw })).toThrow();
    expect((await (await fixture()).client().metadata()).nativeSessionPresets).toEqual([]);
    await expect(admin.create({ definition: { schemaVersion: 2, authProviderId: "codex-native-session", displayName: "Collision", kind: "runtime-native", executionProviderId: "codex-cli", modelProvider: "openai" } })).rejects.toMatchObject({ status: 409 });
  });

  it("admits only the proven Pi Anthropic key tuple in Local V2 and preserves native admission", async () => {
    const admin = (await fixture({ pinned: true, localV2: true })).client();
    const metadata = await admin.metadata();
    expect(metadata.authProviderPresets.map(item => item.presetId)).toEqual(["pi-anthropic-api-key"]);
    expect(metadata.credentialPresets.map(item => item.modelProvider)).toEqual(["anthropic"]);
    expect(metadata.nativeSessionPresets.map(item => item.presetId)).toEqual(["codex-native", "claude-native", "pi-codex"]);
    await admin.createCredential({ definition: { schemaVersion: 1, credentialId: "test-key", displayName: "Test", kind: "api-key", modelProvider: "anthropic" }, credential: "synthetic-test-secret" });
    const definition = { schemaVersion: 2 as const, authProviderId: "test-pi", displayName: "Test Pi", kind: "stored-credential" as const, executionProviderId: "pi-cli" as const, modelProvider: "anthropic", credentialId: "test-key", targetVariable: "ANTHROPIC_API_KEY" };
    await admin.create({ definition });
    const beforeProbe = (await admin.list()).items.find(item => item.authProviderId === "test-pi");
    expect(beforeProbe).toMatchObject({ kind: "stored-credential", credentialId: "test-key" });
    expect(beforeProbe?.latestProbe).toBeUndefined();
    expect((await admin.probe("test-pi")).probe.status).toBe("connected");
    await admin.archive("test-pi");
    await expect(admin.probe("test-pi")).rejects.toMatchObject({ status: 400 });
    await admin.restore("test-pi");
    await expect(admin.create({ definition: { ...definition, authProviderId: "wrong-runtime", executionProviderId: "claude-code-cli" } })).rejects.toMatchObject({ status: 400 });
    await expect(admin.create({ definition: { ...definition, authProviderId: "wrong-variable", targetVariable: "OTHER_KEY" } })).rejects.toMatchObject({ status: 400 });
    await expect(admin.createCredential({ definition: { schemaVersion: 1, credentialId: "wrong-key", displayName: "Wrong", kind: "api-key", modelProvider: "openai" }, credential: "synthetic" })).rejects.toMatchObject({ status: 400 });
    expect(JSON.stringify(await admin.listCredentials())).not.toContain("synthetic-test-secret");
    const unpinned = (await fixture({ localV2: true })).client();
    expect((await unpinned.metadata()).authProviderPresets).toEqual([]);
    await expect(unpinned.create({ definition })).rejects.toMatchObject({ status: 400 });
  });

  it("writes and rotates API keys without ever returning them", async () => {
    const { root, client } = await fixture();
    const admin = client();
    const credential = await admin.createCredential({
      definition: {
        schemaVersion: 1,
        credentialId: "personal-openai-key",
        displayName: "Personal OpenAI key",
        kind: "api-key",
        modelProvider: "openai",
      },
      credential: "first-secret",
    });
    const created = await admin.create({
      definition: {
        schemaVersion: 2,
        authProviderId: "personal-openai",
        displayName: "Personal OpenAI",
        kind: "stored-credential",
        executionProviderId: "pi-cli",
        modelProvider: "openai",
        credentialId: "personal-openai-key",
        targetVariable: "OPENAI_API_KEY",
      },
    });
    expect(JSON.stringify(credential)).not.toContain("first-secret");
    expect(JSON.stringify(created)).not.toContain("first-secret");
    expect(await readFile(path.join(root, "credentials", "values", "personal-openai-key.key"), "utf8")).toBe("first-secret");
    const rotated = await admin.replaceCredential("personal-openai-key", { credential: "second-secret" });
    expect(JSON.stringify(rotated)).not.toContain("second-secret");
    expect(await readFile(path.join(root, "credentials", "values", "personal-openai-key.key"), "utf8")).toBe("second-secret");
    await expect(admin.preflight("personal-openai")).resolves.toMatchObject({ available: true });
    await expect(admin.archive("personal-openai")).resolves.toMatchObject({ provider: { lifecycleStatus: "archived" } });
    await expect(admin.preflight("personal-openai")).resolves.toMatchObject({ available: false });
    await expect(admin.restore("personal-openai")).resolves.toMatchObject({ provider: { lifecycleStatus: "active" } });
  });

  it("requires the dedicated administration permission", async () => {
    const reader = (await fixture()).client(false);
    await expect(reader.list()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.metadata()).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("merges platform native sessions with user configurations and persists safe probe metadata", async () => {
    const admin = (await fixture()).client();
    const initial = await admin.list();
    expect(initial.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        authProviderId: "claude-code-native-session",
        origin: "platform",
        kind: "runtime-native",
        loginRequirement: expect.objectContaining({ application: "Claude Code" }),
      }),
      expect.objectContaining({
        authProviderId: "codex-native-session",
        origin: "platform",
        kind: "runtime-native",
        loginRequirement: expect.objectContaining({ application: "Codex CLI" }),
      }),
    ]));

    const response = await admin.probe("claude-code-native-session");
    expect(response.probe).toMatchObject({
      authProviderId: "claude-code-native-session",
      status: "connected",
      mechanism: "minimal-inference",
      probeModel: "fixture-low-cost-model",
    });
    const afterProbe = await admin.list();
    expect(afterProbe.items.find(({ authProviderId }) => authProviderId === "claude-code-native-session")?.latestProbe)
      .toEqual(response.probe);
    expect(JSON.stringify(afterProbe)).not.toContain("secret");
  });

  it("persists a native-session probe when the runtime does not report its default model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-authentication-api-model-less-"));
    const providers = new FileAgentAuthProviderStore(path.join(root, "providers"));
    const credentials = new FilePlaintextAgentCredentialStore(path.join(root, "credentials"));
    const router = createAgentAuthenticationRouter({
      service: new AgentAuthenticationApplicationService(providers, credentials, {
        providerConfig: fixtureProviderConfig(),
        connectionProbe: {
          probe: async ({ authProviderId }) => ({
            schemaVersion: 1,
            authProviderId,
            checkedAt: "2026-08-25T10:00:00.000Z",
            status: "connected",
            mechanism: "minimal-inference",
            latencyMs: 42,
            message: "Connection succeeded through the runtime default model.",
          }),
        },
      }),
      authenticate: async () => principal(["agent-auth-providers:admin"]),
    });
    const admin = new AgentAuthenticationApiClient({
      baseUrl: "http://authentication.test",
      fetch: (input, init) => router.request(input, init),
    });

    const response = await admin.probe("codex-native-session");

    expect(response.probe).not.toHaveProperty("probeModel");
    expect((await admin.list()).items.find(({ authProviderId }) => authProviderId === "codex-native-session")?.latestProbe)
      .toEqual(response.probe);
  });

  it("keeps Pi Kimi identifiers distinct while exposing the native Kimi Code credential channel", async () => {
    const metadata = await (await fixture()).client().metadata();
    expect(metadata.authProviderPresets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        presetId: "pi-kimi-platform-api-key",
        modelProvider: "moonshotai",
        targetVariable: "MOONSHOT_API_KEY",
      }),
      expect.objectContaining({
        presetId: "pi-kimi-coding-api-key",
        modelProvider: "kimi-coding",
        targetVariable: "KIMI_API_KEY",
      }),
    ]));
    expect(metadata.authProviderPresets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        executionProviderId: "kimi-code-cli",
        modelProvider: "kimi",
        targetVariable: "KIMI_MODEL_API_KEY",
      }),
    ]));
  });

  it("rejects unsupported runtime, model-provider, and target-variable combinations", async () => {
    const admin = (await fixture()).client();
    await admin.createCredential({
      definition: { schemaVersion: 1, credentialId: "unsupported-key", displayName: "Unsupported key", kind: "api-key", modelProvider: "openai" },
      credential: "must-not-be-written",
    });
    await expect(admin.create({
      definition: {
        schemaVersion: 2,
        authProviderId: "unsupported-auth",
        displayName: "Unsupported auth",
        kind: "stored-credential",
        executionProviderId: "pi-cli",
        modelProvider: "openai",
        credentialId: "unsupported-key",
        targetVariable: "ANTHROPIC_API_KEY",
      },
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });
  });
});

function failingConnectionProbe(error: Error, environment: NodeJS.ProcessEnv = {}): AgentAuthConnectionProbe {
  return new ExecutionAgentAuthConnectionProbe({ get: () => ({
    providerId: "codex-cli",
    getConnectionProbeParameters: async () => ({ model: "fixture-probe-model", model_reasoning_effort: "low" }),
    preflight: async ({ authProviderId }) => ({ providerId: "codex-cli", available: true,
      auth: { authProviderId, kind: "runtime-native", available: true, status: "ready" } }),
    run: async () => { throw error; },
  }) }, fixtureProviderConfig(), "/private/project", environment);
}

const fixtureConnectionProbe: AgentAuthConnectionProbe = {
  probe: async (target) => ({
    schemaVersion: 1,
    authProviderId: target.authProviderId,
    checkedAt: "2026-08-25T10:00:00.000Z",
    status: "connected",
    mechanism: "minimal-inference",
    latencyMs: 42,
    probeModel: "fixture-low-cost-model",
    message: "Connection succeeded through an isolated fixture probe.",
  }),
};

function fixtureProviderConfig(): ResolvedAgentProviderConfig {
  const runtime = (command: string) => ({ command, heartbeatIntervalMs: 15_000, environmentAllowlist: ["PATH", "TMPDIR"] });
  return {
    schemaVersion: 1,
    executionProviders: {
      "codex-cli": runtime("codex"),
      "pi-cli": runtime("pi"),
      "claude-code-cli": runtime("claude"),
      "kimi-code-cli": runtime("kimi"),
    },
    authProviders: {
      "codex-native-session": { kind: "runtime-native", runtime: "codex-cli" },
      "claude-code-native-session": { kind: "runtime-native", runtime: "claude-code-cli", modelProvider: "anthropic" },
    },
    legacyEnvironmentOverrides: [],
  };
}

function principal(permissions: string[]): AuthorizedApplicationPrincipal {
  return {
    user: { schemaVersion: 1, userId: "local", status: "active", identity: { providerId: "fixture", subjectId: "local" }, registeredAt: "2026-08-22T00:00:00.000Z" },
    roles: [{ schemaVersion: 1, roleId: "local-role", permissions }],
    permissions,
  };
}
