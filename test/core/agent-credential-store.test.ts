import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileAgentAuthProviderStore,
  FilePlaintextAgentCredentialStore,
  createAgentAuthProviderRegistry,
  withStoredAgentAuthProviders,
  type ResolvedAgentProviderConfig,
} from "../../core/src/index.ts";
import {
  createLocalAgentAuthProviderRegistry,
  resolveLocalFileStorePaths,
} from "../../local/src/index.ts";

describe("local Agent Credential Store", () => {
  it("stores a write-only local credential with restrictive permissions and resolves it only at execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-credential-store-"));
    const providerStore = new FileAgentAuthProviderStore(path.join(root, "providers"));
    const credentialStore = new FilePlaintextAgentCredentialStore(path.join(root, "credentials"));
    const definition = {
      schemaVersion: 2 as const,
      authProviderId: "personal-openai",
      displayName: "Personal OpenAI",
      kind: "stored-credential" as const,
      executionProviderId: "pi-cli" as const,
      modelProvider: "openai",
      credentialId: "personal-openai-key",
      targetVariable: "OPENAI_API_KEY",
    };
    const credentialDefinition = { schemaVersion: 1 as const, credentialId: definition.credentialId, displayName: "Personal OpenAI key", kind: "api-key" as const, modelProvider: "openai" };
    await providerStore.create(definition);
    await credentialStore.create(credentialDefinition, "local-secret-value");

    const credentialPath = path.join(root, "credentials", "values", "personal-openai-key.key");
    expect(await readFile(credentialPath, "utf8")).toBe("local-secret-value");
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(credentialPath))).mode & 0o777).toBe(0o700);
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(await providerStore.get(definition.authProviderId))).not.toContain("local-secret-value");

    const registry = createAgentAuthProviderRegistry(
      withStoredAgentAuthProviders(providerConfig(), [definition]),
      { PATH: process.env.PATH },
      credentialStore,
    );
    const context = { cwd: root, executionProviderId: "pi-cli", modelProvider: "openai" };
    await expect(registry.get("personal-openai").preflight(context)).resolves.toMatchObject({ available: true });
    const prepared = await registry.get("personal-openai").prepare(context);
    expect(prepared.environment).toEqual({ OPENAI_API_KEY: "local-secret-value" });
    await prepared.dispose();
    expect(prepared.environment).toEqual({});
  });

  it("discovers providers created after the local registry starts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-credential-registry-"));
    const paths = resolveLocalFileStorePaths(root);
    const registry = await createLocalAgentAuthProviderRegistry({
      repositoryRoot: root,
      providerConfig: providerConfig(),
      environment: { PATH: process.env.PATH },
    });
    const providerStore = new FileAgentAuthProviderStore(paths.agentAuthProviders);
    const credentialStore = new FilePlaintextAgentCredentialStore(paths.credentials);
    const definition = {
      schemaVersion: 2 as const,
      authProviderId: "late-openai",
      displayName: "Late OpenAI",
      kind: "stored-credential" as const,
      executionProviderId: "pi-cli" as const,
      modelProvider: "openai",
      credentialId: "late-openai-key",
      targetVariable: "OPENAI_API_KEY",
    };
    await providerStore.create(definition);
    await credentialStore.create({ schemaVersion: 1, credentialId: definition.credentialId, displayName: "Late OpenAI key", kind: "api-key", modelProvider: "openai" }, "late-secret");

    const context = { cwd: root, executionProviderId: "pi-cli", modelProvider: "openai" };
    const availability = await registry.get(definition.authProviderId).preflight(context);
    expect(availability, availability.message).toMatchObject({ available: true });
    const prepared = await registry.get(definition.authProviderId).prepare(context);
    expect(prepared.environment).toEqual({ OPENAI_API_KEY: "late-secret" });
  });

  it("persists only the latest safe connection-probe metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-auth-probe-store-"));
    const providerStore = new FileAgentAuthProviderStore(path.join(root, "providers"));
    const probe = {
      schemaVersion: 1 as const,
      authProviderId: "claude-code-native-session",
      checkedAt: "2026-08-25T10:00:00.000Z",
      status: "connected" as const,
      mechanism: "minimal-inference" as const,
      latencyMs: 321,
      probeModel: "haiku",
      message: "Connection succeeded through an isolated minimal inference request.",
    };

    await providerStore.recordProbe(probe);

    await expect(providerStore.getLatestProbe(probe.authProviderId)).resolves.toEqual(probe);
    expect(await readFile(path.join(root, "providers", probe.authProviderId, "latest-probe.json"), "utf8"))
      .not.toContain("credential");
    await expect(providerStore.list({ lifecycleStatus: "all" })).resolves.toEqual({ items: [] });
  });
});

function providerConfig(): ResolvedAgentProviderConfig {
  return {
    schemaVersion: 1,
    executionProviders: {
      "codex-cli": { command: "codex", heartbeatIntervalMs: 1000, environmentAllowlist: ["PATH"] },
      "pi-cli": { command: "pi", heartbeatIntervalMs: 1000, environmentAllowlist: ["PATH"] },
      "claude-code-cli": { command: "claude", heartbeatIntervalMs: 1000, environmentAllowlist: ["PATH"] },
      "kimi-code-cli": { command: "kimi", heartbeatIntervalMs: 1000, environmentAllowlist: ["PATH"] },
    },
    authProviders: {},
    legacyEnvironmentOverrides: [],
  };
}
