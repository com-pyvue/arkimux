import { promises as fs } from "node:fs";
import { createCredentialOutputRedactor, credentialValuesForRetention } from "./retainedAgentOutput.ts";
import os from "node:os";
import path from "node:path";
import type {
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
import { assertAgentNotCancelled, disposeAgentResources } from "./agentProcessLifetime.ts";
import { probeCliExecutable, resolveCliExecutable } from "./cliExecutableResolver.ts";
import { ExternalProviderError, getExternalErrorDiagnostic, publicErrorMessage, credentialSecretValues } from "../../application/externalError.ts";
import { AgentProviderFailure, type AgentExecutionFailureCode } from "../../application/agentExecutionFailure.ts";
import { connectionProbeDiagnostic, credentialDiagnosticEnvironment, providerEventDiagnostic, agentPreflightFailure } from "./connectionProbeDiagnostic.ts";
import {
  allowlistedAgentEnvironment,
  runStreamingCli,
} from "./nativeStreamingCliProcess.ts";

const providerTypes = new Set(["kimi", "anthropic", "openai"]);
const thinkingEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);

interface KimiParameters {
  model: string;
  providerType: string;
  baseUrl?: string;
  maxContextSize?: number;
  capabilities?: string[];
  thinkingEffort?: string;
}

interface ParsedKimiOutput {
  output: string;
  usage?: AgentUsage;
  toolMetrics: AgentExecutionToolMetrics;
}

export class KimiCodeCliAgentRunError extends AgentProviderFailure {
  constructor(message: string, readonly metrics: AgentExecutionMetrics, environment: NodeJS.ProcessEnv = {},
    diagnostic?: import("../../application/externalError.ts").ExternalErrorDiagnostic, failureCode?: AgentExecutionFailureCode) {
    super("kimi-code-cli", diagnostic?.message ?? connectionProbeDiagnostic(message, environment, []), {
      code: diagnostic?.code, httpStatus: diagnostic?.httpStatus, secretValues: credentialSecretValues(environment),
      status: metrics.status, failureCode,
    });
    this.name = "KimiCodeCliAgentRunError";
  }
}

function stringParameter(parameters: Record<string, ProviderParameterValue>, key: string): string | undefined {
  const value = parameters[key];
  return typeof value === "string" ? value : undefined;
}

function numberParameter(parameters: Record<string, ProviderParameterValue>, key: string): number | undefined {
  const value = parameters[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayParameter(parameters: Record<string, ProviderParameterValue>, key: string): string[] | undefined {
  const value = parameters[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function parameters(value: Record<string, ProviderParameterValue>): KimiParameters {
  const allowed = ["model", "provider-type", "base-url", "max-context-size", "capabilities", "thinking-effort"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Kimi Code CLI parameters contain unsupported keys [${unknown.join(", ")}].`);
  const model = stringParameter(value, "model");
  const providerType = stringParameter(value, "provider-type") ?? "kimi";
  const baseUrl = stringParameter(value, "base-url");
  const maxContextSize = numberParameter(value, "max-context-size");
  const capabilities = stringArrayParameter(value, "capabilities");
  const thinkingEffort = stringParameter(value, "thinking-effort");
  if (!model?.trim()) throw new Error("Kimi Code CLI parameters.model must be a non-empty string.");
  if (!providerTypes.has(providerType)) throw new Error(`Kimi Code CLI parameters.provider-type has unsupported value ${providerType}.`);
  if (baseUrl !== undefined) {
    try { new URL(baseUrl); } catch { throw new Error("Kimi Code CLI parameters.base-url must be an absolute URL."); }
  }
  if (maxContextSize !== undefined && (!Number.isInteger(maxContextSize) || maxContextSize <= 0)) {
    throw new Error("Kimi Code CLI parameters.max-context-size must be a positive integer.");
  }
  if (thinkingEffort !== undefined && !thinkingEfforts.has(thinkingEffort)) {
    throw new Error(`Kimi Code CLI parameters.thinking-effort has unsupported value ${thinkingEffort}.`);
  }
  return { model, providerType, ...(baseUrl ? { baseUrl } : {}), ...(maxContextSize ? { maxContextSize } : {}), ...(capabilities ? { capabilities } : {}), ...(thinkingEffort ? { thinkingEffort } : {}) };
}

function authContext(
  request: Pick<AgentExecutionRequest, "cwd" | "parameters">,
  executable?: AgentAuthContext["executable"],
): AgentAuthContext {
  const parsed = parameters(request.parameters);
  return { cwd: request.cwd, executionProviderId: "kimi-code-cli", modelProvider: parsed.providerType, model: parsed.model, ...(executable ? { executable } : {}) };
}

function kimiModelEnvironment(parsed: KimiParameters): NodeJS.ProcessEnv {
  return {
    KIMI_MODEL_NAME: parsed.model,
    KIMI_MODEL_PROVIDER_TYPE: parsed.providerType,
    ...(parsed.baseUrl ? { KIMI_MODEL_BASE_URL: parsed.baseUrl } : {}),
    ...(parsed.maxContextSize ? { KIMI_MODEL_MAX_CONTEXT_SIZE: String(parsed.maxContextSize) } : {}),
    ...(parsed.capabilities ? { KIMI_MODEL_CAPABILITIES: parsed.capabilities.join(",") } : {}),
    ...(parsed.thinkingEffort ? { KIMI_MODEL_THINKING_EFFORT: parsed.thinkingEffort } : {}),
    KIMI_DISABLE_TELEMETRY: "1",
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (typeof item !== "object" || item === null) return [];
    const block = item as { type?: unknown; text?: unknown };
    return (block.type === "text" || block.type === "output_text") && typeof block.text === "string" ? [block.text] : [];
  }).join("").trim();
}

export function parseKimiCodeStream(stdout: string): ParsedKimiOutput {
  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawUsage = false;
  const toolMetrics: AgentExecutionToolMetrics = { nativeToolCalls: 0, toolCallUnit: "native-tool-call" };
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
    const terminalError = providerEventDiagnostic(line);
    if (terminalError) throw new ExternalProviderError("kimi-code-cli", terminalError);
    const nested = typeof event.message === "object" && event.message !== null && !Array.isArray(event.message)
      ? event.message as Record<string, unknown>
      : undefined;
    const message = nested ?? event;
    if (message.role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      toolMetrics.nativeToolCalls += toolCalls.length;
      const text = messageText(message.content);
      if (text && toolCalls.length === 0) output = text;
    }
    const usage = typeof message.usage === "object" && message.usage !== null
      ? message.usage as Record<string, unknown>
      : typeof event.usage === "object" && event.usage !== null
        ? event.usage as Record<string, unknown>
        : undefined;
    if (usage) {
      const input = finiteNumber(usage.input_tokens ?? usage.input);
      const outputCount = finiteNumber(usage.output_tokens ?? usage.output);
      const cached = finiteNumber(usage.cached_input_tokens ?? usage.cache_read);
      if (input !== undefined || outputCount !== undefined || cached !== undefined) sawUsage = true;
      inputTokens += input ?? 0;
      outputTokens += outputCount ?? 0;
      cachedInputTokens += cached ?? 0;
    }
  }
  if (!output) throw new ExternalProviderError("kimi-code-cli", "Kimi Code JSON event stream contained no final assistant message.", { code: "invalid-provider-response" });
  return {
    output,
    toolMetrics,
    ...(sawUsage ? { usage: { inputTokens, outputTokens, cachedInputTokens } } : {}),
  };
}

export class KimiCodeCliAgentRunner implements AgentExecutionProvider {
  readonly providerId = "kimi-code-cli";

  constructor(
    private readonly runtimeConfig: AgentExecutionProviderRuntimeConfig,
    private readonly authProviders: AgentAuthProviderRegistry,
    private readonly parentEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}

  async preflight(request: AgentExecutionPreflightRequest): Promise<AgentExecutionPreflightResult> {
    const environment = allowlistedAgentEnvironment(this.runtimeConfig, this.parentEnvironment);
    const executable = await resolveCliExecutable(this.runtimeConfig.command, request.cwd, environment);
    const probe = executable ? await probeCliExecutable(
      executable.command,
      request.cwd,
      environment,
      5_000,
      this.runtimeConfig.requiredVersion,
    ) : undefined;
    const authProvider = this.authProviders.get(request.authProviderId);
    let auth;
    try {
      auth = await authProvider.preflight(authContext(request, executable ? {
        path: executable.command,
        ...(probe?.versionOutput ? { version: probe.versionOutput } : {}),
      } : undefined));
    } catch (error) {
      const message = publicErrorMessage(error, "Kimi Code authentication check failed inside ArkiMux.");
      const externalDiagnostic = getExternalErrorDiagnostic(error);
      return { providerId: this.providerId, auth: { authProviderId: request.authProviderId, kind: authProvider.kind, available: false, status: "unavailable", reason: "unknown", message }, available: false, message, ...(externalDiagnostic ? { externalDiagnostic } : {}) };
    }
    const message = !executable
      ? `Agent execution provider ${this.providerId} could not find command ${this.runtimeConfig.command}.`
      : probe?.available === false ? probe.message : auth.message;
    const externalDiagnostic = (!executable || probe?.available === false) && message
      ? new ExternalProviderError(this.providerId, message, { code: "provider-unavailable", secretValues: credentialSecretValues(environment) }).externalDiagnostic
      : auth.externalDiagnostic;
    return { providerId: this.providerId, auth, available: executable !== undefined && probe?.available === true && auth.available, ...(executable ? { resolvedCommand: executable.command, commandSource: executable.source } : {}), ...(message ? { message: externalDiagnostic?.message ?? message } : {}), ...(externalDiagnostic ? { externalDiagnostic } : {}) };
  }

  async run(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    assertAgentNotCancelled(request.signal);
    const preflight = await this.preflight(request);
    assertAgentNotCancelled(request.signal);
    if (!preflight.available) throw agentPreflightFailure(preflight, "Kimi Code CLI preflight failed inside ArkiMux.", this.parentEnvironment);
    const environment = allowlistedAgentEnvironment(this.runtimeConfig, this.parentEnvironment);
    const executable = await resolveCliExecutable(this.runtimeConfig.command, request.cwd, environment);
    if (!executable) throw new Error(`Kimi Code CLI command ${this.runtimeConfig.command} became unavailable after preflight.`);
    assertAgentNotCancelled(request.signal);
    const preparedAuth: PreparedAgentAuth = await this.authProviders.get(request.authProviderId).prepare(authContext(request, {
      path: executable.command,
      ...(preflight.auth.executable?.version ? { version: preflight.auth.executable.version } : {}),
    }));
    let isolatedHome: string | undefined, promptDirectory: string | undefined;
    try {
      assertAgentNotCancelled(request.signal);
      isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-kimi-home-"));
      promptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-kimi-prompt-"));
      const promptPath = path.join(promptDirectory, "instructions.md");
      await fs.writeFile(promptPath, request.prompt, { encoding: "utf8", mode: 0o600 });
      const parsedParameters = parameters(request.parameters);
      const shortPrompt = `Read the complete workflow instructions from ${promptPath} and follow them exactly. Treat that file as the user prompt for this run.`;
      const childEnvironment = {
        ...environment,
        ...preparedAuth.environment,
        ...kimiModelEnvironment(parsedParameters),
        KIMI_CODE_HOME: preparedAuth.credentialDirectory ?? isolatedHome,
      };
      const diagnosticEnvironment = credentialDiagnosticEnvironment(childEnvironment, preparedAuth.environment, preflight.auth.kind);
      const secretValues = credentialValuesForRetention(childEnvironment, preparedAuth.environment, preflight.auth.kind);
      const result = await runStreamingCli(request, { ...this.runtimeConfig, command: executable.command }, childEnvironment, {
        providerId: this.providerId,
        secretValues,
        args: ["--prompt", shortPrompt, "--output-format", "stream-json"],
        model: parsedParameters.model,
        reasoningEffort: parsedParameters.thinkingEffort,
      });
      const baseMetrics: AgentExecutionMetrics = {
        providerId: this.providerId,
        ...(request.label ? { label: request.label } : {}),
        ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
        model: parsedParameters.model,
        ...(parsedParameters.thinkingEffort ? { reasoningEffort: parsedParameters.thinkingEffort } : {}),
        status: result.timedOut ? "timed-out" : !result.cancelled && result.exitCode === 0 ? "complete" : "failed",
        elapsedMs: result.elapsedMs,
        artifacts: result.artifacts,
        nativeToolCalls: 0,
        toolCallUnit: "native-tool-call",
      };
      if (result.cancelled) throw new KimiCodeCliAgentRunError("Agent execution was cancelled.", baseMetrics, {}, undefined, "agent_cancelled");
      if (result.timedOut) throw new KimiCodeCliAgentRunError(`kimi timed out after ${request.timeoutMs}ms.\nstderr:\n${result.stderr}`, baseMetrics, diagnosticEnvironment);
      if (result.exitCode !== 0) throw new KimiCodeCliAgentRunError(`kimi exited with code ${result.exitCode}.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`, baseMetrics, diagnosticEnvironment);
      let parsed: ParsedKimiOutput;
      try {
        parsed = parseKimiCodeStream(result.stdout);
      } catch (error) {
        const diagnostic = getExternalErrorDiagnostic(error);
        if (!diagnostic) throw error;
        throw new KimiCodeCliAgentRunError(diagnostic.message, { ...baseMetrics, status: "failed" }, diagnosticEnvironment, diagnostic);
      }
      const output = createCredentialOutputRedactor(secretValues).redact(parsed.output);
      await fs.writeFile(result.artifacts.lastMessagePath, `${output}\n`, "utf8");
      return { output, metrics: { ...baseMetrics, ...parsed.toolMetrics, ...(parsed.usage ? { usage: parsed.usage } : {}) } };
    } finally {
      await disposeAgentResources([
        () => preparedAuth.dispose(),
        () => isolatedHome ? fs.rm(isolatedHome, { recursive: true, force: true }) : undefined,
        () => promptDirectory ? fs.rm(promptDirectory, { recursive: true, force: true }) : undefined,
      ]);
    }
  }
}
