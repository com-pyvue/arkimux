import { spawn } from "node:child_process";
import { createRetainedAgentOutput, createCredentialOutputRedactor, credentialValuesForRetention } from "./retainedAgentOutput.ts";
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentAuthContext,
  AgentAuthProviderRegistry,
  AgentExecutionArtifacts,
  AgentExecutionMetrics,
  AgentExecutionPreflightRequest,
  AgentExecutionPreflightResult,
  AgentExecutionProvider,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutionToolMetrics,
  AgentUsage,
  PiAgentExtensionProvider,
  PreparedPiAgentExtension,
  PreparedAgentAuth,
  ProviderParameterValue,
} from "../../application/agentProvider.ts";
import { NoopPiAgentExtensionProvider } from "../../application/agentProvider.ts";
import type { AgentExecutionProviderRuntimeConfig } from "./agentProviderConfigProvider.ts";
import { probeCliExecutable, resolveCliExecutable } from "./cliExecutableResolver.ts";
import { ExternalProviderError, getExternalErrorDiagnostic, publicErrorMessage, credentialSecretValues } from "../../application/externalError.ts";
import { AgentProviderFailure, type AgentExecutionFailureCode } from "../../application/agentExecutionFailure.ts";
import { connectionProbeDiagnostic, credentialDiagnosticEnvironment, agentPreflightFailure } from "./connectionProbeDiagnostic.ts";
import { agentProcessDetached, agentProcessLifetime, assertAgentNotCancelled, disposeAgentResources } from "./agentProcessLifetime.ts";

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface PiParameters {
  provider: string;
  model: string;
  thinking?: string;
}

interface PiAssistantMessage {
  role?: string;
  content?: unknown;
  usage?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

interface ParsedPiOutput {
  output: string;
  usage?: AgentUsage;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

interface PreparedPiAgentDirectory {
  path: string;
  dispose(): Promise<void>;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  artifacts: AgentExecutionArtifacts;
  elapsedMs: number;
}

export class PiCliAgentRunError extends AgentProviderFailure {
  constructor(message: string, readonly metrics: AgentExecutionMetrics, environment: NodeJS.ProcessEnv = {},
    diagnostic?: import("../../application/externalError.ts").ExternalErrorDiagnostic, failureCode?: AgentExecutionFailureCode) {
    super("pi-cli", diagnostic?.message ?? connectionProbeDiagnostic(message, environment, []), {
      code: diagnostic?.code, httpStatus: diagnostic?.httpStatus, secretValues: credentialSecretValues(environment),
      status: metrics.status, failureCode,
    });
    this.name = "PiCliAgentRunError";
  }
}

function parameterString(
  parameters: Record<string, ProviderParameterValue>,
  key: string,
): string | undefined {
  const value = parameters[key];
  return typeof value === "string" ? value : undefined;
}

function piParameters(parameters: Record<string, ProviderParameterValue>): PiParameters {
  const unknown = Object.keys(parameters).filter((key) => !["provider", "model", "thinking"].includes(key));
  if (unknown.length > 0) throw new Error(`Pi CLI parameters contain unsupported keys [${unknown.join(", ")}].`);
  const provider = parameterString(parameters, "provider");
  const model = parameterString(parameters, "model");
  const thinking = parameterString(parameters, "thinking");
  if (!provider?.trim()) throw new Error("Pi CLI parameters.provider must be a non-empty string.");
  if (!model?.trim()) throw new Error("Pi CLI parameters.model must be a non-empty string.");
  if (thinking !== undefined && !thinkingLevels.has(thinking)) {
    throw new Error(`Pi CLI parameters.thinking has unsupported value ${thinking}.`);
  }
  return { provider, model, ...(thinking === undefined ? {} : { thinking }) };
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

function runtimeEnvironment(runtimeConfig: AgentExecutionProviderRuntimeConfig): NodeJS.ProcessEnv {
  return {
    ...(runtimeConfig.offline === undefined ? {} : { PI_OFFLINE: runtimeConfig.offline ? "1" : "0" }),
    ...(runtimeConfig.telemetry === undefined ? {} : { PI_TELEMETRY: runtimeConfig.telemetry ? "1" : "0" }),
    ...(runtimeConfig.versionCheck === false ? { PI_SKIP_VERSION_CHECK: "1" } : {}),
  };
}

function authContext(
  request: Pick<AgentExecutionRequest, "cwd" | "parameters">,
  executable?: AgentAuthContext["executable"],
): AgentAuthContext {
  const parameters = piParameters(request.parameters);
  return {
    cwd: request.cwd,
    executionProviderId: "pi-cli",
    modelProvider: parameters.provider,
    model: parameters.model,
    ...(executable ? { executable } : {}),
  };
}

async function preparePiAgentDirectory(credentialDirectory: string | undefined): Promise<PreparedPiAgentDirectory> {
  const agentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-pi-agent-"));
  await fs.chmod(agentDirectory, 0o700);
  if (credentialDirectory) {
    const sourcePath = path.join(credentialDirectory, "auth.json");
    if (await pathExists(sourcePath)) {
      await fs.symlink(sourcePath, path.join(agentDirectory, "auth.json"));
    }
  }
  return {
    path: agentDirectory,
    dispose: async () => fs.rm(agentDirectory, { recursive: true, force: true }),
  };
}

function piArguments(
  parameters: PiParameters,
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  extensionArguments: string[],
): string[] {
  return [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    ...extensionArguments,
    "--no-approve",
    ...(runtimeConfig.offline ? ["--offline"] : []),
    "--provider", parameters.provider,
    "--model", parameters.model,
    ...(parameters.thinking === undefined ? [] : ["--thinking", parameters.thinking]),
  ];
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function messageText(message: PiAssistantMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const content = item as { type?: unknown; text?: unknown };
    return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
  }).join("").trim();
}

function usageProjection(messages: PiAssistantMessage[]): AgentUsage | undefined {
  let sawUsage = false;
  let sawReasoning = false;
  let sawCost = false;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let cost = 0;
  for (const message of messages) {
    const usage = message.usage;
    const input = numberField(usage, "input");
    const cacheRead = numberField(usage, "cacheRead");
    const output = numberField(usage, "output");
    const reasoning = numberField(usage, "reasoning");
    const usageCost = typeof usage === "object" && usage !== null
      ? numberField((usage as Record<string, unknown>).cost, "total")
      : undefined;
    if (input !== undefined || cacheRead !== undefined || output !== undefined) sawUsage = true;
    if (reasoning !== undefined) sawReasoning = true;
    if (usageCost !== undefined) sawCost = true;
    inputTokens += (input ?? 0) + (cacheRead ?? 0);
    cachedInputTokens += cacheRead ?? 0;
    outputTokens += output ?? 0;
    reasoningOutputTokens += reasoning ?? 0;
    cost += usageCost ?? 0;
  }
  if (!sawUsage && !sawReasoning && !sawCost) return undefined;
  return {
    ...(sawUsage ? { inputTokens, cachedInputTokens, outputTokens } : {}),
    ...(sawReasoning ? { reasoningOutputTokens } : {}),
    ...(sawCost ? { cost: { amount: cost, currency: "USD", kind: "provider-estimate" } } : {}),
  };
}

function summarizePiEventToolMetrics(stdout: string): AgentExecutionToolMetrics {
  const toolMetrics: AgentExecutionToolMetrics = {
    nativeToolCalls: 0,
    toolCallUnit: "guarded-repository-operation",
    repositorySearchCalls: 0,
    fileReadCalls: 0,
    repositoryResultBytes: 0,
    rejectedRepositoryCalls: 0,
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "tool_execution_start") {
      toolMetrics.nativeToolCalls += 1;
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      if (["grep", "find", "repo_search", "repo_list"].includes(toolName)) toolMetrics.repositorySearchCalls = (toolMetrics.repositorySearchCalls ?? 0) + 1;
      if (["read", "repo_read", "repo_batch_read"].includes(toolName)) toolMetrics.fileReadCalls = (toolMetrics.fileReadCalls ?? 0) + 1;
    }
  }
  return toolMetrics;
}

function parsePiOutput(stdout: string): ParsedPiOutput {
  const assistantMessages: PiAssistantMessage[] = [];
  const finalMessages: PiAssistantMessage[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "message_end" || typeof event.message !== "object" || event.message === null) continue;
    const message = event.message as PiAssistantMessage;
    if (message.role !== "assistant") continue;
    assistantMessages.push(message);
    if (["stop", "length"].includes(message.stopReason ?? "")) finalMessages.push(message);
    if (["error", "aborted"].includes(message.stopReason ?? "")) {
      throw new ExternalProviderError("pi-cli", `Pi assistant message failed with ${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ""}.`);
    }
  }
  if (finalMessages.length !== 1) {
    throw new ExternalProviderError("pi-cli", `Pi JSON event stream contained ${finalMessages.length} successful final assistant messages; expected exactly one.`, { code: "invalid-provider-response" });
  }
  const output = messageText(finalMessages[0] as PiAssistantMessage);
  if (!output) throw new ExternalProviderError("pi-cli", "Pi JSON event stream contained an empty final assistant message.", { code: "invalid-provider-response" });
  const usage = usageProjection(assistantMessages);
  return {
    output,
    ...(usage === undefined ? {} : { usage }),
  };
}

async function runPi(
  request: AgentExecutionRequest,
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  agentDirectory: string,
  childEnvironment: NodeJS.ProcessEnv,
  extension: PreparedPiAgentExtension,
  secretValues: readonly string[],
): Promise<SpawnResult> {
  const artifactPrefix = request.artifactPrefix
    ?? path.join(os.tmpdir(), `agent-execution-agent-${process.pid}-${randomUUID()}`);
  const artifacts: AgentExecutionArtifacts = {
    eventsPath: `${artifactPrefix}.events.jsonl`,
    stderrPath: `${artifactPrefix}.stderr.log`,
    lastMessagePath: `${artifactPrefix}.last-message.txt`,
    heartbeatPath: `${artifactPrefix}.heartbeat.json`,
    ...extension.artifacts,
  };
  await fs.mkdir(path.dirname(artifactPrefix), { recursive: true });
  await fs.writeFile(artifacts.eventsPath, "", "utf8");
  await fs.writeFile(artifacts.stderrPath, "", "utf8");
  await fs.rm(artifacts.lastMessagePath, { force: true });
  assertAgentNotCancelled(request.signal);

  return new Promise((resolve, reject) => {
    const parameters = piParameters(request.parameters);
    const eventsStream = createWriteStream(artifacts.eventsPath, { flags: "a" });
    const stderrStream = createWriteStream(artifacts.stderrPath, { flags: "a" });
    const retained = createRetainedAgentOutput(eventsStream, stderrStream, secretValues);
    const child = spawn(runtimeConfig.command, piArguments(parameters, runtimeConfig, extension.arguments), {
      cwd: request.cwd,
      env: {
        ...childEnvironment,
        ...runtimeEnvironment(runtimeConfig),
        PI_CODING_AGENT_DIR: agentDirectory,
        ...extension.environment,
      },
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
    const heartbeat = (status: string) => {
      return {
        providerId: "pi-cli",
        label: request.label,
        attempt: request.attempt,
        model: parameters.model,
        reasoningEffort: parameters.thinking,
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
    const lifetime = agentProcessLifetime({ child, signal: request.signal, timeoutMs: request.timeoutMs,
      heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs, heartbeatPath: artifacts.heartbeatPath, heartbeat, streams: [eventsStream, stderrStream] });

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
          const event = JSON.parse(line) as { type?: string };
          lastEventType = event.type;
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
      try { retained.finish(); await lifetime.finish(exitCode); } catch (error) { reject(error); return; }
      resolve({ stdout, stderr, exitCode, signal, timedOut: lifetime.timedOut, cancelled: lifetime.cancelled, artifacts, elapsedMs: Date.now() - startedAt });
    });

    child.stdin.end(request.prompt);
  });
}

export class PiCliAgentRunner implements AgentExecutionProvider {
  readonly providerId = "pi-cli";

  constructor(
    private readonly runtimeConfig: AgentExecutionProviderRuntimeConfig,
    private readonly authProviders: AgentAuthProviderRegistry,
    private readonly parentEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly extensionProvider: PiAgentExtensionProvider = new NoopPiAgentExtensionProvider(),
  ) {}

  async preflight(request: AgentExecutionPreflightRequest): Promise<AgentExecutionPreflightResult> {
    const environment = allowlistedEnvironment(this.runtimeConfig, this.parentEnvironment);
    const executable = await resolveCliExecutable(this.runtimeConfig.command, request.cwd, environment);
    const probe = executable
      ? await probeCliExecutable(executable.command, request.cwd, environment, 5_000, this.runtimeConfig.requiredVersion)
      : undefined;
    if (!executable || !probe?.available) {
      const failure = new ExternalProviderError(this.providerId, probe?.message ?? `Agent execution provider pi-cli could not find command ${this.runtimeConfig.command}.`, { code: "provider-unavailable", secretValues: credentialSecretValues(environment) });
      const message = failure.message;
      return { providerId: this.providerId, available: false, message, externalDiagnostic: failure.externalDiagnostic,
        auth: { authProviderId: request.authProviderId, kind: this.authProviders.get(request.authProviderId).kind,
          available: false, status: "unavailable", reason: "provider-unavailable", message },
        ...(executable ? { resolvedCommand: executable.command, commandSource: executable.source } : {}),
      };
    }
    const authProvider = this.authProviders.get(request.authProviderId);
    let auth;
    try {
      auth = await authProvider.preflight(authContext(request, executable ? {
        path: executable.command,
        ...(probe?.versionOutput ? { version: probe.versionOutput } : {}),
      } : undefined));
    } catch (error) {
      const externalDiagnostic = getExternalErrorDiagnostic(error);
      return {
        providerId: this.providerId,
        auth: {
          authProviderId: request.authProviderId,
          kind: authProvider.kind,
          available: false,
          status: "unavailable",
          reason: "unknown",
          message: publicErrorMessage(error, "Pi authentication check failed inside ArkiMux."),
        },
        available: false,
        message: publicErrorMessage(error, "Pi authentication check failed inside ArkiMux."),
        ...(externalDiagnostic ? { externalDiagnostic } : {}),
      };
    }
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
    if (!preflight.available) throw agentPreflightFailure(preflight, "Pi CLI preflight failed inside ArkiMux.", this.parentEnvironment);
    const executable = await resolveCliExecutable(
      this.runtimeConfig.command,
      request.cwd,
      allowlistedEnvironment(this.runtimeConfig, this.parentEnvironment),
    );
    if (!executable) throw new Error(`Pi CLI command ${this.runtimeConfig.command} became unavailable after preflight.`);
    assertAgentNotCancelled(request.signal);
    const preparedAuth: PreparedAgentAuth = await this.authProviders
      .get(request.authProviderId)
      .prepare(authContext(request, {
        path: executable.command,
        ...(preflight.auth.executable?.version ? { version: preflight.auth.executable.version } : {}),
      }));
    let agentDirectory: PreparedPiAgentDirectory | undefined;
    let extension: PreparedPiAgentExtension | undefined;
    try {
      assertAgentNotCancelled(request.signal);
      agentDirectory = await preparePiAgentDirectory(preparedAuth.credentialDirectory);
      const artifactPrefix = request.artifactPrefix
        ?? path.join(os.tmpdir(), `agent-execution-agent-${process.pid}-${randomUUID()}`);
      extension = await this.extensionProvider.prepare({
        cwd: request.cwd,
        agentDirectory: agentDirectory.path,
        artifactPrefix,
      });
      const childEnvironment = { ...allowlistedEnvironment(this.runtimeConfig, this.parentEnvironment), ...preparedAuth.environment };
      const diagnosticEnvironment = credentialDiagnosticEnvironment(childEnvironment, preparedAuth.environment, preflight.auth.kind);
      const secretValues = credentialValuesForRetention(childEnvironment, preparedAuth.environment, preflight.auth.kind);
      const result = await runPi(
        { ...request, artifactPrefix },
        { ...this.runtimeConfig, command: executable.command },
        agentDirectory.path,
        childEnvironment,
        extension,
        secretValues,
      );
      const parameters = piParameters(request.parameters);
      const extensionToolMetrics = await extension.collectToolMetrics().catch(() => undefined);
      const observedToolMetrics = extensionToolMetrics ?? summarizePiEventToolMetrics(result.stdout);
      const baseMetrics: AgentExecutionMetrics = {
        providerId: this.providerId,
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
        model: parameters.model,
        ...(parameters.thinking === undefined ? {} : { reasoningEffort: parameters.thinking }),
        status: result.timedOut ? "timed-out" : !result.cancelled && result.exitCode === 0 ? "complete" : "failed",
        elapsedMs: result.elapsedMs,
        artifacts: result.artifacts,
        ...observedToolMetrics,
      };
      if (result.cancelled) throw new PiCliAgentRunError("Agent execution was cancelled.", baseMetrics, {}, undefined, "agent_cancelled");
      if (result.timedOut) {
        throw new PiCliAgentRunError(`pi timed out after ${request.timeoutMs}ms.\nstderr:\n${result.stderr}`, baseMetrics, diagnosticEnvironment);
      }
      if (result.exitCode !== 0) {
        throw new PiCliAgentRunError(`pi exited with code ${result.exitCode}.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`, baseMetrics, diagnosticEnvironment);
      }
      let parsed: ParsedPiOutput;
      try {
        parsed = parsePiOutput(result.stdout);
      } catch (error) {
        const diagnostic = getExternalErrorDiagnostic(error);
        if (!diagnostic) throw error;
        throw new PiCliAgentRunError(diagnostic.message, { ...baseMetrics, status: "failed" }, diagnosticEnvironment, diagnostic);
      }
      const output = createCredentialOutputRedactor(secretValues).redact(parsed.output);
      await fs.writeFile(result.artifacts.lastMessagePath, `${output}\n`, "utf8");
      return {
        output,
        metrics: {
          ...baseMetrics,
          ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        },
      };
    } finally {
      await disposeAgentResources([
        () => extension?.dispose(),
        () => agentDirectory?.dispose(),
        () => preparedAuth.dispose(),
      ]);
    }
  }
}
