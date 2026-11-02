import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentProviderConfigProvider,
  redactAgentProviderConfig,
} from "../../core/src/infrastructure/agents/agentProviderConfigProvider.ts";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.resolve(
  testRoot,
  "../../core/config/agent-providers.default.json",
);
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-provider-config-"));
  directories.push(directory);
  return directory;
}

async function writeConfig(directory: string, value: unknown): Promise<string> {
  const filePath = path.join(directory, "agent-providers.json");
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("agent provider configuration", () => {
  it("loads bundled Codex, Pi, Claude Code, Kimi Code, and credential-reference defaults", async () => {
    const provider = await createAgentProviderConfigProvider({
      defaultConfigPath,
      environment: {},
    });

    await expect(provider.resolve()).resolves.toEqual(expect.objectContaining({
      schemaVersion: 1,
      executionProviders: {
        "codex-cli": expect.objectContaining({ command: "codex", heartbeatIntervalMs: 15_000 }),
        "pi-cli": expect.objectContaining({ command: "pi", offline: true, telemetry: false }),
        "claude-code-cli": expect.objectContaining({ command: "claude", requiredVersion: "2.1.241" }),
        "kimi-code-cli": expect.objectContaining({ command: "kimi", requiredVersion: "0.38.0" }),
      },
      authProviders: expect.objectContaining({
        "codex-native-session": { kind: "runtime-native", runtime: "codex-cli" },
        "openai-api-key": {
          kind: "environment",
          sourceVariable: "OPENAI_API_KEY",
          targetVariable: "OPENAI_API_KEY",
        },
      }),
      legacyEnvironmentOverrides: [],
    }));
  });

  it("applies runtime command overrides before an explicit provider file", async () => {
    const directory = await temporaryDirectory();
    const fileConfigPath = await writeConfig(directory, {
      schemaVersion: 1,
      executionProviders: {
        "codex-cli": {
          command: "/file/codex",
          heartbeatIntervalMs: 45_000,
        },
        "pi-cli": {
          telemetry: false,
        },
      },
    });
    const provider = await createAgentProviderConfigProvider({
      defaultConfigPath,
      fileConfigPath,
      environment: {
        AGENT_EXECUTION_CODEX_COMMAND: "/environment/codex",
        PI_COMMAND: "/environment/pi",
        SYSTEM_MODEL_BUILDER_CODEX_HOME: "/environment/child-home",
        CODEX_HOME: "/environment/parent-home",
        SYSTEM_MODEL_BUILDER_AGENT_HEARTBEAT_INTERVAL_MS: "30000",
        PI_TELEMETRY: "true",
      },
    });

    const resolved = await provider.resolve();
    expect(resolved.executionProviders["codex-cli"]).toEqual(expect.objectContaining({
      command: "/file/codex",
      childHome: "/environment/child-home",
      parentHome: "/environment/parent-home",
      heartbeatIntervalMs: 45_000,
    }));
    expect(resolved.executionProviders["pi-cli"].heartbeatIntervalMs).toBe(30_000);
    expect(resolved.executionProviders["pi-cli"].command).toBe("/environment/pi");
    expect(resolved.executionProviders["pi-cli"].telemetry).toBe(false);
    expect(resolved.legacyEnvironmentOverrides).toEqual([
      "AGENT_EXECUTION_CODEX_COMMAND",
      "CODEX_HOME",
      "PI_COMMAND",
      "PI_TELEMETRY",
      "SYSTEM_MODEL_BUILDER_AGENT_HEARTBEAT_INTERVAL_MS",
      "SYSTEM_MODEL_BUILDER_CODEX_HOME",
    ]);
  });

  it("prefers scoped command overrides to compatibility aliases", async () => {
    const provider = await createAgentProviderConfigProvider({
      defaultConfigPath,
      environment: {
        AGENT_EXECUTION_CODEX_COMMAND: "/scoped/codex",
        CODEX_COMMAND: "/alias/codex",
        SYSTEM_MODEL_BUILDER_CODEX_COMMAND: "/legacy/codex",
        AGENT_EXECUTION_PI_COMMAND: "/scoped/pi",
        PI_COMMAND: "/alias/pi",
        SYSTEM_MODEL_BUILDER_PI_COMMAND: "/legacy/pi",
      },
    });

    const resolved = await provider.resolve();
    expect(resolved.executionProviders["codex-cli"].command).toBe("/scoped/codex");
    expect(resolved.executionProviders["pi-cli"].command).toBe("/scoped/pi");
    expect(resolved.legacyEnvironmentOverrides).toEqual([
      "AGENT_EXECUTION_CODEX_COMMAND",
      "AGENT_EXECUTION_PI_COMMAND",
    ]);
  });

  it("persists credential references and status without command-helper details", async () => {
    const directory = await temporaryDirectory();
    const fileConfigPath = await writeConfig(directory, {
      schemaVersion: 1,
      authProviders: {
        "openai-helper": {
          kind: "command",
          command: "/usr/local/bin/read-openai-credential",
          args: ["get", "openai"],
          targetVariable: "OPENAI_API_KEY",
        },
      },
    });
    const provider = await createAgentProviderConfigProvider({
      defaultConfigPath,
      fileConfigPath,
      environment: {},
    });

    const artifact = redactAgentProviderConfig(await provider.resolve());
    expect(artifact.authProviders["openai-helper"]).toEqual({
      kind: "command",
      targetVariable: "OPENAI_API_KEY",
      commandConfigured: true,
      preflightStatus: "not-checked",
    });
    expect(JSON.stringify(artifact)).not.toContain("read-openai-credential");
    expect(JSON.stringify(artifact)).not.toContain('"args"');
  });

  it("rejects secret values and unknown provider fields", async () => {
    const directory = await temporaryDirectory();
    const fileConfigPath = await writeConfig(directory, {
      schemaVersion: 1,
      authProviders: {
        "unsafe-openai": {
          kind: "environment",
          sourceVariable: "OPENAI_API_KEY",
          targetVariable: "OPENAI_API_KEY",
          value: "must-not-be-configured-here",
        },
      },
    });

    await expect(createAgentProviderConfigProvider({
      defaultConfigPath,
      fileConfigPath,
      environment: {},
    })).rejects.toThrow("contains unknown fields [value]");
  });
});
