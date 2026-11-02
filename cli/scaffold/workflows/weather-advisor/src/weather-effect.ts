import { ExternalProviderError, getExternalErrorDiagnostic, credentialSecretValues, defineEffectAdapter,
  type EffectAdapterFactoryContextV1 } from "@com-pyvue/agent-execution-core";
import { weatherInputSchema, weatherSnapshotSchema, WTTR_HTTP_FALLBACK_WARNING } from "./contract.js";
import { weatherCurrentEffect } from "./weather-effect-contract.js";

export function weatherRequestUrl(base: string, city: string): URL {
  weatherInputSchema.parse({ schemaVersion: 1, city });
  let url: URL;
  try {
    if (!/^https?:\/\//i.test(base) || /[\s\u0000-\u001f\u007f\\]/u.test(base) || /^https?:\/\/[^/?#]*@/i.test(base)) throw new Error();
    url = new URL(base);
    if (!url.hostname || url.username || url.password) throw new Error();
  } catch { throw new Error("Set WEATHER_API_URL in .env to an absolute HTTP(S) URL without userinfo."); }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${encodeURIComponent(city)}`;
  url.searchParams.set("format", "j1");
  url.hash = "";
  return url;
}

export function createWeatherEffect(context: EffectAdapterFactoryContextV1, transport: typeof fetch = fetch) {
  const base = context.environment.WEATHER_API_URL;
  // Resolve only in the host-owned adapter factory. Workflow code never receives the URL.
  weatherRequestUrl(base, "validation");
  const secretValues = [...new URL(base).searchParams].flatMap(([name, value]) => credentialSecretValues(Object.fromEntries([[name, value]])));
  const externalError = (message: string, code: string, httpStatus?: number) => new ExternalProviderError("weather", message, { code, secretValues, httpStatus });
  return defineEffectAdapter(weatherCurrentEffect, {
    async execute(context, input) {
      const startedAt = Date.now();
      const requestDeadlineAt = Math.min(startedAt + 10_000, Date.parse(context.deadlineAt));
      const timeoutMs = requestDeadlineAt - startedAt;
      if (context.cancellation.aborted || timeoutMs <= 0) throw new Error("Weather read cancelled or out of time.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const cancellation = setInterval(() => { if (context.cancellation.aborted) controller.abort(); }, 25);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const url = weatherRequestUrl(base, input.city);
        const options: RequestInit = { method: "GET", redirect: "error", signal: controller.signal };
        let response: Response;
        let usedHttpFallback = false;
        try {
          response = await transport(url, options);
        } catch (error) {
          // This demo exception belongs only to this weather effect. Never downgrade
          // custom endpoints, credentials, other failures, or an already-started body.
          if (url.origin !== "https://wttr.in" || secretValues.length > 0 || transportFailure(error)?.code !== "CERT_HAS_EXPIRED"
            || controller.signal.aborted || context.cancellation.aborted || Date.now() >= requestDeadlineAt) throw error;
          const fallback = new URL(url);
          fallback.protocol = "http:";
          response = await transport(fallback, options);
          usedHttpFallback = true;
        }
        if (!response.body) throw externalError(`Weather service returned HTTP ${response.status} without a response body.`, String(response.status), response.status);
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 262_144) throw externalError("The weather response exceeded the 256 KiB size limit.", "response_too_large");
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        let raw: unknown;
        try { raw = JSON.parse(text); } catch {
          if (!response.ok) throw externalError(text || `Weather service returned HTTP ${response.status}.`, String(response.status), response.status);
          throw externalError("The weather service returned a response that could not be read as JSON.", "invalid_response");
        }
        if (!response.ok) throw externalError(providerMessage(raw) ?? `Weather service returned HTTP ${response.status}.`, providerCode(raw) ?? String(response.status), response.status);
        const data = raw as { current_condition?: { weatherDesc?: { value?: unknown }[]; temp_C?: unknown; FeelsLikeC?: unknown; windspeedKmph?: unknown; precipMM?: unknown }[] } | null;
        const current = data?.current_condition?.[0];
        const numeric = (value: unknown) => {
          if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value))) throw new Error();
          return Number(value);
        };
        const snapshot = weatherSnapshotSchema.parse({
          summary: typeof current?.weatherDesc?.[0]?.value === "string" ? current.weatherDesc[0].value.trim() : undefined,
          temperatureC: numeric(current?.temp_C), feelsLikeC: numeric(current?.FeelsLikeC),
          windKph: numeric(current?.windspeedKmph), precipitationMm: numeric(current?.precipMM),
          ...(usedHttpFallback ? { transportWarning: WTTR_HTTP_FALLBACK_WARNING } : {}),
        });
        if (JSON.stringify(snapshot).includes(base)) throw new Error();
        return snapshot;
      } catch (error) {
        if (getExternalErrorDiagnostic(error)) throw error;
        if (controller.signal.aborted || context.cancellation.aborted || Date.now() >= requestDeadlineAt) throw externalError(context.cancellation.aborted
          ? "The weather request was cancelled." : "The weather service did not respond within 10 seconds.", "request_interrupted");
        const cause = transportFailure(error);
        if (cause) throw externalError(cause.message, cause.code);
        throw new Error("The weather response could not be processed. Check the weather service and try again.");
      } finally {
        controller.abort();
        await reader?.cancel().catch(() => undefined);
        clearTimeout(timer); clearInterval(cancellation);
      }
    },
  });
}

function providerMessage(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (depth > 4 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return providerMessage(record.error, depth + 1) ?? providerMessage(record.message, depth + 1) ?? providerMessage(record.reason, depth + 1);
}

function transportFailure(value: unknown, depth = 0): { code: string; message: string } | undefined {
  if (depth > 4 || !(value instanceof Error)) return undefined;
  const nested = transportFailure(value.cause, depth + 1);
  if (nested) return nested;
  const code = "code" in value ? value.code : undefined;
  return typeof code === "string" && /^(?:CERT_|ERR_TLS_|UND_ERR_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|E(?:CONNRESET|CONNREFUSED|HOSTUNREACH|NETUNREACH|NOTFOUND|AI_AGAIN|PIPE|TIMEDOUT)$)/.test(code)
    ? { code, message: value.message } : undefined;
}

function providerCode(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return providerCode(record.error, depth + 1) ?? (typeof record.code === "string" ? record.code : undefined);
}
