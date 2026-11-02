import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentAuthContext,
  AgentAuthProvider,
  AgentAuthProviderRegistry,
  AuthAvailability,
  PreparedAgentAuth,
} from "../../application/agentProvider.ts";
import type {
  AgentAuthProviderConfig,
  AgentExecutionProviderRuntimeConfig,
  ResolvedAgentProviderConfig,
} from "./agentProviderConfigProvider.ts";
import type { AgentAuthProviderStore, AgentCredentialStore } from "../../application/agentAuthentication.ts";
import type { AgentAuthProviderDefinition } from "../../application/agentAuthentication.ts";
import { allowlistedAgentEnvironment } from "./nativeStreamingCliProcess.ts";
import { ExternalProviderError, getExternalErrorDiagnostic, credentialSecretValues, redactExternalSecrets } from "../../application/externalError.ts";
import { connectionProbeDiagnostic } from "./connectionProbeDiagnostic.ts";

// Constructing this wrapper has no external effect. Workflow-only bundles must
// be able to omit the unused host authentication adapter and its child-process import.
const execFileAsync = /* @__PURE__ */ promisify(execFile);

function unavailable(
  authProviderId: string,
  kind: AuthAvailability["kind"],
  message: string,
  details: Omit<Partial<AuthAvailability>, "authProviderId" | "kind" | "available" | "status" | "message"> = {},
): AuthAvailability {
  return { authProviderId, kind, available: false, status: "unavailable", message, ...details };
}

function available(
  authProviderId: string,
  kind: AuthAvailability["kind"],
  details: Omit<Partial<AuthAvailability>, "authProviderId" | "kind" | "available" | "status"> = {},
): AuthAvailability {
  return { authProviderId, kind, available: true, status: "ready", ...details };
}

function indeterminate(
  authProviderId: string,
  kind: AuthAvailability["kind"],
  message: string,
  details: Omit<Partial<AuthAvailability>, "authProviderId" | "kind" | "available" | "status" | "message"> = {},
): AuthAvailability {
  return { authProviderId, kind, available: true, status: "indeterminate", message, ...details };
}

function modelProvider(context: AgentAuthContext): string | undefined {
  return context.modelProvider;
}

function stdoutFromProcessError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("stdout" in error)) return undefined;
  const stdout = (error as { stdout?: unknown }).stdout;
  if (typeof stdout === "string") return stdout;
  return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : undefined;
}

function stderrFromProcessError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return undefined;
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string") return stderr;
  return Buffer.isBuffer(stderr) ? stderr.toString("utf8") : undefined;
}

function statusFailureMessage(runtime: string, error: unknown, environment: NodeJS.ProcessEnv): string {
  const external = getExternalErrorDiagnostic(error);
  if (external) return redactExternalSecrets(external.message, credentialSecretValues(environment));
  if (!error || typeof error !== "object" || !("code" in error || "killed" in error)) {
    throw error;
  }
  const processError = error as { code?: string | number; killed?: boolean };
  if (processError.killed) return `${runtime} authentication status check timed out. Retry the status check.`;
  const label = runtime === "codex-cli" ? "codex exec" : runtime === "claude-code-cli" ? "claude" : "kimi";
  const code = typeof processError.code === "number" ? processError.code : 1;
  const stderr = stderrFromProcessError(error) ?? "";
  let message = connectionProbeDiagnostic(`${label} exited with code ${code}.\nstderr:\n${stderr}\nstdout:\n${stdoutFromProcessError(error) ?? ""}`, environment, []);
  if (stderr.trim() && message.includes("No readable provider error was returned.")) {
    message = connectionProbeDiagnostic(stderr, environment, []);
  }
  return `${runtime} authentication status check failed. ${message}`;
}

function codexAuthMethod(output: string): string | undefined {
  if (/logged in using chatgpt/i.test(output)) return "chatgpt";
  if (/logged in using an api key/i.test(output)) return "api-key";
  if (/logged in using an access token/i.test(output)) return "access-token";
  return undefined;
}

function claudeAuthStatus(stdout: string): {
  loggedIn?: boolean;
  authMethod?: string;
  accountEmail?: string;
  reportedPlan?: string;
} | undefined {
  try {
    const status = JSON.parse(stdout) as Record<string, unknown>;
    return {
      ...(typeof status.loggedIn === "boolean" ? { loggedIn: status.loggedIn } : {}),
      ...(typeof status.authMethod === "string" ? { authMethod: status.authMethod } : {}),
      ...(typeof status.email === "string" ? { accountEmail: status.email } : {}),
      ...(typeof status.subscriptionType === "string" ? { reportedPlan: status.subscriptionType } : {}),
    };
  } catch {
    return undefined;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  return Boolean(stat?.isFile());
}

async function commandExists(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (path.isAbsolute(command)) {
    return isRegularFile(command);
  }
  try {
    await execFileAsync("which", [command], { cwd, env: environment });
    return true;
  } catch {
    return false;
  }
}

function credentialDirectory(
  runtime: string,
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  environment: NodeJS.ProcessEnv,
): string {
  if (runtime === "codex-cli") {
    return path.resolve(runtimeConfig.parentHome ?? environment.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  }
  if (runtime === "claude-code-cli") {
    return path.resolve(runtimeConfig.parentHome ?? environment.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
  }
  if (runtime === "kimi-code-cli") {
    return path.resolve(runtimeConfig.parentHome ?? environment.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code"));
  }
  return path.resolve(
    runtimeConfig.agentDirectory
      ?? environment.PI_CODING_AGENT_DIR
      ?? path.join(os.homedir(), ".pi", "agent"),
  );
}

/** Native login lookup needs the user's identity and config location, not their full shell environment. */
function claudeNativeSessionEnvironment(
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const prepared: Record<string, string> = {};
  for (const [name, value] of Object.entries(allowlistedAgentEnvironment(runtimeConfig, environment))) {
    if (value !== undefined) prepared[name] = value;
  }
  for (const name of ["USER", "HOME", "CLAUDE_CONFIG_DIR"] as const) {
    if (environment[name] !== undefined) prepared[name] = environment[name];
  }
  return prepared;
}

class RuntimeNativeAgentAuthProvider implements AgentAuthProvider {
  readonly kind = "runtime-native" as const;

  constructor(
    readonly authProviderId: string,
    private readonly config: Extract<AgentAuthProviderConfig, { kind: "runtime-native" }>,
    private readonly runtimeConfig: AgentExecutionProviderRuntimeConfig,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async preflight(context: AgentAuthContext): Promise<AuthAvailability> {
    const result = await this.nativePreflight(context);
    if (!result.available && result.message) {
      const failure = new ExternalProviderError(this.config.runtime, result.message, { secretValues: credentialSecretValues(this.environment), code: result.reason });
      return { ...result, message: failure.message, externalDiagnostic: failure.externalDiagnostic };
    }
    return result;
  }

  private async nativePreflight(context: AgentAuthContext): Promise<AuthAvailability> {
    if (context.executionProviderId !== this.config.runtime) {
      return unavailable(
        this.authProviderId,
        this.kind,
        `Authentication provider ${this.authProviderId} requires runtime ${this.config.runtime}.`,
      );
    }
    if (this.config.modelProvider && modelProvider(context) !== this.config.modelProvider) {
      return unavailable(
        this.authProviderId,
        this.kind,
        `Authentication provider ${this.authProviderId} requires model provider ${this.config.modelProvider}.`,
      );
    }
    if (this.config.runtime === "codex-cli") {
      const command = context.executable?.path ?? this.runtimeConfig.command;
      const executable = context.executable ?? { path: command };
      if (!(await commandExists(command, context.cwd, this.environment))) {
        return unavailable(
          this.authProviderId,
          this.kind,
          `Authentication provider ${this.authProviderId} could not find Codex CLI.`,
          { reason: "provider-unavailable", executable },
        );
      }
      const directory = credentialDirectory(this.config.runtime, this.runtimeConfig, this.environment);
      let output = "";
      let authenticated = false;
      try {
        const result = await execFileAsync(command, ["login", "status"], {
          cwd: context.cwd,
          env: { ...this.environment, CODEX_HOME: directory },
          timeout: 15_000,
        });
        output = `${result.stdout}\n${result.stderr}`;
        authenticated = true;
      } catch (error) {
        output = `${stdoutFromProcessError(error) ?? ""}\n${stderrFromProcessError(error) ?? ""}`;
        if (!/^\s*(?:not logged in|logged out|login required)[.!]?\s*$/i.test(output)) {
          return unavailable(this.authProviderId, this.kind, statusFailureMessage(this.config.runtime, error, this.environment), {
            reason: "provider-unavailable", executable,
          });
        }
      }
      const authMethod = codexAuthMethod(output);
      if (authenticated) {
        const methodLabel = authMethod === "chatgpt"
          ? "ChatGPT"
          : authMethod === "api-key"
            ? "API key"
            : authMethod === "access-token"
              ? "access token"
              : "native";
        return indeterminate(
          this.authProviderId,
          this.kind,
          `Codex reports an authenticated ${methodLabel} session. Selected model, workspace, billing, and usage eligibility will be confirmed when execution starts.`,
          {
            reason: "unknown",
            ...(authMethod ? { identity: { authMethod } } : {}),
            executable,
            remediation: authMethod === "api-key"
              ? [{ kind: "retry", label: "Verify API billing, quota, and model access if execution fails" }]
              : [{ kind: "configure-api-key", label: "Configure an OpenAI API key if subscription access is unavailable" }],
          },
        );
      }
      return unavailable(
        this.authProviderId,
        this.kind,
        `Authentication provider ${this.authProviderId} could not find an active Codex session. Run codex login or configure an OpenAI API key.`,
        {
          reason: "session-missing",
          ...(authMethod ? { identity: { authMethod } } : {}),
          executable,
          remediation: [
            { kind: "login", label: "Log in to Codex" },
            { kind: "configure-api-key", label: "Configure an OpenAI API key" },
          ],
        },
      );
    }
    if (this.config.runtime === "claude-code-cli") {
      const command = context.executable?.path ?? this.runtimeConfig.command;
      const executable = context.executable ?? { path: command };
      const environment = claudeNativeSessionEnvironment(this.runtimeConfig, this.environment);
      if (!(await commandExists(command, context.cwd, environment))) {
        return unavailable(this.authProviderId, this.kind, `Authentication provider ${this.authProviderId} could not find Claude Code CLI.`);
      }
      let status: ReturnType<typeof claudeAuthStatus>;
      try {
        const { stdout } = await execFileAsync(command, ["auth", "status", "--json"], {
          cwd: context.cwd,
          env: environment,
          timeout: 15_000,
        });
        status = claudeAuthStatus(stdout);
      } catch (error) {
        status = claudeAuthStatus(stdoutFromProcessError(error) ?? "");
        if (status?.loggedIn !== false) return unavailable(this.authProviderId, this.kind,
          statusFailureMessage(this.config.runtime, error, environment), { reason: "provider-unavailable", executable });
      }
      if (typeof status?.loggedIn !== "boolean") return unavailable(this.authProviderId, this.kind,
        "Claude Code returned an unreadable authentication status. Retry the status check.", { reason: "provider-unavailable", executable });
      if (status?.loggedIn === true) {
          const identity = {
            ...(status.authMethod ? { authMethod: status.authMethod } : {}),
            ...(status.accountEmail ? { accountEmail: status.accountEmail } : {}),
            ...(status.reportedPlan ? { reportedPlan: status.reportedPlan } : {}),
          };
          if (status.reportedPlan?.toLowerCase() === "free") {
            return indeterminate(
              this.authProviderId,
              this.kind,
              "Claude reports a Free session. Claude Code eligibility will be confirmed when execution starts.",
              {
                reason: "unknown",
                identity,
                executable,
                remediation: [
                  { kind: "upgrade", label: "Review Claude Code plan eligibility" },
                  { kind: "configure-api-key", label: "Configure an Anthropic API key" },
                ],
              },
            );
          }
          return available(this.authProviderId, this.kind, { identity, executable });
      }
      return unavailable(
        this.authProviderId,
        this.kind,
        `Authentication provider ${this.authProviderId} could not find an active Claude Code session. Run /login inside Claude Code.`,
        {
          reason: "session-missing",
          ...(status ? {
            identity: {
              ...(status.authMethod ? { authMethod: status.authMethod } : {}),
              ...(status.accountEmail ? { accountEmail: status.accountEmail } : {}),
              ...(status.reportedPlan ? { reportedPlan: status.reportedPlan } : {}),
            },
          } : {}),
          executable,
          remediation: [
            { kind: "login", label: "Log in to Claude Code" },
            { kind: "configure-api-key", label: "Configure an Anthropic API key" },
          ],
        },
      );
    }
    if (this.config.runtime === "kimi-code-cli") {
      const command = context.executable?.path ?? this.runtimeConfig.command;
      if (!(await commandExists(command, context.cwd, this.environment))) {
        return unavailable(this.authProviderId, this.kind, `Authentication provider ${this.authProviderId} could not find Kimi Code CLI.`);
      }
      const directory = credentialDirectory(this.config.runtime, this.runtimeConfig, this.environment);
      try {
        const { stdout } = await execFileAsync(command, ["provider", "list", "--json"], {
          cwd: context.cwd,
          env: { ...this.environment, KIMI_CODE_HOME: directory },
          timeout: 15_000,
        });
        let response: unknown;
        try { response = JSON.parse(stdout); }
        catch { throw new ExternalProviderError("kimi-code-cli", "Kimi Code returned an unreadable provider catalog. Retry the status check."); }
        const providers = response && typeof response === "object" && !Array.isArray(response)
          ? (response as { providers?: unknown }).providers : undefined;
        if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
          throw new ExternalProviderError("kimi-code-cli", "Kimi Code returned an unreadable provider catalog. Retry the status check.");
        }
        if ((providers as Record<string, unknown>)["managed:kimi-code"] !== undefined) {
          return available(this.authProviderId, this.kind, {
            ...(context.executable ? { executable: context.executable } : {}),
          });
        }
      } catch (error) {
        return unavailable(this.authProviderId, this.kind, statusFailureMessage(this.config.runtime, error, this.environment), {
          reason: "provider-unavailable", ...(context.executable ? { executable: context.executable } : {}),
        });
      }
      return unavailable(
        this.authProviderId,
        this.kind,
        `Authentication provider ${this.authProviderId} could not find an active Kimi Code session. Run kimi login.`,
        {
          reason: "session-missing",
          ...(context.executable ? { executable: context.executable } : {}),
          remediation: [{ kind: "login", label: "Log in to Kimi Code" }],
        },
      );
    }
    const directory = credentialDirectory(this.config.runtime, this.runtimeConfig, this.environment);
    const sessionPath = path.join(directory, "auth.json");
    let selectedSession = false;
    try {
      if (await isRegularFile(sessionPath)) {
        const sessions = JSON.parse(await fs.readFile(sessionPath, "utf8"));
        const session = sessions?.[this.config.modelProvider ?? context.modelProvider ?? ""];
        selectedSession = session?.type === "oauth" && typeof session.access === "string" && session.access.length > 0
          && typeof session.refresh === "string" && Number.isFinite(session.expires);
      }
    } catch { /* Malformed or inaccessible native state is not a usable session. */ }
    if (!selectedSession) {
      return unavailable(
        this.authProviderId,
        this.kind,
        `No ${this.config.modelProvider ?? context.modelProvider ?? "selected provider"} native session is configured in Pi. Run pi, then /login and select that provider.`,
        { reason: "session-missing", remediation: [{ kind: "login", label: "Log in to the selected provider inside Pi" }] },
      );
    }
    return available(this.authProviderId, this.kind, {
      ...(context.executable ? { executable: context.executable } : {}),
    });
  }

  async prepare(context: AgentAuthContext): Promise<PreparedAgentAuth> {
    const availability = await this.preflight(context);
    if (!availability.available) throw new Error(availability.message);
    return {
      environment: this.config.runtime === "claude-code-cli"
        ? claudeNativeSessionEnvironment(this.runtimeConfig, this.environment)
        : {},
      ...(this.config.runtime === "claude-code-cli"
        ? {}
        : { credentialDirectory: credentialDirectory(this.config.runtime, this.runtimeConfig, this.environment) }),
      dispose: async () => undefined,
    };
  }
}

class EnvironmentAgentAuthProvider implements AgentAuthProvider {
  readonly kind = "environment" as const;

  constructor(
    readonly authProviderId: string,
    private readonly config: Extract<AgentAuthProviderConfig, { kind: "environment" }>,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async preflight(_context: AgentAuthContext): Promise<AuthAvailability> {
    const value = this.environment[this.config.sourceVariable];
    return value
      ? available(this.authProviderId, this.kind)
      : unavailable(
          this.authProviderId,
          this.kind,
          `Authentication provider ${this.authProviderId} requires environment variable ${this.config.sourceVariable}.`,
        );
  }

  async prepare(context: AgentAuthContext): Promise<PreparedAgentAuth> {
    const availability = await this.preflight(context);
    if (!availability.available) throw new Error(availability.message);
    const preparedEnvironment = {
      [this.config.targetVariable]: this.environment[this.config.sourceVariable] as string,
    };
    return {
      environment: preparedEnvironment,
      dispose: async () => {
        delete preparedEnvironment[this.config.targetVariable];
      },
    };
  }
}

class CommandAgentAuthProvider implements AgentAuthProvider {
  readonly kind = "command" as const;

  constructor(
    readonly authProviderId: string,
    private readonly config: Extract<AgentAuthProviderConfig, { kind: "command" }>,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async preflight(context: AgentAuthContext): Promise<AuthAvailability> {
    return await commandExists(this.config.command, context.cwd, this.environment)
      ? available(this.authProviderId, this.kind)
      : unavailable(
          this.authProviderId,
          this.kind,
          `Authentication provider ${this.authProviderId} could not find its credential command.`,
        );
  }

  async prepare(context: AgentAuthContext): Promise<PreparedAgentAuth> {
    const availability = await this.preflight(context);
    if (!availability.available) throw new Error(availability.message);
    const result = await execFileAsync(this.config.command, this.config.args, {
      cwd: context.cwd,
      env: this.environment,
      maxBuffer: 1024 * 1024,
    });
    const credential = result.stdout.trim();
    if (!credential) {
      throw new Error(`Authentication provider ${this.authProviderId} returned an empty credential.`);
    }
    const preparedEnvironment = { [this.config.targetVariable]: credential };
    return {
      environment: preparedEnvironment,
      dispose: async () => {
        delete preparedEnvironment[this.config.targetVariable];
      },
    };
  }
}

class StoredCredentialAgentAuthProvider implements AgentAuthProvider {
  readonly kind = "stored-credential" as const;

  constructor(
    readonly authProviderId: string,
    private readonly config: Extract<AgentAuthProviderConfig, { kind: "stored-credential" }>,
    private readonly credentials: AgentCredentialStore,
  ) {}

  async preflight(context: AgentAuthContext): Promise<AuthAvailability> {
    if (context.executionProviderId !== this.config.runtime) {
      return unavailable(
        this.authProviderId,
        this.kind,
        `Authentication provider ${this.authProviderId} requires runtime ${this.config.runtime}.`,
      );
    }
    if (this.config.modelProvider && context.modelProvider !== this.config.modelProvider) {
      return unavailable(
        this.authProviderId,
        this.kind,
        `Authentication provider ${this.authProviderId} requires model provider ${this.config.modelProvider}.`,
      );
    }
    return await this.credentials.hasValue(this.config.credentialId)
      ? available(this.authProviderId, this.kind)
      : unavailable(this.authProviderId, this.kind, `Authentication provider ${this.authProviderId} has no credential.`);
  }

  async prepare(context: AgentAuthContext): Promise<PreparedAgentAuth> {
    const availability = await this.preflight(context);
    if (!availability.available) throw new Error(availability.message);
    const credential = await this.credentials.getValue(this.config.credentialId);
    if (!credential) throw new Error(`Authentication provider ${this.authProviderId} has no credential.`);
    const preparedEnvironment = { [this.config.targetVariable]: credential };
    return {
      environment: preparedEnvironment,
      dispose: async () => {
        delete preparedEnvironment[this.config.targetVariable];
      },
    };
  }
}

export function createStoredCredentialAgentAuthProvider(
  definition: Extract<AgentAuthProviderDefinition, { kind: "stored-credential" }>,
  credentials: AgentCredentialStore,
): AgentAuthProvider {
  return new StoredCredentialAgentAuthProvider(definition.authProviderId, {
    kind: "stored-credential",
    credentialId: definition.credentialId,
    targetVariable: definition.targetVariable,
    runtime: definition.executionProviderId,
    ...(definition.modelProvider === undefined ? {} : { modelProvider: definition.modelProvider }),
  }, credentials);
}

export class DefaultAgentAuthProviderRegistry implements AgentAuthProviderRegistry {
  private readonly providers: ReadonlyMap<string, AgentAuthProvider>;

  constructor(providers: AgentAuthProvider[]) {
    const entries = providers.map((provider) => [provider.authProviderId, provider] as const);
    if (new Set(entries.map(([providerId]) => providerId)).size !== entries.length) {
      throw new Error("Agent authentication provider registry contains duplicate provider IDs.");
    }
    this.providers = new Map(entries);
  }

  get(authProviderId: string): AgentAuthProvider {
    const provider = this.providers.get(authProviderId);
    if (!provider) throw new Error(`Agent authentication provider ${authProviderId} is not configured.`);
    return provider;
  }
}

export function createAgentAuthProviderRegistry(
  config: ResolvedAgentProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: AgentCredentialStore,
): AgentAuthProviderRegistry {
  const providers = Object.entries(config.authProviders).map(([authProviderId, authConfig]) => {
    if (authConfig.kind === "runtime-native") {
      return new RuntimeNativeAgentAuthProvider(
        authProviderId,
        authConfig,
        config.executionProviders[authConfig.runtime],
        environment,
      );
    }
    if (authConfig.kind === "environment") {
      return new EnvironmentAgentAuthProvider(authProviderId, authConfig, environment);
    }
    if (authConfig.kind === "command") {
      return new CommandAgentAuthProvider(authProviderId, authConfig, environment);
    }
    if (!credentials) {
      throw new Error(`Authentication provider ${authProviderId} requires an Agent Credential Store.`);
    }
    return new StoredCredentialAgentAuthProvider(authProviderId, authConfig, credentials);
  });
  return new DefaultAgentAuthProviderRegistry(providers);
}

/** Resolve built-ins immediately and user-created stored credentials lazily, so new bindings work without restart. */
export function createStoreBackedAgentAuthProviderRegistry(
  config: ResolvedAgentProviderConfig,
  definitions: AgentAuthProviderStore,
  credentials: AgentCredentialStore,
  environment: NodeJS.ProcessEnv = process.env,
): AgentAuthProviderRegistry {
  const configured = createAgentAuthProviderRegistry(config, environment, credentials);
  const dynamic = new Map<string, AgentAuthProvider>();
  return {
    get(authProviderId) {
      if (config.authProviders[authProviderId] !== undefined) return configured.get(authProviderId);
      const existing = dynamic.get(authProviderId);
      if (existing) return existing;
      const resolve = async (): Promise<AgentAuthProvider> => {
        const provider = await definitions.get(authProviderId);
        if (!provider) throw new Error(`Agent authentication provider ${authProviderId} is not configured.`);
        if (provider.lifecycleStatus !== "active") throw new Error(`Agent authentication provider ${authProviderId} is archived.`);
        const definition = provider.definition;
        if (definition.kind === "runtime-native") return new RuntimeNativeAgentAuthProvider(authProviderId, {
          kind: "runtime-native", runtime: definition.executionProviderId,
          ...(definition.modelProvider ? { modelProvider: definition.modelProvider } : {}),
        }, config.executionProviders[definition.executionProviderId], environment);
        return createStoredCredentialAgentAuthProvider(definition, credentials);
      };
      const provider: AgentAuthProvider = {
        authProviderId,
        kind: "stored-credential",
        async preflight(context) {
          try {
            return await (await resolve()).preflight(context);
          } catch (error) {
            return {
              authProviderId,
              kind: "stored-credential",
              available: false,
              status: "unavailable",
              reason: "unknown",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
        async prepare(context) {
          return (await resolve()).prepare(context);
        },
      };
      dynamic.set(authProviderId, provider);
      return provider;
    },
  };
}
