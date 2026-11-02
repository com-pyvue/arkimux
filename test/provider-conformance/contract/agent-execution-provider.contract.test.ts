import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentExecutionProvider,
  AgentExecutionRequest,
  ProviderParameterValue,
} from "../../../core/src/application/agentProvider.ts";
import { createAgentAuthProviderRegistry } from "../../../core/src/infrastructure/agents/agentAuthProvider.ts";
import type { ResolvedAgentProviderConfig } from "../../../core/src/infrastructure/agents/agentProviderConfigProvider.ts";
import { createAgentExecutionProviderRegistry } from "../../../core/src/infrastructure/agents/providerRegistry.ts";
import { providerIds, type ProviderId } from "../provider-capabilities.ts";

const SAFE_PROMPT = "Reply with the provider-conformance marker only.";
const SELECTED_SECRET = "selected-provider-contract-secret";
const UNRELATED_SECRET = "unrelated-provider-contract-secret";
const temporaryDirectories: string[] = [];

interface ProviderFixture {
  readonly parameters: Record<string, ProviderParameterValue>;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly expectedUsage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens?: number;
    cost?: { amount: number; currency: string; kind: string };
  };
  script(): string[];
  assertNativeConfiguration(output: Record<string, unknown>): void;
}

const fixtures: Record<ProviderId, ProviderFixture> = {
  "codex-cli": {
    model: "contract-codex-model",
    reasoningEffort: "low",
    parameters: {
      model: "contract-codex-model",
      model_reasoning_effort: "low",
    },
    expectedUsage: {
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 5,
      reasoningOutputTokens: 2,
    },
    script: () => nodeScript([
      "import { writeFileSync } from 'node:fs'",
      versionBranch("codex-cli 0.0.0-contract"),
      stdinCollector([
        "const args = process.argv.slice(2)",
        "const outputIndex = args.indexOf('--output-last-message')",
        "const output = JSON.stringify({ prompt, selectedSecret: process.env.CONTRACT_API_KEY, unrelatedSecret: process.env.UNRELATED_SECRET, args })",
        "writeFileSync(args[outputIndex + 1], output)",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2 } }) + '\\n')",
      ]),
    ]),
    assertNativeConfiguration: (output) => {
      const args = output.args as string[];
      expect(args).toEqual(expect.arrayContaining([
        "exec",
        "--strict-config",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
      ]));
      expect(args).toContain('model="contract-codex-model"');
      expect(args).toContain('model_reasoning_effort="low"');
    },
  },
  "pi-cli": {
    model: "contract-pi-model",
    reasoningEffort: "low",
    parameters: {
      provider: "openai",
      model: "contract-pi-model",
      thinking: "low",
    },
    expectedUsage: {
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      cost: { amount: 0.01, currency: "USD", kind: "provider-estimate" },
    },
    script: () => nodeScript([
      versionBranch("pi 0.0.0-contract"),
      stdinCollector([
        "const args = process.argv.slice(2)",
        "const output = JSON.stringify({ prompt, selectedSecret: process.env.CONTRACT_API_KEY, unrelatedSecret: process.env.UNRELATED_SECRET, args })",
        "const usage = { input: 8, cacheRead: 3, output: 5, reasoning: 2, cost: { total: 0.01 } }",
        "const message = { role: 'assistant', content: [{ type: 'text', text: output }], usage, stopReason: 'stop' }",
        "process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\\n')",
        "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [message] }) + '\\n')",
      ]),
    ]),
    assertNativeConfiguration: (output) => {
      expect(output.args).toEqual(expect.arrayContaining([
        "--mode", "json",
        "--print",
        "--no-session",
        "--no-builtin-tools",
        "--no-approve",
        "--provider", "openai",
        "--model", "contract-pi-model",
        "--thinking", "low",
      ]));
    },
  },
  "claude-code-cli": {
    model: "contract-claude-model",
    reasoningEffort: "low",
    parameters: {
      model: "contract-claude-model",
      effort: "low",
      "permission-mode": "auto",
      "max-budget-usd": 1,
    },
    expectedUsage: {
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 5,
      cost: { amount: 0.01, currency: "USD", kind: "provider-estimate" },
    },
    script: () => nodeScript([
      versionBranch("2.1.241 (Claude Code)"),
      stdinCollector([
        "const args = process.argv.slice(2)",
        "const output = JSON.stringify({ prompt, selectedSecret: process.env.CONTRACT_API_KEY, unrelatedSecret: process.env.UNRELATED_SECRET, args })",
        "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: output, usage: { input_tokens: 11, cache_read_input_tokens: 3, output_tokens: 5 }, total_cost_usd: 0.01 }) + '\\n')",
      ]),
    ]),
    assertNativeConfiguration: (output) => {
      expect(output.args).toEqual(expect.arrayContaining([
        "--print",
        "--output-format", "stream-json",
        "--no-session-persistence",
        "--model", "contract-claude-model",
        "--effort", "low",
        "--permission-mode", "auto",
        "--max-budget-usd", "1",
      ]));
    },
  },
  "kimi-code-cli": {
    model: "contract-kimi-model",
    reasoningEffort: "low",
    parameters: {
      model: "contract-kimi-model",
      "provider-type": "openai",
      "base-url": "https://provider-proxy.invalid/v1",
      "max-context-size": 4096,
      capabilities: ["thinking", "tool-use"],
      "thinking-effort": "low",
    },
    expectedUsage: {
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 5,
    },
    script: () => nodeScript([
      "import { readFileSync } from 'node:fs'",
      versionBranch("kimi 0.38.0"),
      "const args = process.argv.slice(2)",
      "const shortPrompt = args[args.indexOf('--prompt') + 1]",
      "const promptPath = shortPrompt.match(/from (.+) and follow/)?.[1]",
      "const prompt = promptPath ? readFileSync(promptPath, 'utf8') : ''",
      "const output = JSON.stringify({ prompt, selectedSecret: process.env.CONTRACT_API_KEY, unrelatedSecret: process.env.UNRELATED_SECRET, args, model: process.env.KIMI_MODEL_NAME, providerType: process.env.KIMI_MODEL_PROVIDER_TYPE, baseUrl: process.env.KIMI_MODEL_BASE_URL, maxContextSize: process.env.KIMI_MODEL_MAX_CONTEXT_SIZE, capabilities: process.env.KIMI_MODEL_CAPABILITIES, thinkingEffort: process.env.KIMI_MODEL_THINKING_EFFORT })",
      "process.stdout.write(JSON.stringify({ role: 'assistant', content: output, usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 5 } }) + '\\n')",
    ]),
    assertNativeConfiguration: (output) => {
      expect(output.args).toEqual(expect.arrayContaining([
        "--prompt",
        "--output-format", "stream-json",
      ]));
      expect(output).toMatchObject({
        model: "contract-kimi-model",
        providerType: "openai",
        baseUrl: "https://provider-proxy.invalid/v1",
        maxContextSize: "4096",
        capabilities: "thinking,tool-use",
        thinkingEffort: "low",
      });
    },
  },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe.each(providerIds)("%s deterministic execution-provider contract", (providerId) => {
  it("preflights and runs through the provider-neutral contract", async () => {
    const context = await providerContext(providerId, "success");
    const request = executionRequest(context.root, providerId, context.artifactPrefix);

    await expect(context.runner.preflight(request)).resolves.toMatchObject({
      providerId,
      available: true,
      resolvedCommand: context.command,
      commandSource: "explicit",
      auth: {
        authProviderId: authProviderId(providerId),
        kind: "environment",
        available: true,
      },
    });

    const result = await context.runner.run(request);
    const output = JSON.parse(result.output) as Record<string, unknown>;
    expect(output).toMatchObject({
      prompt: SAFE_PROMPT,
      selectedSecret: "[redacted]",
    });
    expect(output).not.toHaveProperty("unrelatedSecret");
    fixtures[providerId].assertNativeConfiguration(output);
    expect(result.metrics).toMatchObject({
      providerId,
      label: "provider-contract",
      attempt: 2,
      model: fixtures[providerId].model,
      reasoningEffort: fixtures[providerId].reasoningEffort,
      status: "complete",
      nativeToolCalls: 0,
      usage: fixtures[providerId].expectedUsage,
    });
    expect(result.metrics.elapsedMs).toBeGreaterThanOrEqual(0);
    await expectArtifacts(result.metrics.artifacts, result.output);
    for (const name of ["eventsPath", "stderrPath", "lastMessagePath", "heartbeatPath"] as const) {
      expect(await fs.readFile(result.metrics.artifacts[name], "utf8")).not.toContain(SELECTED_SECRET);
    }
  });

  it("terminates a timed-out invocation and retains provider-neutral diagnostics", async () => {
    const context = await providerContext(providerId, "timeout");
    const request = {
      ...executionRequest(context.root, providerId, context.artifactPrefix),
      timeoutMs: 100,
    };

    let failure: unknown;
    try {
      await context.runner.run(request);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      failureCode: "agent_timed_out",
      metrics: {
        providerId,
        status: "timed-out",
        artifacts: {
          eventsPath: `${context.artifactPrefix}.events.jsonl`,
          stderrPath: `${context.artifactPrefix}.stderr.log`,
          lastMessagePath: `${context.artifactPrefix}.last-message.txt`,
          heartbeatPath: `${context.artifactPrefix}.heartbeat.json`,
        },
      },
    });
    const metrics = (failure as Error & { metrics: { artifacts: Record<string, string> } }).metrics;
    await expect(fs.readFile(metrics.artifacts.eventsPath, "utf8")).resolves.toBe("");
    await expect(fs.readFile(metrics.artifacts.stderrPath, "utf8")).resolves.toBe("");
    await expect(fs.readFile(metrics.artifacts.heartbeatPath, "utf8"))
      .resolves.toContain('"status": "timed-out"');
  });
});

it("runs Pi with an Anthropic native session through an isolated agent directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arkimux-pi-anthropic-native-contract-"));
  temporaryDirectories.push(root);
  const parentAgentDirectory = path.join(root, "pi-parent");
  await fs.mkdir(parentAgentDirectory, { recursive: true });
  await fs.writeFile(
    path.join(parentAgentDirectory, "auth.json"),
    `${JSON.stringify({ anthropic: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 } })}\n`,
    "utf8",
  );
  const command = path.join(root, "pi-cli.mjs");
  await fs.writeFile(command, nodeScript([
    "import { readFileSync } from 'node:fs'",
    versionBranch("pi 0.0.0-contract"),
    stdinCollector([
      "const args = process.argv.slice(2)",
      "const agentDirectory = process.env.PI_CODING_AGENT_DIR",
      "const auth = JSON.parse(readFileSync(`${agentDirectory}/auth.json`, 'utf8'))",
      "const output = JSON.stringify({ prompt, args, agentDirectory, auth })",
      "const message = { role: 'assistant', content: [{ type: 'text', text: output }], usage: { input: 1, output: 1 }, stopReason: 'stop' }",
      "process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\\n')",
      "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [message] }) + '\\n')",
    ]),
  ]).join("\n"), { mode: 0o700 });

  const config = providerConfig("pi-cli", command, root);
  config.executionProviders["pi-cli"].agentDirectory = parentAgentDirectory;
  config.authProviders = {
    "pi-anthropic-session": {
      kind: "runtime-native",
      runtime: "pi-cli",
      modelProvider: "anthropic",
    },
  };
  const environment = { PATH: process.env.PATH };
  const runner = createAgentExecutionProviderRegistry(
    config,
    createAgentAuthProviderRegistry(config, environment),
    environment,
  ).get("pi-cli");
  const result = await runner.run({
    cwd: root,
    prompt: SAFE_PROMPT,
    timeoutMs: 5_000,
    authProviderId: "pi-anthropic-session",
    artifactPrefix: path.join(root, "artifacts", "pi-anthropic-native"),
    parameters: {
      provider: "anthropic",
      model: "contract-anthropic-model",
      thinking: "low",
    },
  });
  const output = JSON.parse(result.output) as {
    prompt: string;
    args: string[];
    agentDirectory: string;
    auth: Record<string, unknown>;
  };

  expect(output).toMatchObject({
    prompt: SAFE_PROMPT,
    auth: { anthropic: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 } },
  });
  expect(output.args).toEqual(expect.arrayContaining([
    "--provider", "anthropic",
    "--model", "contract-anthropic-model",
  ]));
  expect(output.agentDirectory).not.toBe(parentAgentDirectory);
  expect(path.dirname(output.agentDirectory)).toBe(os.tmpdir());
  await expect(fs.access(output.agentDirectory)).rejects.toBeDefined();
});

async function providerContext(providerId: ProviderId, mode: "success" | "timeout"): Promise<{
  root: string;
  command: string;
  artifactPrefix: string;
  runner: AgentExecutionProvider;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `arkimux-${providerId}-contract-`));
  temporaryDirectories.push(root);
  const command = path.join(root, `${providerId}.mjs`);
  const script = mode === "success"
    ? fixtures[providerId].script()
    : nodeScript([
        versionBranch(versionOutput(providerId)),
        "setInterval(() => undefined, 1000)",
      ]);
  await fs.writeFile(command, script.join("\n"), { mode: 0o700 });
  await fs.mkdir(path.join(root, "codex-parent"), { recursive: true });

  const config = providerConfig(providerId, command, root);
  const environment = {
    PATH: process.env.PATH,
    CONTRACT_SOURCE_SECRET: SELECTED_SECRET,
    UNRELATED_SECRET,
  };
  return {
    root,
    command,
    artifactPrefix: path.join(root, "artifacts", "agent"),
    runner: createAgentExecutionProviderRegistry(
      config,
      createAgentAuthProviderRegistry(config, environment),
      environment,
    ).get(providerId),
  };
}

function providerConfig(providerId: ProviderId, command: string, root: string): ResolvedAgentProviderConfig {
  const runtime = (candidate: ProviderId) => ({
    command,
    heartbeatIntervalMs: 10,
    environmentAllowlist: ["PATH"],
    ...(candidate === "codex-cli" ? { parentHome: path.join(root, "codex-parent") } : {}),
    ...(candidate === "pi-cli" ? { offline: true, telemetry: false, versionCheck: false } : {}),
    ...(candidate === "claude-code-cli" ? { requiredVersion: "2.1.241" } : {}),
    ...(candidate === "kimi-code-cli" ? { requiredVersion: "0.38.0", telemetry: false } : {}),
  });
  return {
    schemaVersion: 1,
    executionProviders: {
      "codex-cli": runtime("codex-cli"),
      "pi-cli": runtime("pi-cli"),
      "claude-code-cli": runtime("claude-code-cli"),
      "kimi-code-cli": runtime("kimi-code-cli"),
    },
    authProviders: {
      [authProviderId(providerId)]: {
        kind: "environment",
        sourceVariable: "CONTRACT_SOURCE_SECRET",
        targetVariable: "CONTRACT_API_KEY",
      },
    },
    legacyEnvironmentOverrides: [],
  };
}

function executionRequest(root: string, providerId: ProviderId, artifactPrefix: string): AgentExecutionRequest {
  return {
    cwd: root,
    prompt: SAFE_PROMPT,
    timeoutMs: 5_000,
    authProviderId: authProviderId(providerId),
    artifactPrefix,
    label: "provider-contract",
    attempt: 2,
    parameters: fixtures[providerId].parameters,
  };
}

function authProviderId(providerId: ProviderId): string {
  return `${providerId}-contract-key`;
}

function versionOutput(providerId: ProviderId): string {
  if (providerId === "claude-code-cli") return "2.1.241 (Claude Code)";
  if (providerId === "kimi-code-cli") return "kimi 0.38.0";
  return `${providerId} 0.0.0-contract`;
}

function nodeScript(lines: string[]): string[] {
  return [`#!${process.execPath}`, ...lines, ""];
}

function versionBranch(output: string): string {
  return `if (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(`${output}\n`)}); process.exit(0) }`;
}

function stdinCollector(onEnd: string[]): string {
  return [
    "let prompt = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { prompt += chunk })",
    "process.stdin.on('end', () => {",
    ...onEnd.map((line) => `  ${line}`),
    "})",
  ].join("\n");
}

async function expectArtifacts(
  artifacts: {
    eventsPath: string;
    stderrPath: string;
    lastMessagePath: string;
    heartbeatPath: string;
  },
  output: string,
): Promise<void> {
  await expect(fs.readFile(artifacts.eventsPath, "utf8")).resolves.not.toBe("");
  await expect(fs.readFile(artifacts.stderrPath, "utf8")).resolves.toBe("");
  expect((await fs.readFile(artifacts.lastMessagePath, "utf8")).trim()).toBe(output);
  await expect(fs.readFile(artifacts.heartbeatPath, "utf8"))
    .resolves.toContain('"status": "complete"');
}
