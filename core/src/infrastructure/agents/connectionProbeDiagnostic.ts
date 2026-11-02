import { stripVTControlCharacters } from "node:util";
import { credentialSecretValues, redactExternalSecrets, readExternalErrorDiagnostic } from "../../application/externalError.ts";
import type { AgentExecutionPreflightResult, AuthAvailability } from "../../application/agentProvider.ts";
import { AgentProviderFailure } from "../../application/agentExecutionFailure.ts";
import { credentialValuesForRetention } from "./retainedAgentOutput.ts";

const fallback = "The connection check failed without a readable provider error. Check the CLI configuration and try again.";
const summaryPattern = /^(?:codex exec|claude|kimi|pi) (?:exited with code (?:-?\d{1,3}|null)\b|timed out after \d{1,12}ms\b|produced empty last message\b)/;

/** Auth bindings may inject credentials into arbitrarily named variables. This
 * map is for redaction only and must never be passed to a child process. */
export function credentialDiagnosticEnvironment(environment: NodeJS.ProcessEnv, credentials: NodeJS.ProcessEnv,
  kind: AuthAvailability["kind"] = "environment"): NodeJS.ProcessEnv {
  return { ...environment, ...Object.fromEntries(credentialValuesForRetention(environment, credentials, kind)
    .map((value, index) => [`ARKIMUX_RESOLVED_SECRET_${index}`, value])) };
}

export function agentPreflightFailure(preflight: AgentExecutionPreflightResult, fallback: string, environment: NodeJS.ProcessEnv): Error {
  const external = readExternalErrorDiagnostic(preflight.externalDiagnostic) ?? readExternalErrorDiagnostic(preflight.auth.externalDiagnostic);
  return external ? new AgentProviderFailure(external.provider, external.message, {
    code: external.code, httpStatus: external.httpStatus, secretValues: credentialSecretValues(environment),
  }) : new Error(fallback);
}

function plainText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
}


function errorText(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "string") return value.length ? value : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const message = errorText(record.error, depth + 1) ?? errorText(record.message, depth + 1)
    ?? errorText(record.reason, depth + 1);
  const code = typeof record.code === "string" || typeof record.code === "number" ? String(record.code)
    : typeof record.type === "string" && /_error$/.test(record.type) ? record.type : undefined;
  const requestId = typeof record.request_id === "string" ? record.request_id : undefined;
  return [code, message, requestId ? `request_id: ${requestId}` : undefined].filter(Boolean).join("\n") || undefined;
}

/** Select known error envelopes, never assistant content, initialization, or tool output. */
export function providerEventDiagnostic(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown> | null;
    if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
    if (event.type === "result" && event.is_error === true) {
      return errorText(event.result) ?? (Array.isArray(event.errors)
        ? event.errors.map((value) => errorText(value)).filter(Boolean).join("\n") || undefined : undefined)
        ?? errorText(event.error) ?? "Claude Code returned an error result without an explanation.";
    }
    if (event.type === "message_end" && event.message && typeof event.message === "object") {
      const message = event.message as Record<string, unknown>;
      if (message.role === "assistant" && ["error", "aborted"].includes(String(message.stopReason))) {
        const diagnostic = errorText(message.errorMessage);
        return diagnostic ?? `Pi assistant message failed with ${message.stopReason}.`;
      }
      return undefined;
    }
    if (event.type !== undefined && !/^(?:error|turn\.failed|request\.failed|[a-z_]+_error)$/.test(String(event.type))) return undefined;
    if (event.type === undefined && !event.error) return undefined;
    return errorText(event);
  } catch { return undefined; }
}

function selectedDiagnostic(value: string): { summary?: string; reason?: string } {
  const lines = value.split(/\r?\n/);
  const first = lines.find((line) => line.trim().length > 0)?.trim();
  if (!first) return {};
  const summary = first.match(summaryPattern)?.[0];
  if (!summary) {
    const piBody = value.match(/^Pi assistant message failed with error:\s*(?:\d{3}\s*)?(\{[\s\S]*\})\.?$/);
    if (piBody) return { reason: providerEventDiagnostic(piBody[1]!) };
    if (/^[{[]/.test(first)) return { reason: providerEventDiagnostic(value) };
    return { reason: value };
  }
  let section: "stderr" | "stdout" | undefined;
  const structured: string[] = [], plain: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "stderr:" || line.trim() === "stdout:") {
      // stdout cannot impersonate stderr and expose arbitrary assistant text.
      if (section !== "stdout") section = line.trim() === "stderr:" ? "stderr" : "stdout";
      continue;
    }
    if (!section) continue;
    const diagnostic = providerEventDiagnostic(line);
    if (diagnostic) structured.push(diagnostic);
    else if (section === "stderr" && !/^\s*[{[]/.test(line)) {
      if (!/^\s*(?:at\s|warning:|debug:|info:)/i.test(line)) plain.push(line);
    }
  }
  return { summary: `${summary}.`, reason: [...new Set(structured)].join("\n") || plain.join(value.includes("\r\n") ? "\r\n" : "\n").trim() || undefined };
}

/** Preserve provider explanations after extracting them and removing secrets.
 * Callers must not use this function to classify arbitrary internal exceptions. */
export function connectionProbeDiagnostic(value: string, environment: NodeJS.ProcessEnv, _privatePaths: readonly string[]): string {
  const selected = selectedDiagnostic(plainText(value));
  if (!selected.reason) return selected.summary
    ? `${selected.summary} No readable provider error was returned. Check the CLI configuration and try again.` : fallback;
  const message = redactExternalSecrets(selected.reason, credentialSecretValues(environment));
  return selected.summary ? `${selected.summary} ${message}` : message;
}
