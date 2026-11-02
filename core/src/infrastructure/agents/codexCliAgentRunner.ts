import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentExecutionArtifacts,
  AgentAuthContext,
  AgentAuthProviderRegistry,
  AgentExecutionMetrics,
  AgentExecutionPreflightRequest,
  AgentExecutionPreflightResult,
  AgentExecutionProvider,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutionToolMetrics,
  AgentUsage,
  PreparedAgentAuth,
  ProviderParameterValue,
} from "../../application/agentProvider.ts";
import type { AgentExecutionProviderRuntimeConfig } from "./agentProviderConfigProvider.ts";
import { probeCliExecutable, resolveCliExecutable } from "./cliExecutableResolver.ts";
import { codexConfigArguments } from "./codexParameters.ts";
import { agentProcessDetached, agentProcessLifetime, assertAgentNotCancelled, disposeAgentResources } from "./agentProcessLifetime.ts";
import { connectionProbeDiagnostic, credentialDiagnosticEnvironment, providerEventDiagnostic, agentPreflightFailure } from "./connectionProbeDiagnostic.ts";
import { loadCodexCliProbeParameters } from "./codexCliModelCatalog.ts";
import { ExternalProviderError, credentialSecretValues, redactExternalSecrets } from "../../application/externalError.ts";
import { createRetainedAgentOutput, createCredentialOutputRedactor, credentialValuesForRetention } from "./retainedAgentOutput.ts";
import { AgentProviderFailure, type AgentExecutionFailureCode } from "../../application/agentExecutionFailure.ts";

type CodexCliRunOptions = AgentExecutionRequest;

export class CodexCliAgentRunError extends AgentProviderFailure {
  constructor(message: string, readonly metrics: AgentExecutionMetrics, readonly probeDiagnostic?: string,
    failureCode?: AgentExecutionFailureCode) {
    super("codex-cli", probeDiagnostic ?? message, { status: metrics.status, failureCode });
    this.name = "CodexCliAgentRunError";
  }
}

type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  artifacts: AgentExecutionArtifacts;
  elapsedMs: number;
  toolMetrics: AgentExecutionToolMetrics;
  usage?: AgentUsage;
};

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function parameterString(
  options: Pick<CodexCliRunOptions, "parameters">,
  key: string,
): string | undefined {
  const value = options.parameters?.[key];
  return typeof value === "string" ? value : undefined;
}

function artifactSummary(artifacts: AgentExecutionArtifacts): string {
  return [
    `events: ${artifacts.eventsPath}`,
    `stderr: ${artifacts.stderrPath}`,
    `lastMessage: ${artifacts.lastMessagePath}`,
    `heartbeat: ${artifacts.heartbeatPath}`,
  ].join("\n");
}

export interface CodexEventSummary {
  toolMetrics: AgentExecutionToolMetrics;
  usage?: AgentUsage;
}

function diagnosticStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(diagnosticStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
    /^(?:type|code|message|error|detail|reason)$/i.test(key) || typeof child === "object"
      ? diagnosticStrings(child)
      : []
  ));
}

function codexFailureDiagnostics(stdout: string, stderr: string): string {
  const structured = stdout.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      return /error|fail/i.test(type) || event.error !== undefined
        ? diagnosticStrings(event)
        : [];
    } catch {
      return [];
    }
  });
  return [stderr, ...structured].filter(Boolean).join("\n");
}

export function codexExecutionFailureMessage(
  stdout: string,
  stderr: string,
  auth: AgentExecutionPreflightResult["auth"],
  model?: string,
): string | undefined {
  const diagnostics = codexFailureDiagnostics(stdout, stderr);
  if (!diagnostics) return undefined;
  // Preserve the provider's words. Account/model classifications are not a substitute.
  return connectionProbeDiagnostic(`codex exec exited with code 1.\nstderr:\n${stderr}\nstdout:\n${stdout}`, {}, []);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function summarizeCodexEvents(events: string): CodexEventSummary {
  const metrics: AgentExecutionToolMetrics = {
    nativeToolCalls: 0,
    toolCallUnit: "shell-command",
    repositorySearchCalls: 0,
    fileReadCalls: 0,
    repositoryResultBytes: 0,
  };
  let usage: AgentUsage | undefined;
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; command?: string; aggregated_output?: string };
        usage?: Record<string, unknown>;
      };
      if (event.type === "item.completed" && event.item?.type === "command_execution") {
        metrics.nativeToolCalls += 1;
        const command = event.item.command?.toLowerCase() ?? "";
        if (/\b(rg|grep|find|glob|search)\b/.test(command)) metrics.repositorySearchCalls = (metrics.repositorySearchCalls ?? 0) + 1;
        if (/\b(cat|sed|head|tail|nl|read)\b/.test(command)) metrics.fileReadCalls = (metrics.fileReadCalls ?? 0) + 1;
        metrics.repositoryResultBytes = (metrics.repositoryResultBytes ?? 0)
          + Buffer.byteLength(event.item.aggregated_output ?? "");
      }
      if (event.type === "turn.completed" && event.usage) {
        const inputTokens = finiteNumber(event.usage.input_tokens);
        const cachedInputTokens = finiteNumber(event.usage.cached_input_tokens);
        const outputTokens = finiteNumber(event.usage.output_tokens);
        const reasoningOutputTokens = finiteNumber(event.usage.reasoning_output_tokens);
        if (
          inputTokens !== undefined
          || cachedInputTokens !== undefined
          || outputTokens !== undefined
          || reasoningOutputTokens !== undefined
        ) {
          usage = {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
          };
        }
      }
    } catch {
      // The event stream is diagnostic telemetry; one malformed line must not fail discovery.
    }
  }
  return { toolMetrics: metrics, ...(usage === undefined ? {} : { usage }) };
}

async function linkParentCodexFile(parentHome: string, childHome: string, fileName: string): Promise<void> {
  const sourcePath = path.join(parentHome, fileName);
  if (!(await pathExists(sourcePath))) {
    return;
  }
  const targetPath = path.join(childHome, fileName);
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink() && (await fs.readlink(targetPath)) === sourcePath) {
      return;
    }
    await fs.rm(targetPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await fs.symlink(sourcePath, targetPath);
}

async function readTopLevelTomlString(filePath: string, key: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }
  const content = await fs.readFile(filePath, "utf8");
  const topLevelContent = content.split(/\r?\n\[/, 1)[0] ?? "";
  const match = topLevelContent.match(new RegExp(`^${key}\\s*=\\s*("([^"\\\\]|\\\\.)*"|'([^'\\\\]|\\\\.)*')\\s*$`, "m"));
  return match?.[1];
}

async function writeChildCodexConfig(parentHome: string, childHome: string): Promise<void> {
  const parentConfigPath = path.join(parentHome, "config.toml");
  const lines: string[] = [];
  for (const key of ["model", "model_reasoning_effort"]) {
    const value = await readTopLevelTomlString(parentConfigPath, key);
    if (value) {
      lines.push(`${key} = ${value}`);
    }
  }
  lines.push("");
  await fs.writeFile(path.join(childHome, "config.toml"), lines.join("\n"), { mode: 0o600 });
}

interface PreparedCodexHome {
  path: string;
  dispose(): Promise<void>;
}

async function prepareChildCodexHome(
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  credentialDirectory: string | undefined,
  includePersonalSettings = true,
): Promise<PreparedCodexHome> {
  const configuredHome = runtimeConfig.childHome;
  const childHome = configuredHome
    ? path.resolve(configuredHome)
    : await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-codex-home-"));
  const parentHome = path.resolve(runtimeConfig.parentHome ?? path.join(os.homedir(), ".codex"));

  await fs.mkdir(childHome, { recursive: true, mode: 0o700 });
  await fs.chmod(childHome, 0o700);

  if (credentialDirectory) await linkParentCodexFile(credentialDirectory, childHome, "auth.json");
  if (includePersonalSettings) {
    await linkParentCodexFile(parentHome, childHome, "AGENTS.md");
    await writeChildCodexConfig(parentHome, childHome);
  } else {
    await fs.writeFile(path.join(childHome, "config.toml"), "", { mode: 0o600 });
  }

  return {
    path: childHome,
    dispose: configuredHome
      ? async () => {
          if (!credentialDirectory) return;
          const authPath = path.join(childHome, "auth.json");
          const sourcePath = path.join(credentialDirectory, "auth.json");
          const stat = await fs.lstat(authPath).catch(() => undefined);
          if (stat?.isSymbolicLink() && (await fs.readlink(authPath)) === sourcePath) {
            await fs.rm(authPath, { force: true });
          }
        }
      : async () => fs.rm(childHome, { recursive: true, force: true }),
  };
}

function allowlistedEnvironment(
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(runtimeConfig.environmentAllowlist.flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function authContext(
  options: Pick<CodexCliRunOptions, "cwd" | "parameters">,
  executable?: AgentAuthContext["executable"],
): AgentAuthContext {
  const modelProvider = parameterString(options, "model_provider") ?? "openai";
  const model = parameterString(options, "model");
  return {
    cwd: options.cwd,
    executionProviderId: "codex-cli",
    modelProvider,
    ...(model === undefined ? {} : { model }),
    ...(executable ? { executable } : {}),
  };
}

async function runCodexExec(
  options: CodexCliRunOptions & { codexHome: string; privateOutputDirectory: string },
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  childEnvironment: NodeJS.ProcessEnv,
  secretValues: readonly string[],
): Promise<SpawnResult> {
  const artifactPrefix = options.artifactPrefix ?? path.join(os.tmpdir(), `agent-execution-agent-${process.pid}-${randomUUID()}`);
  const artifacts: AgentExecutionArtifacts = {
    eventsPath: `${artifactPrefix}.events.jsonl`,
    stderrPath: `${artifactPrefix}.stderr.log`,
    lastMessagePath: `${artifactPrefix}.last-message.txt`,
    heartbeatPath: `${artifactPrefix}.heartbeat.json`,
  };
  await fs.mkdir(path.dirname(artifactPrefix), { recursive: true });
  await fs.writeFile(artifacts.eventsPath, "", "utf8");
  await fs.writeFile(artifacts.stderrPath, "", "utf8");
  await fs.rm(artifacts.lastMessagePath, { force: true });
  assertAgentNotCancelled(options.signal);
  const privateLastMessage = path.join(options.privateOutputDirectory, "last-message.txt");

  return new Promise((resolve, reject) => {
    const args = [
      "exec",
      ...codexConfigArguments(options.parameters),
      "--strict-config",
      "--json",
      "--output-last-message",
      privateLastMessage,
      "--ephemeral",
      "--disable",
      "apps",
      "--disable",
      "enable_mcp_apps",
      "--disable",
      "plugins",
      "--disable",
      "remote_plugin",
      "--disable",
      "plugin_sharing",
      "--skip-git-repo-check",
      "-",
    ];
    const eventsStream = createWriteStream(artifacts.eventsPath, { flags: "a" });
    const stderrStream = createWriteStream(artifacts.stderrPath, { flags: "a" });
    const retained = createRetainedAgentOutput(eventsStream, stderrStream, secretValues);
    const child = spawn(runtimeConfig.command, args, {
      cwd: options.cwd,
      env: { ...childEnvironment, CODEX_HOME: options.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      detached: agentProcessDetached(),
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLineBuffer = "";
    let lastEventAt: string | undefined;
    let lastEventType: string | undefined;
    const startedAt = Date.now();
    const heartbeatIntervalMs = runtimeConfig.heartbeatIntervalMs;
    const heartbeat = (status: string) => {
      return {
        label: options.label,
        attempt: options.attempt,
        model: parameterString(options, "model"),
        reasoningEffort: parameterString(options, "model_reasoning_effort"),
        status,
        pid: child.pid,
        elapsedMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        lastEventAt,
        lastEventType: typeof lastEventType === "string" ? retained.redact(lastEventType) : undefined,
        lastStderrLine: retained.lastStderrLine,
        artifacts,
        updatedAt: new Date().toISOString(),
      };
    };
    const lifetime = agentProcessLifetime({ child, signal: options.signal, timeoutMs: options.timeoutMs,
      heartbeatIntervalMs, heartbeatPath: artifacts.heartbeatPath, heartbeat, streams: [eventsStream, stderrStream] });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk);
      retained.stdout(chunk);
      stdoutLineBuffer += chunk;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        lastEventAt = new Date().toISOString();
        try {
          const event = JSON.parse(line) as { type?: string; msg?: { type?: string } };
          lastEventType = event.type ?? event.msg?.type;
        } catch {
          lastEventType = "unparseable-json-event";
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderrBytes += Buffer.byteLength(chunk);
      retained.stderr(chunk);
    });
    child.on("close", async (exitCode, signal) => {
      try {
        retained.finish();
        await lifetime.finish(exitCode);
        const message = await fs.readFile(privateLastMessage, "utf8").catch(error => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (message !== undefined) await fs.writeFile(artifacts.lastMessagePath, retained.redact(message), "utf8");
      } catch (error) { reject(error); return; }
      const summary = summarizeCodexEvents(stdout);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut: lifetime.timedOut,
        cancelled: lifetime.cancelled,
        artifacts,
        elapsedMs: Date.now() - startedAt,
        toolMetrics: summary.toolMetrics,
        ...(summary.usage === undefined ? {} : { usage: summary.usage }),
      });
    });

    // The CLI reads `-` from stdin. This avoids the operating system's argv
    // ceiling for agent instructions while keeping the command invocation
    // deterministic and fully captured in the normal artifacts.
    child.stdin.end(options.prompt);
  });
}

export class CodexCliAgentRunner implements AgentExecutionProvider {
  readonly providerId = "codex-cli";

  constructor(
    private readonly runtimeConfig: AgentExecutionProviderRuntimeConfig,
    private readonly authProviders: AgentAuthProviderRegistry,
    private readonly parentEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}

  async getConnectionProbeParameters(
    request: AgentExecutionPreflightRequest & { timeoutMs: number },
  ): Promise<Record<string, ProviderParameterValue>> {
    const deadline = Date.now() + Math.min(15_000, request.timeoutMs);
    const environment = allowlistedEnvironment(this.runtimeConfig, this.parentEnvironment);
    const executable = await resolveCliExecutable(this.runtimeConfig.command, request.cwd, environment);
    if (!executable) throw new Error("Codex CLI became unavailable before model discovery. Check the CLI installation and retry.");
    const preparedAuth = await this.authProviders.get(request.authProviderId).prepare(authContext(request, { path: executable.command }));
    let codexHome: PreparedCodexHome | undefined;
    try {
      // Reuse the selected Connection's auth preparation, but never load project
      // or personal model/MCP settings for this metadata-only process.
      codexHome = await prepareChildCodexHome({ ...this.runtimeConfig, childHome: undefined }, preparedAuth.credentialDirectory, false);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("Codex model discovery timed out before reading the catalog. Retry Test connection.");
      return await loadCodexCliProbeParameters({
        command: executable.command,
        cwd: codexHome.path,
        environment: { ...environment, ...preparedAuth.environment, CODEX_HOME: codexHome.path },
        timeoutMs: remainingMs,
        secretValues: Object.values(preparedAuth.environment).filter((value): value is string => typeof value === "string"),
      });
    } finally {
      await disposeAgentResources([() => codexHome?.dispose(), () => preparedAuth.dispose()]);
    }
  }

  async preflight(request: AgentExecutionPreflightRequest): Promise<AgentExecutionPreflightResult> {
    const environment = allowlistedEnvironment(this.runtimeConfig, this.parentEnvironment);
    const executable = await resolveCliExecutable(this.runtimeConfig.command, request.cwd, environment);
    const probe = executable
      ? await probeCliExecutable(executable.command, request.cwd, environment, 5_000, this.runtimeConfig.requiredVersion)
      : undefined;
    if (!executable || !probe?.available) {
      const failure = new ExternalProviderError(this.providerId, probe?.message ?? `Agent execution provider codex-cli could not find command ${this.runtimeConfig.command}.`, { code: "provider-unavailable", secretValues: credentialSecretValues(environment) });
      const message = failure.message;
      return { providerId: this.providerId, available: false, message, externalDiagnostic: failure.externalDiagnostic,
        auth: { authProviderId: request.authProviderId, kind: this.authProviders.get(request.authProviderId).kind,
          available: false, status: "unavailable", reason: "provider-unavailable", message },
        ...(executable ? { resolvedCommand: executable.command, commandSource: executable.source } : {}),
      };
    }
    const auth = await this.authProviders.get(request.authProviderId).preflight(authContext(request, executable ? {
      path: executable.command,
      ...(probe?.versionOutput ? { version: probe.versionOutput } : {}),
    } : undefined));
    const message = auth.message;
    return {
      providerId: this.providerId,
      auth,
      available: executable !== undefined && probe?.available === true && auth.available,
      ...(executable === undefined ? {} : {
        resolvedCommand: executable.command,
        commandSource: executable.source,
      }),
      ...(message === undefined ? {} : { message }),
      ...(auth.externalDiagnostic ? { externalDiagnostic: auth.externalDiagnostic } : {}),
    };
  }

  async run(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    assertAgentNotCancelled(request.signal);
    const preflight = await this.preflight(request);
    assertAgentNotCancelled(request.signal);
    if (!preflight.available) throw agentPreflightFailure(preflight, "Codex CLI preflight failed inside ArkiMux.", this.parentEnvironment);
    const executable = await resolveCliExecutable(
      this.runtimeConfig.command,
      request.cwd,
      allowlistedEnvironment(this.runtimeConfig, this.parentEnvironment),
    );
    if (!executable) throw new Error(`Codex CLI command ${this.runtimeConfig.command} became unavailable after preflight.`);
    assertAgentNotCancelled(request.signal);
    const preparedAuth: PreparedAgentAuth = await this.authProviders
      .get(request.authProviderId)
      .prepare(authContext(request, {
        path: executable.command,
        ...(preflight.auth.executable?.version ? { version: preflight.auth.executable.version } : {}),
      }));
    let codexHome: PreparedCodexHome | undefined;
    let privateOutputDirectory: string | undefined;
    try {
      assertAgentNotCancelled(request.signal);
      codexHome = await prepareChildCodexHome(this.runtimeConfig, preparedAuth.credentialDirectory);
      privateOutputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-codex-output-"));
      const childEnvironment = {
        ...allowlistedEnvironment(this.runtimeConfig, this.parentEnvironment),
        ...preparedAuth.environment,
      };
      const secretValues = credentialValuesForRetention(childEnvironment, preparedAuth.environment, preflight.auth.kind);
      const result = await runCodexExec(
        { ...request, codexHome: codexHome.path, privateOutputDirectory },
        { ...this.runtimeConfig, command: executable.command },
        childEnvironment,
        secretValues,
      );
      const output = createCredentialOutputRedactor(secretValues).redact((await fs.readFile(result.artifacts.lastMessagePath, "utf8")
        .catch(() => result.stdout)).trim());
      const model = parameterString(request, "model");
      const reasoningEffort = parameterString(request, "model_reasoning_effort");
      const metrics: AgentExecutionMetrics = {
        providerId: this.providerId,
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        status: result.timedOut ? "timed-out" : !result.cancelled && result.exitCode === 0 ? "complete" : "failed",
        elapsedMs: result.elapsedMs,
        artifacts: result.artifacts,
        ...result.toolMetrics,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };

      // Probe logs are deleted. Preserve a separate safe reason, without changing Run artifacts.
      const probePrivatePaths = [request.cwd, codexHome.path];
      const probeDiagnostic = (summary: string) => connectionProbeDiagnostic(
        `${summary}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
        credentialDiagnosticEnvironment(childEnvironment, preparedAuth.environment, preflight.auth.kind),
        probePrivatePaths,
      );
      if (result.cancelled) throw new CodexCliAgentRunError("Agent execution was cancelled.", metrics, undefined, "agent_cancelled");
      if (result.timedOut) {
        throw new CodexCliAgentRunError(`codex exec timed out after ${request.timeoutMs}ms.\n${artifactSummary(result.artifacts)}\nstderr:\n${result.stderr.slice(0, 2000)}`, metrics,
          probeDiagnostic(`codex exec timed out after ${request.timeoutMs}ms.`));
      }
      if (result.exitCode !== 0) {
        throw new CodexCliAgentRunError(
          `codex exec exited with code ${result.exitCode}.`,
          metrics,
          probeDiagnostic(`codex exec exited with code ${result.exitCode}.`),
        );
      }
      const terminalError = result.stdout.split(/\r?\n/).map(providerEventDiagnostic).filter((message): message is string => message !== undefined).join("\n");
      if (terminalError) throw new CodexCliAgentRunError(terminalError, { ...metrics, status: "failed" },
        redactExternalSecrets(terminalError, credentialSecretValues(credentialDiagnosticEnvironment(childEnvironment, preparedAuth.environment, preflight.auth.kind))));
      if (!output) {
        throw new CodexCliAgentRunError(`codex exec produced empty last message.\n${artifactSummary(result.artifacts)}\nstderr:\n${result.stderr.slice(0, 2000)}`, metrics,
          probeDiagnostic("codex exec produced empty last message."));
      }

      return { output, metrics };
    } finally {
      await disposeAgentResources([
        () => privateOutputDirectory ? fs.rm(privateOutputDirectory, { recursive: true, force: true }) : undefined,
        () => codexHome?.dispose(),
        () => preparedAuth.dispose(),
      ]);
    }
  }
}
