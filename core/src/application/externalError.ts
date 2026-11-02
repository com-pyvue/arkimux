/** A provider diagnostic, selected at its adapter boundary rather than inferred from arbitrary exceptions. */
export interface ExternalErrorDiagnostic {
  readonly origin: "external";
  readonly provider: string;
  readonly message: string;
  readonly code?: string;
  readonly httpStatus?: number;
}

export type FailureRetryabilityV1 = "retryable" | "not-retryable" | "unknown";

export function readFailureRetryability(value: unknown): FailureRetryabilityV1 {
  return value === "retryable" || value === "not-retryable" || value === "unknown" ? value : "unknown";
}

export interface ExternalProviderErrorOptions {
  readonly code?: string;
  readonly httpStatus?: number;
  readonly secretValues?: readonly string[];
  readonly cause?: unknown;
  /** Classified by the provider adapter. Never inferred later from status text. */
  readonly retryability?: FailureRetryabilityV1;
}

/** Remove credentials, not ordinary provider explanations, URLs, identifiers, or formatting. */
export function redactExternalSecrets(message: string, secretValues: readonly string[] = []): string {
  const variants = new Set<string>();
  for (const value of secretValues) {
    if (!value) continue;
    variants.add(value);
    variants.add(encodeURIComponent(value));
    variants.add(JSON.stringify(value).slice(1, -1));
  }
  // Terminal styling is not diagnostic content and can otherwise split an echoed key.
  let result = message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
  for (const value of [...variants].sort((a, b) => b.length - a.length)) result = result.split(value).join("[redacted]");
  return result
    .replace(/(\b(?:Bearer|Basic)\s+)(?!\[redacted\])(?!(?:authentication|authorization|token|credentials|scheme|is|was|required|missing|invalid)\b)\S+/gi, "$1[redacted]")
    // Quoted JSON/header values and assignments are credentials. A bare word after
    // a prose colon ("Authorization: denied by policy") is not enough evidence.
    .replace(/((?:["']?\b(?:[A-Z0-9]+[_-])*(?:api[ _-]?key|(?:access|refresh|id|auth)[_-]?token|client[_-]?secret|token|password|secret|authorization|cookie|credential)["']?)\s*(?:=\s*|:\s*(?=["'`])))("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|`[^`]*(?:`|$)|[^\s,;}&#]+)/gi,
      (match, label: string, value: string) => /^(?:Bearer|Basic|invalid|expired|missing|required|rejected|revoked|unavailable)[.!]?$/i.test(value) || value.startsWith("[redacted]")
        ? match : label + (/^["'`]/.test(value) && value.endsWith(value[0]!) ? `${value[0]}[redacted]${value[0]}` : "[redacted]"))
    .replace(/\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/(\b(?:https?|file):\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:api[_-]?key|(?:access|refresh|id)[_-]?token|token|password|secret|signature|sig|authorization)=)[^&#\s]*/gi, "$1[redacted]");
}

export function credentialSecretValues(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => typeof value === "string" && value.length > 0 && /(?:^|[_-])(?:KEY|APIKEY|TOKEN|CREDENTIAL|SECRET|PASSWORD|AUTH|AUTHTOKEN|AUTHORIZATION|COOKIE)(?:$|[_-])/i.test(name.replace(/([a-z\d])([A-Z])/g, "$1_$2")))
    .map(([, value]) => value!);
}

export class ExternalProviderError extends Error {
  readonly externalDiagnostic: ExternalErrorDiagnostic;
  readonly retryability: FailureRetryabilityV1;
  constructor(provider: string, message: string, options: ExternalProviderErrorOptions = {}) {
    const safeMessage = redactExternalSecrets(message, options.secretValues);
    super(safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExternalProviderError";
    this.externalDiagnostic = Object.freeze({ origin: "external", provider, message: safeMessage,
      ...(options.code === undefined ? {} : { code: redactExternalSecrets(options.code, options.secretValues) }),
      ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }) });
    this.retryability = options.retryability ?? "unknown";
  }
}

/** Structural recognition survives retained-worker and independently bundled SDK boundaries. */
export function getFailureRetryability(error: unknown): FailureRetryabilityV1 {
  let value = error;
  for (let depth = 0; depth < 3; depth++) {
    if (!value || typeof value !== "object") break;
    const properties = Object.getOwnPropertyDescriptors(value);
    const retryability = readFailureRetryability(properties.retryability?.value);
    if (retryability !== "unknown" || properties.retryability?.value === "unknown") return retryability;
    value = properties.cause?.value;
  }
  return "unknown";
}

/** Validate an IPC/storage diagnostic and copy only the public fields, never a stack or raw error object. */
export function readExternalErrorDiagnostic(value: unknown): ExternalErrorDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = Object.getOwnPropertyDescriptors(value);
  const own = (key: string): unknown => data[key]?.value;
  const provider = own("provider"), message = own("message"), code = own("code"), httpStatus = own("httpStatus");
  if (own("origin") !== "external" || typeof provider !== "string" || !provider || typeof message !== "string"
    || (code !== undefined && typeof code !== "string")
    || (httpStatus !== undefined && (typeof httpStatus !== "number" || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))) return undefined;
  return { origin: "external", provider, message, ...(code === undefined ? {} : { code }), ...(httpStatus === undefined ? {} : { httpStatus }) };
}

/** Structural recognition also works across independently bundled copies of Core. */
export function getExternalErrorDiagnostic(error: unknown): ExternalErrorDiagnostic | undefined {
  if (!error || typeof error !== "object") return undefined;
  return readExternalErrorDiagnostic(Object.getOwnPropertyDescriptor(error, "externalDiagnostic")?.value);
}

export function publicErrorMessage(error: unknown, internalMessage: string): string {
  return getExternalErrorDiagnostic(error)?.message ?? internalMessage;
}
