import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedAgentProviderConfig } from "../../core/src/infrastructure/agents/agentProviderConfigProvider.ts";
import { createAgentAuthProviderRegistry } from "../../core/src/infrastructure/agents/agentAuthProvider.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-auth-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

function providerConfig(
  parentHome: string,
  authProviders: ResolvedAgentProviderConfig["authProviders"],
): ResolvedAgentProviderConfig {
  return {
    schemaVersion: 1,
    executionProviders: {
      "codex-cli": {
        command: "codex",
        heartbeatIntervalMs: 15_000,
        environmentAllowlist: ["PATH", "TMPDIR"],
        parentHome,
      },
      "pi-cli": {
        command: "pi",
        heartbeatIntervalMs: 15_000,
        environmentAllowlist: ["PATH", "TMPDIR"],
        offline: true,
        telemetry: false,
        versionCheck: false,
      },
      "claude-code-cli": { command: "claude", heartbeatIntervalMs: 15_000, environmentAllowlist: ["PATH", "TMPDIR"] },
      "kimi-code-cli": { command: "kimi", heartbeatIntervalMs: 15_000, environmentAllowlist: ["PATH", "TMPDIR"] },
    },
    authProviders,
    legacyEnvironmentOverrides: [],
  };
}

const context = {
  cwd: "/fixture/repository",
  executionProviderId: "codex-cli",
  modelProvider: "openai",
  model: "gpt-5.6-luna",
};

describe("agent authentication providers", () => {
  it("preflights and prepares an existing native runtime session", async () => {
    const parentHome = await temporaryDirectory();
    const command = path.join(parentHome, "codex");
    await fs.writeFile(path.join(parentHome, "auth.json"), "{}\n", "utf8");
    await fs.writeFile(command, [
      "#!/bin/sh",
      "[ \"$1 $2\" = \"login status\" ] || exit 1",
      "[ \"$CODEX_HOME\" = \"$EXPECTED_CODEX_HOME\" ] || exit 1",
      "printf '%s\\n' 'Logged in using ChatGPT'",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(parentHome, {
      "codex-native-session": { kind: "runtime-native", runtime: "codex-cli" },
    });
    config.executionProviders["codex-cli"].command = command;
    const registry = createAgentAuthProviderRegistry(config, {
      EXPECTED_CODEX_HOME: parentHome,
    });
    const codexContext = {
      ...context,
      cwd: parentHome,
      executable: { path: command, version: "codex-cli 0.0.0-test" },
    };

    await expect(registry.get("codex-native-session").preflight(codexContext)).resolves.toMatchObject({
      available: true,
      status: "indeterminate",
      kind: "runtime-native",
      identity: { authMethod: "chatgpt" },
      executable: { path: command, version: "codex-cli 0.0.0-test" },
      message: expect.stringContaining("eligibility will be confirmed when execution starts"),
    });
    const prepared = await registry.get("codex-native-session").prepare(codexContext);
    expect(prepared.credentialDirectory).toBe(parentHome);
    expect(prepared.environment).toEqual({});
    await prepared.dispose();
  });

  it("blocks a Codex runtime-native provider when the selected CLI reports no session", async () => {
    const root = await temporaryDirectory();
    const command = path.join(root, "codex");
    await fs.writeFile(command, [
      "#!/bin/sh",
      "[ \"$1 $2\" = \"login status\" ] || exit 1",
      "printf '%s\\n' 'Not logged in' >&2",
      "exit 1",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(root, {
      "codex-native-session": { kind: "runtime-native", runtime: "codex-cli" },
    });
    config.executionProviders["codex-cli"].command = command;
    const registry = createAgentAuthProviderRegistry(config, {});

    await expect(registry.get("codex-native-session").preflight({
      ...context,
      cwd: root,
      executable: { path: command },
    })).resolves.toMatchObject({
      available: false,
      status: "unavailable",
      reason: "session-missing",
      remediation: expect.arrayContaining([
        expect.objectContaining({ kind: "login" }),
        expect.objectContaining({ kind: "configure-api-key" }),
      ]),
    });
  });

  it("maps only the selected environment credential into the target variable", async () => {
    const parentHome = await temporaryDirectory();
    const registry = createAgentAuthProviderRegistry(providerConfig(parentHome, {
      "openai-api-key": {
        kind: "environment",
        sourceVariable: "SOURCE_OPENAI_KEY",
        targetVariable: "OPENAI_API_KEY",
      },
    }), {
      SOURCE_OPENAI_KEY: "selected-secret",
      UNRELATED_SECRET: "must-not-be-forwarded",
    });

    const prepared = await registry.get("openai-api-key").prepare(context);
    expect(prepared.environment).toEqual({ OPENAI_API_KEY: "selected-secret" });
    expect(prepared.environment).not.toHaveProperty("UNRELATED_SECRET");
    await prepared.dispose();
    expect(prepared.environment).toEqual({});
  });

  it("retrieves a credential from a fixed helper without exposing helper details", async () => {
    const parentHome = await temporaryDirectory();
    const registry = createAgentAuthProviderRegistry(providerConfig(parentHome, {
      "openai-helper": {
        kind: "command",
        command: "/usr/bin/printf",
        args: ["helper-secret"],
        targetVariable: "OPENAI_API_KEY",
      },
    }), process.env);

    const prepared = await registry.get("openai-helper").prepare({ ...context, cwd: parentHome });
    expect(prepared.environment).toEqual({ OPENAI_API_KEY: "helper-secret" });
    await prepared.dispose();
    expect(prepared.environment).toEqual({});
  });

  it("preflights a Claude Code native session through the runtime CLI", async () => {
    const root = await temporaryDirectory();
    const command = path.join(root, "claude");
    await fs.writeFile(command, [
      "#!/bin/sh",
      "[ \"$1 $2\" = \"auth status\" ] || exit 1",
      "printf '%s\\n' '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(root, {
      "claude-code-native-session": { kind: "runtime-native", runtime: "claude-code-cli", modelProvider: "anthropic" },
    });
    config.executionProviders["claude-code-cli"].command = command;
    const registry = createAgentAuthProviderRegistry(config, { PATH: process.env.PATH });
    await expect(registry.get("claude-code-native-session").preflight({
      cwd: root,
      executionProviderId: "claude-code-cli",
      modelProvider: "anthropic",
    })).resolves.toMatchObject({ available: true, kind: "runtime-native" });
  });

  it("rejects a zero-exit Claude auth status when the session is logged out", async () => {
    const root = await temporaryDirectory();
    const command = path.join(root, "claude");
    await fs.writeFile(command, [
      "#!/bin/sh",
      "[ \"$1 $2\" = \"auth status\" ] || exit 1",
      "printf '%s\\n' '{\"loggedIn\":false,\"authMethod\":\"none\"}'",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(root, {
      "claude-code-native-session": { kind: "runtime-native", runtime: "claude-code-cli", modelProvider: "anthropic" },
    });
    config.executionProviders["claude-code-cli"].command = command;
    const registry = createAgentAuthProviderRegistry(config, { PATH: process.env.PATH });
    await expect(registry.get("claude-code-native-session").preflight({
      cwd: root,
      executionProviderId: "claude-code-cli",
      modelProvider: "anthropic",
    })).resolves.toMatchObject({
      available: false,
      status: "unavailable",
      reason: "session-missing",
      identity: { authMethod: "none" },
      kind: "runtime-native",
      message: expect.stringContaining("Run /login inside Claude Code"),
    });
  });

  it("reports a Claude Free session as advisory until execution confirms eligibility", async () => {
    const root = await temporaryDirectory();
    const command = path.join(root, "claude");
    await fs.writeFile(command, [
      "#!/bin/sh",
      "[ \"$1 $2\" = \"auth status\" ] || exit 1",
      "printf '%s\\n' '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"developer@example.com\",\"subscriptionType\":\"free\"}'",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(root, {
      "claude-code-native-session": { kind: "runtime-native", runtime: "claude-code-cli", modelProvider: "anthropic" },
    });
    const registry = createAgentAuthProviderRegistry(config, { PATH: process.env.PATH });
    await expect(registry.get("claude-code-native-session").preflight({
      cwd: root,
      executionProviderId: "claude-code-cli",
      modelProvider: "anthropic",
      executable: { path: command, version: "2.1.241" },
    })).resolves.toMatchObject({
      available: true,
      status: "indeterminate",
      identity: {
        authMethod: "claude.ai",
        accountEmail: "developer@example.com",
        reportedPlan: "free",
      },
      executable: { path: command, version: "2.1.241" },
      remediation: expect.arrayContaining([
        expect.objectContaining({ kind: "upgrade" }),
        expect.objectContaining({ kind: "configure-api-key" }),
      ]),
    });
  });

  it("preflights and prepares a Kimi Code native session through the runtime CLI", async () => {
    const root = await temporaryDirectory();
    const kimiHome = path.join(root, "kimi-home");
    const command = path.join(root, "kimi");
    await fs.writeFile(command, [
      "#!/bin/sh",
      "[ \"$1 $2 $3\" = \"provider list --json\" ] || exit 1",
      "[ \"$KIMI_CODE_HOME\" = \"$EXPECTED_KIMI_HOME\" ] || exit 1",
      "printf '%s\\n' '{\"providers\":{\"managed:kimi-code\":{}},\"models\":{}}'",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(root, {
      "kimi-code-native-session": { kind: "runtime-native", runtime: "kimi-code-cli", modelProvider: "kimi" },
    });
    config.executionProviders["kimi-code-cli"].command = command;
    config.executionProviders["kimi-code-cli"].parentHome = kimiHome;
    const registry = createAgentAuthProviderRegistry(config, {
      PATH: process.env.PATH,
      EXPECTED_KIMI_HOME: kimiHome,
    });
    const context = { cwd: root, executionProviderId: "kimi-code-cli" as const, modelProvider: "kimi" };
    await expect(registry.get("kimi-code-native-session").preflight(context))
      .resolves.toMatchObject({ available: true, kind: "runtime-native" });
    await expect(registry.get("kimi-code-native-session").prepare(context))
      .resolves.toMatchObject({ credentialDirectory: kimiHome, environment: {} });
  });
});
