import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentExecutionProviderRegistry,
  createAgentAuthProviderRegistry,
  type ResolvedAgentProviderConfig,
} from "../../../core/src/index.ts";
import {
  GuardedRepositoryPiExtensionProvider,
  summarizeGuardedRepositoryToolAudit,
} from "../../../agent-input/code/src/index.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "system-model-builder-v2-pi-runner-"));
  directories.push(directory);
  return directory;
}

async function fakePiExecutable(directory: string): Promise<string> {
  const executable = path.join(directory, "fake-pi");
  await fs.writeFile(executable, [
    "#!/usr/bin/env node",
    "let prompt = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => { prompt += chunk })",
    "process.stdin.on('end', () => {",
    "  const args = process.argv.slice(2)",
    "  const output = JSON.stringify({",
    "    args,",
    "    apiKey: process.env.OPENAI_API_KEY,",
    "    unrelatedSecret: process.env.UNRELATED_SECRET,",
    "    agentDirectory: process.env.PI_CODING_AGENT_DIR,",
    "    offline: process.env.PI_OFFLINE,",
    "    telemetry: process.env.PI_TELEMETRY,",
    "    skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK,",
    "    snapshotRoot: process.env.CODE_CAPABILITIES_SNAPSHOT_ROOT,",
    "    repositoryToolAudit: process.env.CODE_CAPABILITIES_REPOSITORY_TOOL_AUDIT,",
    "    promptReceived: prompt.length > 0",
    "  })",
    "  const usage = {",
    "    input: 21, output: 8, cacheRead: 13, cacheWrite: 0, reasoning: 3, totalTokens: 42,",
    "    cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0, total: 0.033 }",
    "  }",
    "  const message = {",
    "    role: 'assistant',",
    "    content: [{ type: 'text', text: output }],",
    "    provider: 'openai', model: 'fixture-model', usage, stopReason: 'stop', timestamp: Date.now()",
    "  }",
    "  process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n')",
    "  process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\\n')",
    "  if (prompt === 'ambiguous') process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\\n')",
    "  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [message] }) + '\\n')",
    "})",
    "",
  ].join("\n"), { mode: 0o700 });
  return executable;
}

function providerConfig(command: string): ResolvedAgentProviderConfig {
  return {
    schemaVersion: 1,
    executionProviders: {
      "codex-cli": {
        command: "codex",
        heartbeatIntervalMs: 10,
        environmentAllowlist: ["PATH"],
      },
      "pi-cli": {
        command,
        heartbeatIntervalMs: 10,
        environmentAllowlist: ["PATH"],
        offline: true,
        telemetry: false,
        versionCheck: false,
      },
      "claude-code-cli": { command: "claude", heartbeatIntervalMs: 10, environmentAllowlist: ["PATH"] },
      "kimi-code-cli": { command: "kimi", heartbeatIntervalMs: 10, environmentAllowlist: ["PATH"] },
    },
    authProviders: {
      "openai-api-key": {
        kind: "environment",
        sourceVariable: "SOURCE_OPENAI_KEY",
        targetVariable: "OPENAI_API_KEY",
      },
    },
    legacyEnvironmentOverrides: [],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("Pi CLI agent runner", () => {
  it("projects exact guarded repository-operation metrics from the audit", () => {
    const audit = [
      JSON.stringify({ tool: "repo_list", status: "complete", resultBytes: 120 }),
      JSON.stringify({ tool: "repo_search", status: "rejected", resultBytes: 0 }),
      JSON.stringify({ tool: "repo_read", status: "complete", resultBytes: 880 }),
    ].join("\n");

    expect(summarizeGuardedRepositoryToolAudit(audit)).toEqual({
      nativeToolCalls: 3,
      toolCallUnit: "guarded-repository-operation",
      repositorySearchCalls: 2,
      fileReadCalls: 1,
      repositoryResultBytes: 1_000,
      rejectedRepositoryCalls: 1,
    });
  });

  it("runs Pi ephemerally and normalizes its JSON event stream", async () => {
    const directory = await temporaryDirectory();
    const command = await fakePiExecutable(directory);
    const config = providerConfig(command);
    const environment = {
      PATH: process.env.PATH,
      SOURCE_OPENAI_KEY: "selected-secret",
      UNRELATED_SECRET: "must-not-be-forwarded",
    };
    const runner = createAgentExecutionProviderRegistry(
      config,
      createAgentAuthProviderRegistry(config, environment),
      environment,
      new GuardedRepositoryPiExtensionProvider(),
    ).get("pi-cli");
    const artifactPrefix = path.join(directory, "state", "topology");

    const result = await runner.run({
      cwd: directory,
      prompt: "fixture prompt",
      timeoutMs: 5_000,
      authProviderId: "openai-api-key",
      artifactPrefix,
      label: "topology-discovery",
      attempt: 1,
      parameters: {
        provider: "openai",
        model: "gpt-5.6-luna",
        thinking: "high",
      },
    });

    const output = JSON.parse(result.output) as Record<string, unknown>;
    const args = output.args as string[];
    expect(args).toEqual(expect.arrayContaining([
      "--mode", "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-builtin-tools",
      "--extension",
      "--tools", "repo_list,repo_search,repo_read,repo_batch_read",
      "--no-approve",
      "--offline",
      "--provider", "openai",
      "--model", "gpt-5.6-luna",
      "--thinking", "high",
    ]));
    expect(output).toMatchObject({
      apiKey: "[redacted]",
      offline: "1",
      telemetry: "0",
      skipVersionCheck: "1",
      snapshotRoot: directory,
      promptReceived: true,
    });
    expect(output).not.toHaveProperty("unrelatedSecret");
    expect(result.metrics).toMatchObject({
      providerId: "pi-cli",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      status: "complete",
      nativeToolCalls: 0,
      toolCallUnit: "guarded-repository-operation",
      repositorySearchCalls: 0,
      fileReadCalls: 0,
      repositoryResultBytes: 0,
      rejectedRepositoryCalls: 0,
      usage: {
        inputTokens: 34,
        cachedInputTokens: 13,
        outputTokens: 8,
        reasoningOutputTokens: 3,
        cost: { amount: 0.033, currency: "USD", kind: "provider-estimate" },
      },
    });
    await expect(fs.readFile(`${artifactPrefix}.last-message.txt`, "utf8")).resolves.toBe(`${result.output}\n`);
    await expect(fs.readFile(`${artifactPrefix}.events.jsonl`, "utf8")).resolves.toContain('"type":"message_end"');
    await expect(fs.readFile(`${artifactPrefix}.heartbeat.json`, "utf8")).resolves.toContain('"providerId": "pi-cli"');
    await expect(fs.readFile(`${artifactPrefix}.repository-tools.jsonl`, "utf8")).resolves.toBe("");
    expect(output.repositoryToolAudit).toBe(`${artifactPrefix}.repository-tools.jsonl`);
    const extensionIndex = args.indexOf("--extension");
    expect(args[extensionIndex + 1]).toContain("agent-execution-pi-agent-");
    expect(result.metrics.artifacts.repositoryToolAuditPath).toBe(`${artifactPrefix}.repository-tools.jsonl`);
    const agentDirectory = output.agentDirectory as string;
    expect(agentDirectory).toContain("agent-execution-pi-agent-");
    await expect(fs.stat(agentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an ambiguous successful final response", async () => {
    const directory = await temporaryDirectory();
    const command = await fakePiExecutable(directory);
    const config = providerConfig(command);
    const environment = { PATH: process.env.PATH, SOURCE_OPENAI_KEY: "selected-secret" };
    const runner = createAgentExecutionProviderRegistry(
      config,
      createAgentAuthProviderRegistry(config, environment),
      environment,
      new GuardedRepositoryPiExtensionProvider(),
    ).get("pi-cli");

    await expect(runner.run({
      cwd: directory,
      prompt: "ambiguous",
      timeoutMs: 5_000,
      authProviderId: "openai-api-key",
      artifactPrefix: path.join(directory, "state", "ambiguous"),
      parameters: { provider: "openai", model: "gpt-5.6-luna" },
    })).rejects.toEqual(expect.objectContaining({
      name: "PiCliAgentRunError",
      message: expect.stringContaining("contained 2 successful final assistant messages"),
    }));
  });
});
