import { promises as fs } from "node:fs";
import { createCredentialOutputRedactor, credentialValuesForRetention } from "./retainedAgentOutput.ts";
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

const effortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);
const permissionModes = new Set(["default", "acceptEdits", "plan", "auto", "manual", "dontAsk", "bypassPermissions"]);

interface ClaudeParameters {
  model: string;
  effort?: string;
  permissionMode?: string;
  maxBudgetUsd?: number;
}

interface ParsedClaudeOutput {
  output: string;
  usage?: AgentUsage;
  toolMetrics: AgentExecutionToolMetrics;
}

export class ClaudeCodeCliAgentRunError extends AgentProviderFailure {
  constructor(message: string, readonly metrics: AgentExecutionMetrics, environment: NodeJS.ProcessEnv = {},
    diagnostic?: import("../../application/externalError.ts").ExternalErrorDiagnostic, failureCode?: AgentExecutionFailureCode) {
    super("claude-code-cli", diagnostic?.message ?? connectionProbeDiagnostic(message, environment, []), {
      code: diagnostic?.code, httpStatus: diagnostic?.httpStatus, secretValues: credentialSecretValues(environment),
      status: metrics.status, failureCode,
    });
    this.name = "ClaudeCodeCliAgentRunError";
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

function parameters(value: Record<string, ProviderParameterValue>): ClaudeParameters {
  const allowed = ["model", "effort", "permission-mode", "max-budget-usd"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Claude Code CLI parameters contain unsupported keys [${unknown.join(", ")}].`);
  const model = stringParameter(value, "model");
  const effort = stringParameter(value, "effort");
  const permissionMode = stringParameter(value, "permission-mode");
  const maxBudgetUsd = numberParameter(value, "max-budget-usd");
  if (!model?.trim()) throw new Error("Claude Code CLI parameters.model must be a non-empty string.");
  if (effort !== undefined && !effortLevels.has(effort)) throw new Error(`Claude Code CLI parameters.effort has unsupported value ${effort}.`);
  if (permissionMode !== undefined && !permissionModes.has(permissionMode)) {
    throw new Error(`Claude Code CLI parameters.permission-mode has unsupported value ${permissionMode}.`);
  }
  if (maxBudgetUsd !== undefined && maxBudgetUsd <= 0) {
    throw new Error("Claude Code CLI parameters.max-budget-usd must be positive.");
  }
  return { model, ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}), ...(maxBudgetUsd ? { maxBudgetUsd } : {}) };
}

function authContext(
  request: Pick<AgentExecutionRequest, "cwd" | "parameters">,
  executable?: AgentAuthContext["executable"],
): AgentAuthContext {
  const parsed = parameters(request.parameters);
  return { cwd: request.cwd, executionProviderId: "claude-code-cli", modelProvider: "anthropic", model: parsed.model, ...(executable ? { executable } : {}) };
}

function claudeArguments(parsed: ClaudeParameters): string[] {
  return [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--model", parsed.model,
    ...(parsed.effort ? ["--effort", parsed.effort] : []),
    ...(parsed.permissionMode && parsed.permissionMode !== "default" ? ["--permission-mode", parsed.permissionMode] : []),
    ...(parsed.maxBudgetUsd ? ["--max-budget-usd", String(parsed.maxBudgetUsd)] : []),
  ];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const block = item as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("").trim();
}

function claudeToolMetrics(stdout: string): AgentExecutionToolMetrics {
  let nativeToolCalls = 0;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } } | null;
      if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
        nativeToolCalls += event.message.content.filter((block: unknown) =>
          typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_use").length;
      }
    } catch { /* Incomplete/non-JSON diagnostics do not invent tool observations. */ }
  }
  return { nativeToolCalls, toolCallUnit: "native-tool-call" };
}

export function parseClaudeCodeStream(stdout: string): ParsedClaudeOutput {
  let output = "";
  let usage: AgentUsage | undefined;
  let cost: number | undefined;
  const toolMetrics = claudeToolMetrics(stdout);
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
    const message = typeof event.message === "object" && event.message !== null
      ? event.message as Record<string, unknown>
      : undefined;
    if (event.type === "result") {
      if (event.is_error === true) throw new ExternalProviderError("claude-code-cli", providerEventDiagnostic(line)!);
      const result = typeof event.result === "string" ? event.result.trim() : "";
      if (result) output = result;
      const rawUsage = typeof event.usage === "object" && event.usage !== null
        ? event.usage as Record<string, unknown>
        : undefined;
      if (rawUsage) {
        const inputTokens = finiteNumber(rawUsage.input_tokens);
        const cachedInputTokens = finiteNumber(rawUsage.cache_read_input_tokens);
        const outputTokens = finiteNumber(rawUsage.output_tokens);
        if (inputTokens !== undefined || cachedInputTokens !== undefined || outputTokens !== undefined) {
          usage = {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          };
        }
      }
      cost = finiteNumber(event.total_cost_usd);
    }
    if (!output && event.type === "assistant") {
      const text = textFromContent(message?.content);
      if (text) output = text;
    }
  }
  if (!output) throw new ExternalProviderError("claude-code-cli", "Claude Code JSON event stream contained no final result.", { code: "invalid-provider-response" });
  if (cost !== undefined) {
    usage = { ...(usage ?? {}), cost: { amount: cost, currency: "USD", kind: "provider-estimate" } };
  }
  return { output, toolMetrics, ...(usage ? { usage } : {}) };
}

export class ClaudeCodeCliAgentRunner implements AgentExecutionProvider {
  readonly providerId = "claude-code-cli";

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
      const message = publicErrorMessage(error, "Claude Code authentication check failed inside ArkiMux.");
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
    if (!preflight.available) throw agentPreflightFailure(preflight, "Claude Code CLI preflight failed inside ArkiMux.", this.parentEnvironment);
    const environment = allowlistedAgentEnvironment(this.runtimeConfig, this.parentEnvironment);
    const executable = await resolveCliExecutable(this.runtimeConfig.command, request.cwd, environment);
    if (!executable) throw new Error(`Claude Code CLI command ${this.runtimeConfig.command} became unavailable after preflight.`);
    assertAgentNotCancelled(request.signal);
    const preparedAuth: PreparedAgentAuth = await this.authProviders.get(request.authProviderId).prepare(authContext(request, {
      path: executable.command,
      ...(preflight.auth.executable?.version ? { version: preflight.auth.executable.version } : {}),
    }));
    try {
      assertAgentNotCancelled(request.signal);
      const parsedParameters = parameters(request.parameters);
      const childEnvironment = { ...environment, ...preparedAuth.environment };
      const diagnosticEnvironment = credentialDiagnosticEnvironment(childEnvironment, preparedAuth.environment, preflight.auth.kind);
      const secretValues = credentialValuesForRetention(childEnvironment, preparedAuth.environment, preflight.auth.kind);
      const result = await runStreamingCli(request, { ...this.runtimeConfig, command: executable.command }, childEnvironment, {
        providerId: this.providerId,
        secretValues,
        args: claudeArguments(parsedParameters),
        stdin: request.prompt,
        model: parsedParameters.model,
        reasoningEffort: parsedParameters.effort,
      });
      const baseMetrics: AgentExecutionMetrics = {
        providerId: this.providerId,
        ...(request.label ? { label: request.label } : {}),
        ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
        model: parsedParameters.model,
        ...(parsedParameters.effort ? { reasoningEffort: parsedParameters.effort } : {}),
        status: result.timedOut ? "timed-out" : !result.cancelled && result.exitCode === 0 ? "complete" : "failed",
        elapsedMs: result.elapsedMs,
        artifacts: result.artifacts,
        ...claudeToolMetrics(result.stdout),
      };
      if (result.timedOut) throw new ClaudeCodeCliAgentRunError(`claude timed out after ${request.timeoutMs}ms.\nstderr:\n${result.stderr}`, baseMetrics, diagnosticEnvironment);
      if (result.cancelled) throw new ClaudeCodeCliAgentRunError("Agent execution was cancelled.", baseMetrics, {}, undefined, "agent_cancelled");
      if (result.exitCode !== 0) {
        throw new ClaudeCodeCliAgentRunError(`claude exited with code ${result.exitCode}.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`, baseMetrics, diagnosticEnvironment);
      }
      let parsed: ParsedClaudeOutput;
      try {
        parsed = parseClaudeCodeStream(result.stdout);
      } catch (error) {
        const diagnostic = getExternalErrorDiagnostic(error);
        if (!diagnostic) throw error;
        throw new ClaudeCodeCliAgentRunError(diagnostic.message, { ...baseMetrics, status: "failed" }, diagnosticEnvironment, diagnostic);
      }
      const output = createCredentialOutputRedactor(secretValues).redact(parsed.output);
      await fs.writeFile(result.artifacts.lastMessagePath, `${output}\n`, "utf8");
      return { output, metrics: { ...baseMetrics, ...parsed.toolMetrics, ...(parsed.usage ? { usage: parsed.usage } : {}) } };
    } finally {
      await disposeAgentResources([() => preparedAuth.dispose()]);
    }
  }
}
