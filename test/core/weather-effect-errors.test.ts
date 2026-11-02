import { describe, expect, it } from "vitest";
import { createWeatherEffect } from "../../cli/scaffold/workflows/weather-advisor/src/weather-effect.ts";
import { getExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";

async function run(transport: typeof fetch, base = "https://weather.example") {
  return createWeatherEffect({ environment: { WEATHER_API_URL: base }, credentials: {}, runConfiguration: null }, transport).execute({
    stableOperationId: "weather.current",
    deadlineAt: new Date(Date.now() + 10_000).toISOString(), cancellation: { aborted: false },
  }, { schemaVersion: 1, city: "Istanbul" });
}

describe("weather provider diagnostics", () => {
  it("normalizes padded wttr descriptions without adding a fallback warning", async () => {
    const output = await run(async () => new Response(JSON.stringify({ current_condition: [{
      weatherDesc: [{ value: "Overcast " }], temp_C: "23", FeelsLikeC: "18", windspeedKmph: "26", precipMM: "0.0",
    }] })));
    expect(output).toEqual({ summary: "Overcast", temperatureC: 23, feelsLikeC: 18, windKph: 26, precipitationMm: 0 });
  });
  it("preserves the actual TLS cause and its code", async () => {
    const cause = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
    const error = await run(async () => { throw new TypeError("fetch failed", { cause }); }).catch(error => error);
    expect(getExternalErrorDiagnostic(error)).toEqual({ origin: "external", provider: "weather", code: "CERT_HAS_EXPIRED", message: "certificate has expired" });
  });
  it.each([401, 503])("preserves HTTP %s provider text and formatting", async status => {
    const message = 'Use [small, medium].\nRetry after 42 seconds. https://weather.example/help';
    const error = await run(async () => new Response(JSON.stringify({ error: { message } }), { status })).catch(error => error);
    expect(getExternalErrorDiagnostic(error)).toMatchObject({ message, code: String(status) });
  });
  it.each(["api_key", "apiKey", "apikey"])("removes an echoed configured %s without discarding the explanation", async name => {
    const error = await run(async () => new Response("opaque-fixture-key was rejected. Renew access.", { status: 401 }), `https://weather.example?${name}=opaque-fixture-key`).catch(error => error);
    expect(error.message).toBe("[redacted] was rejected. Renew access.");
  });
  it("hides unexpected implementation details", async () => {
    const error = await run(async () => { throw new TypeError("private internal object /private/secret"); }).catch(error => error);
    expect(error.message).toBe("The weather response could not be processed. Check the weather service and try again.");
    expect(getExternalErrorDiagnostic(error)).toBeUndefined();
  });
  it("retains both the provider code and HTTP status", async () => {
    const error = await run(async () => new Response(JSON.stringify({ error: { code: "quota_exceeded", message: "Retry after 42 seconds." } }), { status: 429 })).catch(error => error);
    expect(getExternalErrorDiagnostic(error)).toMatchObject({ code: "quota_exceeded", httpStatus: 429, message: "Retry after 42 seconds." });
  });
  it("removes every configured credential when query keys are repeated", async () => {
    const error = await run(async () => new Response("first-fixture-credential and second-fixture-credential were rejected.", { status: 401 }), "https://weather.example?api_key=first-fixture-credential&api_key=second-fixture-credential").catch(error => error);
    expect(error.message).toBe("[redacted] and [redacted] were rejected.");
  });
});
