import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentAuthProviderRegistry } from "../../core/src/infrastructure/agents/agentAuthProvider.ts";
import type { ResolvedAgentProviderConfig } from "../../core/src/infrastructure/agents/agentProviderConfigProvider.ts";
import { ClaudeCodeCliAgentRunner } from "../../core/src/infrastructure/agents/claudeCodeCliAgentRunner.ts";
import { KimiCodeCliAgentRunner } from "../../core/src/infrastructure/agents/kimiCodeCliAgentRunner.ts";
import { ExecutionAgentAuthConnectionProbe } from "../../core/src/infrastructure/agents/agentAuthConnectionProbe.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-native-cli-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function providerConfig(claude: string, kimi: string): ResolvedAgentProviderConfig {
  return {
    schemaVersion: 1,
    executionProviders: {
      "codex-cli": { command: "codex", heartbeatIntervalMs: 10, environmentAllowlist: ["PATH"] },
      "pi-cli": { command: "pi", heartbeatIntervalMs: 10, environmentAllowlist: ["PATH"] },
      "claude-code-cli": { command: claude, heartbeatIntervalMs: 10, environmentAllowlist: ["PATH"], requiredVersion: "2.1.50" },
      "kimi-code-cli": { command: kimi, heartbeatIntervalMs: 10, environmentAllowlist: ["PATH"], requiredVersion: "1.49.0" },
    },
    authProviders: {
      "claude-test-key": { kind: "environment", sourceVariable: "SOURCE_ANTHROPIC_KEY", targetVariable: "ANTHROPIC_API_KEY" },
      "kimi-test-key": { kind: "environment", sourceVariable: "SOURCE_KIMI_KEY", targetVariable: "KIMI_MODEL_API_KEY" },
    },
    legacyEnvironmentOverrides: [],
  };
}

async function fakeClaude(directory: string): Promise<string> {
  const executable = path.join(directory, "fake-claude.mjs");
  await fs.writeFile(executable, [
    `#!${process.execPath}`,
    "if (process.argv.includes('--version')) { process.stdout.write('2.1.50 (Claude Code)\\n'); process.exit(0) }",
    "let prompt = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { prompt += chunk })",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }) + '\\n')",
    "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify({ prompt, apiKey: process.env.ANTHROPIC_API_KEY }), usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 5 }, total_cost_usd: 0.01 }) + '\\n')",
    "})",
  ].join("\n"), { mode: 0o700 });
  return executable;
}

async function fakeFreeClaudeThatRejectsExecution(directory: string, reportedPlan = "free"): Promise<string> {
  const executable = path.join(directory, "fake-free-claude.mjs");
  await fs.writeFile(executable, [
    `#!${process.execPath}`,
    "if (process.argv.includes('--version')) { process.stdout.write('2.1.50 (Claude Code)\\n'); process.exit(0) }",
    `if (process.argv.slice(2, 5).join(' ') === 'auth status --json') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'developer@example.com', subscriptionType: ${JSON.stringify(reportedPlan)} })); process.exit(0) }`,
    "process.stdout.write(JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }) + '\\n')",
    "process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }) + '\\n')",
    "process.exit(1)",
  ].join("\n"), { mode: 0o700 });
  return executable;
}

async function fakeKimi(directory: string): Promise<string> {
  const executable = path.join(directory, "fake-kimi.mjs");
  await fs.writeFile(executable, [
    `#!${process.execPath}`,
    "import { readFileSync } from 'node:fs'",
    "if (process.argv.includes('--version')) { process.stdout.write('kimi 1.49.0\\n'); process.exit(0) }",
    "if (process.argv.slice(2).join(' ') === 'provider list --json') { process.stdout.write(JSON.stringify({ providers: { 'managed:kimi-code': {} }, models: {} })); process.exit(0) }",
    "const prompt = process.argv[process.argv.indexOf('--prompt') + 1]",
    "const match = prompt.match(/from (.+) and follow/)",
    "const original = match ? readFileSync(match[1], 'utf8') : ''",
    "process.stdout.write(JSON.stringify({ role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'ReadFile' } }] }) + '\\n')",
    "process.stdout.write(JSON.stringify({ role: 'assistant', content: JSON.stringify({ original, apiKey: process.env.KIMI_MODEL_API_KEY, model: process.env.KIMI_MODEL_NAME, providerType: process.env.KIMI_MODEL_PROVIDER_TYPE, kimiHome: process.env.KIMI_CODE_HOME }), usage: { input_tokens: 20, output_tokens: 7 } }) + '\\n')",
  ].join("\n"), { mode: 0o700 });
  return executable;
}

describe("native CLI agent runners", () => {
  for (const customLocation of [false, true]) it(`uses the same isolated Claude session environment for status and inference (custom location: ${customLocation})`, async () => {
    const root = await temporaryDirectory();
    const executable = path.join(root, "session-claude.mjs");
    const observations = path.join(root, "environments.jsonl");
    await fs.writeFile(executable, [
      `#!${process.execPath}`,
      "import { appendFileSync } from 'node:fs'",
      "if (process.argv.includes('--version')) { console.log('2.1.50 (Claude Code)'); process.exit(0); }",
      `appendFileSync(${JSON.stringify(observations)}, JSON.stringify({kind: process.argv.includes('auth') ? 'status' : 'inference', env: process.env}) + '\\n');`,
      "const loggedIn = process.env.USER === 'fixture-user';",
      "if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' })); process.exit(0); }",
      "if (!loggedIn) { console.log(JSON.stringify({ error: 'authentication_failed' })); process.exit(1); }",
      "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({type: 'result', result: 'OK'})));",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(executable, "unused-kimi");
    config.authProviders["claude-native-session"] = { kind: "runtime-native", runtime: "claude-code-cli", modelProvider: "anthropic" };
    const sessionContext = { USER: "fixture-user", ...(customLocation ? { HOME: path.join(root, "user-home"), CLAUDE_CONFIG_DIR: path.join(root, "claude-settings") } : {}) };
    const environment = { PATH: process.env.PATH, ...sessionContext, ANTHROPIC_API_KEY: "must-not-inherit-key",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-inherit-token", WEATHER_API_URL: "must-not-inherit-workflow-value", UNRELATED_SECRET: "must-not-inherit-secret" };
    const original = { ...environment };
    const runner = new ClaudeCodeCliAgentRunner(config.executionProviders["claude-code-cli"], createAgentAuthProviderRegistry(config, environment), environment);
    const probe = new ExecutionAgentAuthConnectionProbe({ get: () => runner }, config, root, environment);
    await expect(probe.probe({ authProviderId: "claude-native-session", executionProviderId: "claude-code-cli", modelProvider: "anthropic" }))
      .resolves.toMatchObject({ status: "connected", mechanism: "minimal-inference" });
    const rows = (await fs.readFile(observations, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { kind: string; env: Record<string, string> });
    expect(rows.filter(row => row.kind === "inference")).toHaveLength(1);
    expect(rows.some(row => row.kind === "status")).toBe(true);
    for (const row of rows) {
      expect(row.env).toEqual(rows[0]!.env);
      // macOS may insert this process-local locale value even when it was not passed by the parent.
      const passed = Object.fromEntries(Object.entries(row.env).filter(([name]) => name !== "__CF_USER_TEXT_ENCODING"));
      expect(passed).toEqual({ PATH: process.env.PATH, ...sessionContext });
    }
    expect(environment).toEqual(original);
  });

  it("does not let a shell API key make a missing native session pass preflight", async () => {
    const root = await temporaryDirectory();
    const executable = path.join(root, "key-only-claude.mjs");
    await fs.writeFile(executable, [
      `#!${process.execPath}`,
      "if (process.argv.includes('--version')) { console.log('2.1.50 (Claude Code)'); process.exit(0); }",
      "if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: Boolean(process.env.ANTHROPIC_API_KEY), authMethod: process.env.ANTHROPIC_API_KEY ? 'api_key' : 'none' })); process.exit(0); }",
      "throw new Error('Inference must not start');",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(executable, "unused-kimi");
    config.authProviders["claude-native-session"] = { kind: "runtime-native", runtime: "claude-code-cli", modelProvider: "anthropic" };
    const environment = { PATH: process.env.PATH, ANTHROPIC_API_KEY: "shell-key" };
    const runner = new ClaudeCodeCliAgentRunner(config.executionProviders["claude-code-cli"], createAgentAuthProviderRegistry(config, environment), environment);
    await expect(runner.preflight({ cwd: root, authProviderId: "claude-native-session", parameters: { model: "haiku" } }))
      .resolves.toMatchObject({ available: false, auth: { reason: "session-missing" } });
  });

  it("runs Claude Code through the provider-independent execution contract", async () => {
    const root = await temporaryDirectory();
    const config = providerConfig(await fakeClaude(root), await fakeKimi(root));
    const environment = { PATH: process.env.PATH, SOURCE_ANTHROPIC_KEY: "claude-secret", SOURCE_KIMI_KEY: "kimi-secret" };
    const runner = new ClaudeCodeCliAgentRunner(config.executionProviders["claude-code-cli"], createAgentAuthProviderRegistry(config, environment), environment);
    const result = await runner.run({ cwd: root, prompt: "large prompt stays on stdin", timeoutMs: 5_000, authProviderId: "claude-test-key", artifactPrefix: path.join(root, "claude", "attempt-1"), parameters: { model: "sonnet", effort: "high", "permission-mode": "auto" } });
    expect(JSON.parse(result.output)).toEqual({ prompt: "large prompt stays on stdin", apiKey: "[redacted]" });
    expect(result.metrics).toMatchObject({ providerId: "claude-code-cli", model: "sonnet", reasoningEffort: "high", nativeToolCalls: 1, usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5, cost: { amount: 0.01 } } });
  });

  it("preserves Claude's authentication error without guessing plan eligibility", async () => {
    const root = await temporaryDirectory();
    const config = providerConfig(await fakeFreeClaudeThatRejectsExecution(root), await fakeKimi(root));
    config.authProviders["claude-native-session"] = {
      kind: "runtime-native",
      runtime: "claude-code-cli",
      modelProvider: "anthropic",
    };
    const environment = { PATH: process.env.PATH };
    const runner = new ClaudeCodeCliAgentRunner(
      config.executionProviders["claude-code-cli"],
      createAgentAuthProviderRegistry(config, environment),
      environment,
    );
    const run = runner.run({
      cwd: root,
      prompt: "should not execute",
      timeoutMs: 5_000,
      authProviderId: "claude-native-session",
      artifactPrefix: path.join(root, "claude-free", "attempt-1"),
      parameters: { model: "sonnet", effort: "low", "permission-mode": "auto" },
    });
    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining("Not logged in · Please run /login"),
    });
    await expect(run).rejects.not.toMatchObject({
      message: expect.stringContaining("attempt-1.events.jsonl"),
    });
  });

  it("does not present a generic authentication rejection as an ineligible paid plan", async () => {
    const root = await temporaryDirectory();
    const config = providerConfig(await fakeFreeClaudeThatRejectsExecution(root, "pro"), "unused-kimi");
    config.authProviders["claude-native-session"] = { kind: "runtime-native", runtime: "claude-code-cli", modelProvider: "anthropic" };
    const environment = { PATH: process.env.PATH };
    const runner = new ClaudeCodeCliAgentRunner(config.executionProviders["claude-code-cli"], createAgentAuthProviderRegistry(config, environment), environment);
    await expect(runner.run({ cwd: root, prompt: "OK", timeoutMs: 5_000, authProviderId: "claude-native-session",
      artifactPrefix: path.join(root, "rejection"), parameters: { model: "haiku" } }))
      .rejects.toThrow("Not logged in · Please run /login");
  });

  it("preflights the same repository-local Claude executable that it would run", async () => {
    const root = await temporaryDirectory();
    const localBin = path.join(root, "node_modules", ".bin");
    const pathBin = path.join(root, "path-bin");
    await fs.mkdir(localBin, { recursive: true });
    await fs.mkdir(pathBin, { recursive: true });
    const script = (loggedIn: boolean) => [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then printf '%s\\n' '2.1.50 (Claude Code)'; exit 0; fi",
      `if [ \"$1 $2 $3\" = \"auth status --json\" ]; then printf '%s\\n' '${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" })}'; ${loggedIn ? "exit 0" : "exit 1"}; fi`,
      "exit 1",
    ].join("\n");
    const repositoryClaude = path.join(localBin, "claude");
    await fs.writeFile(repositoryClaude, script(false), { mode: 0o700 });
    await fs.writeFile(path.join(pathBin, "claude"), script(true), { mode: 0o700 });
    const config = providerConfig("claude", await fakeKimi(root));
    config.authProviders["claude-native-session"] = {
      kind: "runtime-native",
      runtime: "claude-code-cli",
      modelProvider: "anthropic",
    };
    const environment = { PATH: `${pathBin}:${process.env.PATH ?? ""}` };
    const runner = new ClaudeCodeCliAgentRunner(
      config.executionProviders["claude-code-cli"],
      createAgentAuthProviderRegistry(config, environment),
      environment,
    );
    await expect(runner.preflight({
      cwd: root,
      authProviderId: "claude-native-session",
      parameters: { model: "sonnet", effort: "low", "permission-mode": "auto" },
    })).resolves.toMatchObject({
      available: false,
      resolvedCommand: repositoryClaude,
      commandSource: "repository-local",
      auth: {
        status: "unavailable",
        reason: "session-missing",
        identity: { authMethod: "none" },
        executable: { path: repositoryClaude },
      },
    });
  });

  it("runs Kimi Code with an isolated prompt file and ephemeral model environment", async () => {
    const root = await temporaryDirectory();
    const config = providerConfig(await fakeClaude(root), await fakeKimi(root));
    const environment = { PATH: process.env.PATH, SOURCE_ANTHROPIC_KEY: "claude-secret", SOURCE_KIMI_KEY: "kimi-secret" };
    const runner = new KimiCodeCliAgentRunner(config.executionProviders["kimi-code-cli"], createAgentAuthProviderRegistry(config, environment), environment);
    const result = await runner.run({ cwd: root, prompt: "large Kimi prompt is file-backed", timeoutMs: 5_000, authProviderId: "kimi-test-key", artifactPrefix: path.join(root, "kimi", "attempt-1"), parameters: { model: "kimi-k2.5", "provider-type": "kimi", "thinking-effort": "high" } });
    expect(JSON.parse(result.output)).toMatchObject({ original: "large Kimi prompt is file-backed", apiKey: "[redacted]", model: "kimi-k2.5", providerType: "kimi" });
    expect(result.metrics).toMatchObject({ providerId: "kimi-code-cli", model: "kimi-k2.5", reasoningEffort: "high", nativeToolCalls: 1, usage: { inputTokens: 20, outputTokens: 7 } });
  });

  it("runs Kimi Code against the runtime-native session home", async () => {
    const root = await temporaryDirectory();
    const kimiHome = path.join(root, "kimi-session");
    const config = providerConfig(await fakeClaude(root), await fakeKimi(root));
    config.executionProviders["kimi-code-cli"].parentHome = kimiHome;
    config.authProviders["kimi-native-session"] = {
      kind: "runtime-native",
      runtime: "kimi-code-cli",
      modelProvider: "kimi",
    };
    const environment = { PATH: process.env.PATH };
    const runner = new KimiCodeCliAgentRunner(
      config.executionProviders["kimi-code-cli"],
      createAgentAuthProviderRegistry(config, environment),
      environment,
    );
    const result = await runner.run({
      cwd: root,
      prompt: "native Kimi session",
      timeoutMs: 5_000,
      authProviderId: "kimi-native-session",
      artifactPrefix: path.join(root, "kimi-native", "attempt-1"),
      parameters: { model: "kimi-k2.5", "provider-type": "kimi", "thinking-effort": "high" },
    });
    expect(JSON.parse(result.output)).toMatchObject({ original: "native Kimi session", kimiHome });
  });
});
