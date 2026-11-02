import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedAgentProviderConfig } from "../../core/src/infrastructure/agents/agentProviderConfigProvider.ts";
import { createAgentAuthProviderRegistry } from "../../core/src/infrastructure/agents/agentAuthProvider.ts";
import { CodexCliAgentRunner } from "../../core/src/infrastructure/agents/codexCliAgentRunner.ts";
import { ExecutionAgentAuthConnectionProbe } from "../../core/src/infrastructure/agents/agentAuthConnectionProbe.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-agent-auth-"));
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

describe("Codex authentication integration", () => {
  it.each([
    { mode: "exit", reasons: ["Unsupported value for model_reasoning_effort."], summary: "codex exec exited with code 1." },
    { mode: "timeout", reasons: ["provider transport failed"], summary: "codex exec timed out after 500ms." },
    { mode: "empty", reasons: ["provider transport failed"], summary: "codex exec produced empty last message." },
    { mode: "braces", reasons: ["Connection failed: TransportError"], summary: "codex exec exited with code 1." },
    { mode: "braces-stderr", reasons: ["Connection failed: TransportError"], summary: "codex exec exited with code 1." },
    { mode: "unmatched-quote", reasons: ['Error: Unsupported transport configuration "[redacted] is not accepted at `[redacted path]`. Select a supported value.'], summary: "codex exec exited with code 1." },
    { mode: "multiline", reasons: ["Error: Connection failed:", "Caused by: upstream transport unavailable"], summary: "codex exec exited with code 1." },
    { mode: "quoted-event", reasons: ["The 'example_option' parameter is not supported by this endpoint.", "request_id: support-request"], summary: "codex exec exited with code 1.", exact: true },
    { mode: "quoted-stderr", reasons: ["Error: The 'example_option' parameter is not supported by this endpoint."], summary: "codex exec exited with code 1.", exact: true },
    { mode: "quoted-secret", reasons: ['The "example_option" parameter is not supported by this endpoint. Provided "[redacted]" at "[redacted path]"; use "gpt-5.6-luna" instead.', "request_id: support-request"], summary: "codex exec exited with code 1.", exact: true },
  ])("keeps a safe Codex probe reason after artifacts are deleted: $mode", async ({ mode, reasons, summary, exact }) => {
    const directory = await temporaryDirectory();
    const parentHome = path.join(directory, "isolated-codex-home");
    await fs.mkdir(parentHome);
    const executable = path.join(directory, "fake-codex.mjs");
    await fs.writeFile(executable, [
      `#!${process.execPath}`,
      "if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0-test'); process.exit(0); }",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      `  const mode = ${JSON.stringify(mode)};`,
      "  if (mode === 'timeout' || mode === 'empty') {",
      "    console.error('Error: provider transport failed ' + process.env.OPENAI_API_KEY);",
      "    if (mode === 'timeout') setInterval(() => {}, 1000);",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ type: 'thread.started', cwd: process.cwd(), private: 'never-return-context'.repeat(2000) }));",
      "  if (mode === 'braces') {",
      "    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'Connection failed: TransportError { url: https://private.example/never-return-url, credential: ' + process.env.OPENAI_API_KEY + ', payload: never-return-payload, cwd: ' + process.cwd() + ' }' }, request_id: 'never-return-request' }));",
      "  } else if (mode === 'braces-stderr') {",
      "    console.error('Connection failed: TransportError { payload: never-return-payload, credential: ' + process.env.OPENAI_API_KEY + ', cwd: ' + process.cwd() + ' }');",
      "  } else if (mode === 'unmatched-quote') {",
      "    console.error('Error: Unsupported transport configuration \"' + process.env.OPENAI_API_KEY + ' is not accepted at `' + process.cwd() + '`. Select a supported value.');",
      "  } else if (mode === 'multiline') {",
      "    console.error('Error: Connection failed:');",
      "    console.error('Caused by: upstream transport unavailable credential: ' + process.env.OPENAI_API_KEY);",
      "    console.error('    at never-return-stack (' + process.cwd() + '/private-file.mjs:1:1)');",
      "  } else if (mode === 'quoted-event') {",
      `    console.log(JSON.stringify({ type: 'turn.failed', error: { message: ${JSON.stringify("The 'example_option' parameter is not supported by this endpoint.")} }, request_id: 'support-request' }));`,
      "  } else if (mode === 'quoted-stderr') {",
      `    console.error(${JSON.stringify("Error: The 'example_option' parameter is not supported by this endpoint.")});`,
      "  } else if (mode === 'quoted-secret') {",
      `    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'The "example_option" parameter is not supported by this endpoint. Provided "' + process.env.OPENAI_API_KEY + '" at "' + process.cwd() + '"; use "gpt-5.6-luna" instead.' }, request_id: 'support-request' }));`,
      "  } else {",
      "    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'Unsupported value for model_reasoning_effort. ' + process.env.OPENAI_API_KEY }, request_id: 'never-return-request' }));",
      "  }",
      "  process.exitCode = 1;",
      "});",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(parentHome, {
      "probe-key": { kind: "environment", sourceVariable: "SOURCE_OPENAI_KEY", targetVariable: "OPENAI_API_KEY" },
    });
    config.executionProviders["codex-cli"].command = executable;
    const environment = { PATH: process.env.PATH, SOURCE_OPENAI_KEY: "fake-private-key" };
    const runner = new CodexCliAgentRunner(config.executionProviders["codex-cli"], createAgentAuthProviderRegistry(config, environment), environment);
    let artifactPrefix: string | undefined;
    const probe = new ExecutionAgentAuthConnectionProbe({ get: () => ({
      providerId: runner.providerId,
      getConnectionProbeParameters: async () => ({ model: "fixture-probe-model", model_reasoning_effort: "low" }),
      preflight: (request) => runner.preflight(request),
      run: (request) => { artifactPrefix = request.artifactPrefix; return runner.run({ ...request, timeoutMs: 500 }); },
    }) }, config, directory, {});

    const result = await probe.probe({ executionProviderId: "codex-cli", authProviderId: "probe-key", modelProvider: "openai" });
    expect(result).toMatchObject({ status: "failed", mechanism: "minimal-inference" });
    expect(result.message).toContain(summary);
    const actualCwd = await fs.realpath(directory);
    const expectedReasons = reasons.map((reason) => reason.replace("[redacted path]", actualCwd));
    for (const reason of expectedReasons) expect(result.message).toContain(reason);
    if (exact) expect(result.message).toBe(`${summary} ${expectedReasons.join("\n")}`);
    expect(result.message).not.toMatch(/fake-private-key|never-return-context|never-return-stack|events:|Raw provider output/);
    if (mode === "braces" || mode === "braces-stderr") expect(result.message).toContain("payload: never-return-payload");
    expect(artifactPrefix).toBeDefined();
    await expect(fs.stat(path.dirname(artifactPrefix!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives Codex only allowlisted environment and selected authentication", async () => {
    const directory = await temporaryDirectory();
    const parentHome = path.join(directory, "parent-codex-home");
    await fs.mkdir(parentHome, { recursive: true });
    const executable = path.join(directory, "fake-codex.mjs");
    await fs.writeFile(executable, [
      `#!${process.execPath}`,
      "import { writeFileSync } from 'node:fs'",
      "if (process.argv.includes('--version')) {",
      "  process.stdout.write('codex-cli 0.0.0-test\\n')",
      "  process.exit(0)",
      "}",
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => { input += chunk })",
      "process.stdin.on('end', () => {",
      "  const index = process.argv.indexOf('--output-last-message')",
      "  const output = {",
      "    hasPath: Boolean(process.env.PATH),",
      "    apiKey: process.env.OPENAI_API_KEY,",
      "    unrelatedSecret: process.env.UNRELATED_SECRET,",
      "    codexHome: process.env.CODEX_HOME,",
      "    promptReceived: input.length > 0",
      "  }",
      "  writeFileSync(process.argv[index + 1], JSON.stringify(output))",
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')",
      "})",
      "",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(parentHome, {
      "openai-api-key": {
        kind: "environment",
        sourceVariable: "SOURCE_OPENAI_KEY",
        targetVariable: "OPENAI_API_KEY",
      },
    });
    config.executionProviders["codex-cli"] = {
      command: executable,
      heartbeatIntervalMs: 10,
      environmentAllowlist: ["PATH"],
      parentHome,
    };
    const environment = {
      PATH: process.env.PATH,
      SOURCE_OPENAI_KEY: "selected-secret",
      UNRELATED_SECRET: "must-not-be-forwarded",
    };
    const runner = new CodexCliAgentRunner(
      config.executionProviders["codex-cli"],
      createAgentAuthProviderRegistry(config, environment),
      environment,
    );

    const result = await runner.run({
      cwd: directory,
      prompt: "fixture prompt",
      timeoutMs: 5_000,
      authProviderId: "openai-api-key",
      artifactPrefix: path.join(directory, "state", "agent"),
      parameters: { model: "gpt-5.6-luna" },
    });
    const output = JSON.parse(result.output) as Record<string, unknown>;
    expect(output).toMatchObject({
      hasPath: true,
      apiKey: "[redacted]",
      promptReceived: true,
    });
    expect(output).not.toHaveProperty("unrelatedSecret");
    const codexHome = output.codexHome as string;
    expect(codexHome).toContain("agent-execution-codex-home-");
    await expect(fs.stat(codexHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights the same repository-local Codex executable that execution resolves", async () => {
    const root = await temporaryDirectory();
    const localBin = path.join(root, "node_modules", ".bin");
    const pathBin = path.join(root, "path-bin");
    const parentHome = path.join(root, "codex-home");
    await fs.mkdir(localBin, { recursive: true });
    await fs.mkdir(pathBin, { recursive: true });
    await fs.mkdir(parentHome, { recursive: true });
    const script = (loggedIn: boolean) => [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then printf '%s\\n' 'codex-cli 0.0.0-test'; exit 0; fi",
      `if [ \"$1 $2\" = \"login status\" ]; then printf '%s\\n' '${loggedIn ? "Logged in using ChatGPT" : "Not logged in"}'; ${loggedIn ? "exit 0" : "exit 1"}; fi`,
      "exit 1",
    ].join("\n");
    const repositoryCodex = path.join(localBin, "codex");
    await fs.writeFile(repositoryCodex, script(false), { mode: 0o700 });
    await fs.writeFile(path.join(pathBin, "codex"), script(true), { mode: 0o700 });
    const config = providerConfig(parentHome, {
      "codex-native-session": { kind: "runtime-native", runtime: "codex-cli" },
    });
    const environment = { PATH: `${pathBin}:${process.env.PATH ?? ""}` };
    const runner = new CodexCliAgentRunner(
      config.executionProviders["codex-cli"],
      createAgentAuthProviderRegistry(config, environment),
      environment,
    );

    await expect(runner.preflight({
      cwd: root,
      authProviderId: "codex-native-session",
      parameters: { model: "gpt-5.6-luna" },
    })).resolves.toMatchObject({
      available: false,
      resolvedCommand: repositoryCodex,
      commandSource: "repository-local",
      auth: {
        status: "unavailable",
        reason: "session-missing",
        executable: { path: repositoryCodex },
      },
    });
  });

  it("publishes a concise Codex eligibility failure while retaining raw artifacts", async () => {
    const root = await temporaryDirectory();
    const parentHome = path.join(root, "codex-home");
    const command = path.join(root, "codex");
    await fs.mkdir(parentHome, { recursive: true });
    await fs.writeFile(path.join(parentHome, "auth.json"), "{}\n", "utf8");
    await fs.writeFile(command, [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then printf '%s\\n' 'codex-cli 0.0.0-test'; exit 0; fi",
      "if [ \"$1 $2\" = \"login status\" ]; then printf '%s\\n' 'Logged in using ChatGPT'; exit 0; fi",
      "if [ \"$1\" = \"exec\" ]; then printf '%s\\n' '{\"type\":\"error\",\"message\":\"model is not available on your plan\"}'; exit 1; fi",
      "exit 1",
    ].join("\n"), { mode: 0o700 });
    const config = providerConfig(parentHome, {
      "codex-native-session": { kind: "runtime-native", runtime: "codex-cli" },
    });
    config.executionProviders["codex-cli"] = {
      command,
      heartbeatIntervalMs: 10,
      environmentAllowlist: ["PATH"],
      parentHome,
    };
    const environment = { PATH: process.env.PATH };
    const runner = new CodexCliAgentRunner(
      config.executionProviders["codex-cli"],
      createAgentAuthProviderRegistry(config, environment),
      environment,
    );
    const artifactPrefix = path.join(root, "state", "agent");

    const run = runner.run({
      cwd: root,
      prompt: "fixture prompt",
      timeoutMs: 5_000,
      authProviderId: "codex-native-session",
      artifactPrefix,
      parameters: { model: "gpt-5.6-luna" },
    });
    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining("model is not available on your plan"),
    });
    await expect(run).rejects.not.toMatchObject({
      message: expect.stringContaining("signed-in ChatGPT account or workspace cannot use model"),
    });
    await expect(fs.readFile(`${artifactPrefix}.events.jsonl`, "utf8"))
      .resolves.toContain("model is not available on your plan");
  });
});
