import { spawn } from "node:child_process";
import type { ProviderParameterValue } from "../../application/agentProvider.ts";
import { agentProcessDetached } from "./agentProcessLifetime.ts";
import { connectionProbeDiagnostic } from "./connectionProbeDiagnostic.ts";
import { ExternalProviderError, credentialSecretValues } from "../../application/externalError.ts";

const catalogError = (message: string, code = "model-discovery-failed") => new ExternalProviderError("codex-cli", message, { code });

const maxOutputBytes = 2 * 1024 * 1024;
const maxPages = 25;
const maxStderrBytes = 64_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function selectParameters(defaults: Record<string, unknown>[]): Record<string, ProviderParameterValue> {
  if (defaults.length !== 1) throw catalogError(defaults.length
    ? "Codex model discovery returned more than one visible default model. No connection request was sent."
    : "Codex model discovery returned no visible default model. No connection request was sent.");
  const model = defaults[0]!;
  if (!identifier(model.model)) throw catalogError("Codex model discovery returned an invalid default model identifier.");
  if (model.inputModalities !== undefined && (!Array.isArray(model.inputModalities)
    || !model.inputModalities.every((value) => typeof value === "string")
    || !model.inputModalities.includes("text"))) {
    throw catalogError("Codex's default model does not advertise text input support.");
  }
  if (!Array.isArray(model.supportedReasoningEfforts) || !model.supportedReasoningEfforts.length
    || !model.supportedReasoningEfforts.every((effort) => record(effort) && identifier(effort.reasoningEffort))) {
    throw catalogError("Codex's default model did not advertise usable reasoning efforts.");
  }
  const efforts = model.supportedReasoningEfforts.map((effort) => (effort as Record<string, unknown>).reasoningEffort);
  const effort = efforts.includes("low") ? "low" : model.defaultReasoningEffort;
  if (!identifier(effort) || !efforts.includes(effort)) {
    throw catalogError("Codex's default model did not advertise a supported default reasoning effort.");
  }
  return { model: model.model, model_reasoning_effort: effort };
}

/** Discover the exact CLI's recommended default, never its personal model setting.
 * The caller owns executable resolution and isolated authentication/environment.
 * This session is metadata-only: no thread, turn, or inference is started. */
export function loadCodexCliProbeParameters(options: {
  command: string; cwd: string; environment: NodeJS.ProcessEnv; timeoutMs: number; secretValues?: readonly string[];
}): Promise<Record<string, ProviderParameterValue>> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new Error("Codex model discovery requires a positive timeout."));
  }
  return new Promise((resolve, reject) => {
    const secretValues = [...credentialSecretValues(options.environment), ...(options.secretValues ?? [])];
    const catalogError = (message: string, code = "model-discovery-failed") => new ExternalProviderError("codex-cli", message, { code, secretValues });
    const child = spawn(options.command, ["app-server", "--stdio", "-c", "mcp_servers={}"], {
      cwd: options.cwd, env: options.environment, stdio: ["pipe", "pipe", "pipe"], detached: agentProcessDetached(),
    });
    let buffer = "", stderr = "", outputBytes = 0, stderrBytes = 0;
    let nextId = 1, pendingId = 0, pages = 0;
    let phase: "initialize" | "catalog" = "initialize";
    let stopping = false, closed = false;
    let failure: Error | undefined, result: Record<string, ProviderParameterValue> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const cursors = new Set<string>();
    const defaults: Record<string, unknown>[] = [];
    const diagnostic = (message: string) => connectionProbeDiagnostic(
      JSON.stringify({ error: { message } }), options.environment,
      [options.cwd, options.command, options.environment.HOME ?? "", options.environment.CODEX_HOME ?? ""],
    );
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (agentProcessDetached()) process.kill(-child.pid, signal);
        else if (!closed) child.kill(signal);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") {
          failure = new Error("Codex model discovery process cleanup could not be confirmed.");
        }
      }
    };
    const stop = (error?: Error) => {
      if (error) failure ??= error;
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 200);
    };
    const timer = setTimeout(() => stop(catalogError("Codex model discovery timed out. No connection request was sent.")),
      Math.min(options.timeoutMs, 60_000));
    const send = (method: "initialize" | "initialized" | "model/list", params?: Record<string, unknown>) => {
      if (stopping) return;
      const message = method === "initialized" ? { method } : { id: pendingId = nextId++, method, params };
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const page = (cursor?: string) => {
      if (++pages > maxPages) throw catalogError("Codex model discovery exceeded its page limit.");
      send("model/list", { includeHidden: false, limit: 100, ...(cursor !== undefined ? { cursor } : {}) });
    };
    const receive = (line: string) => {
      const response: unknown = JSON.parse(line);
      if (!record(response)) throw catalogError("Codex model discovery returned an invalid protocol response.");
      if (typeof response.method === "string") {
        if (response.id !== undefined) throw catalogError("Codex requested interaction during model discovery. No connection request was sent.");
        return; // Bounded notifications are not model data or executable instructions.
      }
      if (response.id !== pendingId || (Object.hasOwn(response, "result") === Object.hasOwn(response, "error"))) {
        throw catalogError("Codex model discovery returned an unexpected protocol response.");
      }
      if (response.error !== undefined) {
        const message = record(response.error) && typeof response.error.message === "string" ? diagnostic(response.error.message) : "The CLI rejected the metadata request.";
        const code = record(response.error) && (typeof response.error.code === "string" || typeof response.error.code === "number")
          ? String(response.error.code) : undefined;
        throw catalogError(`Codex model discovery failed: ${message}`, code);
      }
      if (!record(response.result)) throw catalogError("Codex model discovery returned an invalid response.");
      if (phase === "initialize") {
        phase = "catalog";
        send("initialized");
        page();
        return;
      }
      const catalog = response.result;
      if (!Array.isArray(catalog.data) || catalog.data.length > 100
        || (catalog.nextCursor !== undefined && catalog.nextCursor !== null
          && (typeof catalog.nextCursor !== "string" || catalog.nextCursor.length > 4_096))) {
        throw catalogError("Codex model discovery returned a malformed model catalog.");
      }
      for (const model of catalog.data) {
        if (!record(model) || typeof model.hidden !== "boolean" || typeof model.isDefault !== "boolean") {
          throw catalogError("Codex model discovery returned a malformed model entry.");
        }
        if (!model.hidden && model.isDefault) defaults.push(model);
      }
      if (typeof catalog.nextCursor === "string") {
        if (cursors.has(catalog.nextCursor)) throw catalogError("Codex model discovery returned a repeated page cursor.");
        cursors.add(catalog.nextCursor);
        page(catalog.nextCursor);
      } else {
        result = selectParameters(defaults);
        stop();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopping) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) return stop(catalogError("Codex model discovery exceeded its output limit."));
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0 && !stopping; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { receive(line); }
        catch (cause) {
          stop(cause instanceof SyntaxError
            ? catalogError("Codex model discovery returned invalid JSON.")
            : cause instanceof Error ? cause : new Error("Codex model discovery failed."));
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stopping) return;
      stderrBytes += Buffer.byteLength(chunk);
      outputBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxStderrBytes || outputBytes > maxOutputBytes) return stop(catalogError("Codex model discovery exceeded its output limit."));
      stderr += chunk;
    });
    child.stdin.on("error", () => { if (!stopping) stop(catalogError("Codex model discovery could not communicate with the CLI.")); });
    child.once("error", () => stop(catalogError("Codex model discovery could not start the configured CLI.")));
    // A descendant can retain the pipes after the app-server exits. Kill its
    // owned POSIX group before waiting for close, including on successful discovery.
    child.once("exit", () => { if (agentProcessDetached()) kill("SIGKILL"); });
    child.once("close", () => {
      closed = true;
      clearTimeout(timer); clearTimeout(escalation);
      if (failure) return reject(failure);
      if (result) return resolve(result);
      const reason = connectionProbeDiagnostic(`codex exec exited with code 1.\nstderr:\n${stderr}`, options.environment, [options.cwd, options.command]);
      reject(catalogError(`Codex model discovery ended before returning a catalog. ${reason}`));
    });
    send("initialize", { clientInfo: { name: "arkimux_connection_probe", version: "1" } });
  });
}
