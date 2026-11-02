import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentAuthConnectionProbe,
  AgentAuthConnectionTarget,
  AgentAuthProbeResult,
} from "../../application/agentAuthentication.ts";
import type {
  AgentExecutionProviderRegistry,
  AgentExecutionProvider,
  ProviderParameterValue,
} from "../../application/agentProvider.ts";
import type { ResolvedAgentProviderConfig } from "./agentProviderConfigProvider.ts";
import { loadPiCliProbeModels } from "./piCliModelCatalog.ts";
import { connectionProbeDiagnostic } from "./connectionProbeDiagnostic.ts";
import { ExternalProviderError, getExternalErrorDiagnostic, publicErrorMessage, credentialSecretValues, readExternalErrorDiagnostic } from "../../application/externalError.ts";

const prompt = "Reply exactly OK. Do not inspect files, call tools, run commands, or use repository context.";
const timeoutMs = 60_000;

type PiProbeModelLoader = (options: {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  command?: string;
  modelProvider: string;
}) => Promise<readonly string[]>;

/** Runs an isolated, tool-free inference through the exact runtime and auth binding. */
export class ExecutionAgentAuthConnectionProbe implements AgentAuthConnectionProbe {
  constructor(
    private readonly executionProviders: AgentExecutionProviderRegistry,
    private readonly providerConfig: ResolvedAgentProviderConfig,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly piProbeModels: PiProbeModelLoader = loadPiCliProbeModels,
  ) {}

  async probe(target: AgentAuthConnectionTarget): Promise<AgentAuthProbeResult> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    let probeRoot: string | undefined;
    let probeModel: string | undefined;
    let discoveringCodexModel = target.executionProviderId === "codex-cli";
    const diagnostic = (message: string) => connectionProbeDiagnostic(message, this.environment, [
      this.cwd,
      ...Object.values(this.providerConfig.executionProviders).map((runtime) => runtime.command).filter(path.isAbsolute),
      ...(probeRoot ? [probeRoot] : []),
    ]);
    const safeDiagnostic = (value: unknown) => {
      const external = readExternalErrorDiagnostic(value);
      return external ? new ExternalProviderError(external.provider, external.message, {
        code: external.code, httpStatus: external.httpStatus, secretValues: credentialSecretValues(this.environment),
      }).externalDiagnostic : undefined;
    };
    try {
      const provider = this.executionProviders.get(target.executionProviderId);
      const deadline = startedAt + timeoutMs;
      if (target.executionProviderId === "codex-cli") {
        // Keep missing CLI/login errors ahead of catalog discovery. A catalog
        // response alone never establishes inference access or available quota.
        const readiness = await provider.preflight({ cwd: this.cwd, authProviderId: target.authProviderId, parameters: {} });
        if (!readiness.available) {
          const externalDiagnostic = safeDiagnostic(readiness.externalDiagnostic ?? readiness.auth.externalDiagnostic);
          return result(target, checkedAt, startedAt, {
            status: readiness.auth.reason === "session-missing" ? "action-required" : "failed",
            mechanism: "native-status",
            message: externalDiagnostic?.message ?? diagnostic(readiness.message ?? readiness.auth.message ?? "Authentication setup is unavailable."),
            ...(externalDiagnostic ? { externalDiagnostic } : {}),
          });
        }
      }
      const candidates = await this.parameterCandidates(target, provider, deadline);
      discoveringCodexModel = false;
      probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-auth-probe-"));
      let lastError: unknown;

      for (const [index, parameters] of candidates.entries()) {
        probeModel = typeof parameters.model === "string" ? parameters.model : undefined;
        try {
          const readiness = await provider.preflight({
            cwd: this.cwd,
            authProviderId: target.authProviderId,
            parameters,
          });
          if (!readiness.available) {
            const externalDiagnostic = safeDiagnostic(readiness.externalDiagnostic ?? readiness.auth.externalDiagnostic);
            return result(target, checkedAt, startedAt, {
              status: readiness.auth.reason === "session-missing" ? "action-required" : "failed",
              mechanism: "native-status",
              ...(probeModel ? { probeModel } : {}),
              message: externalDiagnostic?.message ?? diagnostic(readiness.message ?? readiness.auth.message ?? "Authentication setup is unavailable."),
              ...(externalDiagnostic ? { externalDiagnostic } : {}),
            });
          }

          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw new ExternalProviderError(target.executionProviderId, "Authentication connection probe timed out.", { code: "timeout" });
          const response = await provider.run({
            cwd: this.cwd,
            prompt,
            timeoutMs: remainingMs,
            authProviderId: target.authProviderId,
            artifactPrefix: path.join(probeRoot, `probe-${index + 1}`),
            label: "Authentication connection probe",
            parameters,
          });
          return result(target, checkedAt, startedAt, {
            status: "connected",
            mechanism: "minimal-inference",
            ...(probeModel ?? response.metrics.model ? { probeModel: probeModel ?? response.metrics.model } : {}),
            message: "Connection succeeded through an isolated minimal inference request.",
          });
        } catch (error) {
          lastError = error;
          const canTryAnotherModel = target.executionProviderId === "pi-cli"
            && index < candidates.length - 1
            && isModelAccessFailure(error);
          if (!canTryAnotherModel) throw error;
        }
      }

      throw lastError ?? new Error("Authentication connection probe had no model candidates.");
    } catch (error) {
      const external = safeDiagnostic(getExternalErrorDiagnostic(error));
      // Adapter errors already selected their diagnostic and scrubbed resolved
      // credentials. Re-parsing a safe heading would discard its inline cause.
      const message = external ? external.message
        : publicErrorMessage(error, "The connection check failed inside ArkiMux. Retry the check; if it persists, inspect the local server diagnostics.");
      return result(target, checkedAt, startedAt, {
        status: external && (/not logged in|login required|authentication[_ -]?(?:failed|required)|(?:invalid|expired|missing) (?:session|credential)/i.test(message)
          || target.executionProviderId === "pi-cli" && target.modelProvider === "anthropic"
          && /third-party apps[^\n]*extra usage[^\n]*plan limits/i.test(message)) ? "action-required" : "failed",
        mechanism: discoveringCodexModel ? "provider-check" : "minimal-inference",
        ...(probeModel ? { probeModel } : {}),
        message,
        ...(external ? { externalDiagnostic: external } : {}),
      });
    } finally {
      if (probeRoot) await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async parameterCandidates(
    target: AgentAuthConnectionTarget,
    provider: AgentExecutionProvider,
    deadline: number,
  ): Promise<readonly Record<string, ProviderParameterValue>[]> {
    if (target.executionProviderId === "codex-cli") {
      if (!provider.getConnectionProbeParameters) throw new ExternalProviderError("codex-cli", "Codex CLI model discovery is unavailable. Update the ArkiMux Codex adapter and retry.", { code: "unsupported-provider-operation" });
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new ExternalProviderError("codex-cli", "Codex model discovery timed out. Retry Test connection.", { code: "timeout" });
      return [await provider.getConnectionProbeParameters({
        cwd: this.cwd, authProviderId: target.authProviderId, parameters: {}, timeoutMs: remainingMs,
      })];
    }
    if (target.executionProviderId === "pi-cli") {
      if (!target.modelProvider) throw new Error("Pi connection probes require a model provider.");
      const models = await this.piProbeModels({
        cwd: this.cwd,
        environment: this.environment,
        command: this.providerConfig.executionProviders["pi-cli"].command,
        modelProvider: target.modelProvider,
      });
      if (!models.length) throw new ExternalProviderError("pi-cli", `Pi has no text model catalog entry for ${target.modelProvider}.`, { code: "invalid-provider-response" });
      return models.map((model) => ({ provider: target.modelProvider!, model, thinking: "off" }));
    }
    if (target.executionProviderId === "claude-code-cli") {
      return [{ model: "haiku", effort: "low", "permission-mode": "plan" }];
    }
    if (target.executionProviderId === "kimi-code-cli") {
      return [{ model: "kimi-k2.5", "provider-type": "kimi", "thinking-effort": "low" }];
    }
    throw new Error(`Authentication connection probes do not support ${target.executionProviderId}.`);
  }
}

function isModelAccessFailure(error: unknown): boolean {
  const message = getExternalErrorDiagnostic(error)?.message ?? "";
  return /resource_not_found_error|not found (?:the )?model|model[^\n]{0,160}(?:not found|unavailable|not available|unsupported|permission denied|no access)/i.test(message);
}

function result(
  target: AgentAuthConnectionTarget,
  checkedAt: string,
  startedAt: number,
  value: Omit<AgentAuthProbeResult, "schemaVersion" | "authProviderId" | "checkedAt" | "latencyMs">,
): AgentAuthProbeResult {
  return {
    schemaVersion: 1,
    authProviderId: target.authProviderId,
    checkedAt,
    latencyMs: Math.max(0, Date.now() - startedAt),
    ...value,
  };
}
