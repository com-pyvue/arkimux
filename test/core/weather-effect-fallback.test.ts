import { afterEach, describe, expect, it, vi } from "vitest";
import { createWeatherEffect } from "../../cli/scaffold/workflows/weather-advisor/src/weather-effect.ts";
import { getExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";

const warning = "Weather fetched over unencrypted HTTP because the HTTPS certificate expired.";
const snapshot = { summary: "Clear", temperatureC: 20, feelsLikeC: 19, windKph: 8, precipitationMm: 0.2 };
const providerBody = JSON.stringify({ current_condition: [{
  weatherDesc: [{ value: "Clear" }], temp_C: "20", FeelsLikeC: "19", windspeedKmph: "8", precipMM: "0.2",
}] });
const expired = () => Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
const healthyResponse = () => new Response(providerBody);

async function run(transport: typeof fetch, options: {
  base?: string;
  deadlineMs?: number;
  cancellation?: { aborted: boolean };
} = {}) {
  return createWeatherEffect({ environment: { WEATHER_API_URL: options.base ?? "https://wttr.in" }, credentials: {}, runConfiguration: null }, transport).execute({
    stableOperationId: "weather.current",
    deadlineAt: new Date(Date.now() + (options.deadlineMs ?? 60_000)).toISOString(),
    cancellation: options.cancellation ?? { aborted: false },
  }, { schemaVersion: 1, city: "New York" });
}

function pendingBody(signal: AbortSignal): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
    },
  }));
}

afterEach(() => { vi.useRealTimers(); });

describe("weather HTTPS certificate fallback", () => {
  it("leaves a successful HTTPS response unchanged", async () => {
    const transport = vi.fn<typeof fetch>(async () => healthyResponse());
    expect(await run(transport)).toEqual(snapshot);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0]![0])).toBe("https://wttr.in/New%20York?format=j1");
  });

  it.each([
    ["direct", () => expired()],
    ["nested", () => new TypeError("fetch failed", { cause: new Error("TLS failed", { cause: expired() }) })],
  ] as const)("retries a %s structured expired-certificate error once with a warning", async (_name, failure) => {
    const transport = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(failure())
      .mockImplementationOnce(async () => healthyResponse());
    expect(await run(transport)).toEqual({ ...snapshot, transportWarning: warning });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://wttr.in/New%20York?format=j1", "http://wttr.in/New%20York?format=j1",
    ]);
  });

  it("accepts explicit HTTPS port 443 and preserves the path and safe query exactly", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(expired()).mockResolvedValueOnce(healthyResponse());
    await run(transport, { base: "https://wttr.in:443/weather/?lang=en&lang=fr&format=j2#ignored" });
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://wttr.in/weather/New%20York?lang=en&lang=fr&format=j1",
      "http://wttr.in/weather/New%20York?lang=en&lang=fr&format=j1",
    ]);
    const [first, second] = transport.mock.calls;
    expect(first![1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(second![1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(first![1]!.signal).toBeInstanceOf(AbortSignal);
    expect(second![1]!.signal).toBe(first![1]!.signal);
  });

  it.each([
    "https://weather.example", "https://sub.wttr.in", "https://wttr.in.example", "https://wttr.in.",
    "https://wttr.in:8443", "https://wttr.in:80", "http://wttr.in", "http://wttr.in:443",
  ])("does not downgrade an ineligible origin: %s", async base => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(expired());
    const error = await run(transport, { base }).catch(error => error);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(getExternalErrorDiagnostic(error)).toMatchObject({ provider: "weather", code: "CERT_HAS_EXPIRED" });
  });

  it.each(["api_key", "apiKey", "apikey", "access_token", "authToken", "clientSecret", "password", "authorization", "cookie"])(
    "does not send a credential-bearing %s query over HTTP", async name => {
      const transport = vi.fn<typeof fetch>().mockRejectedValue(expired());
      await expect(run(transport, { base: `https://wttr.in?${name}=fixture-credential` })).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it("finds credentials in repeated query keys even when the first value is empty", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(expired());
    await expect(run(transport, { base: "https://wttr.in?api_key=&api_key=fixture-credential" })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"])(
    "does not retry a different structured transport code: %s", async code => {
      const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed", {
        cause: Object.assign(new Error("certificate has expired"), { code }),
      }));
      const error = await run(transport).catch(error => error);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(getExternalErrorDiagnostic(error)).toMatchObject({ code });
    },
  );

  it.each([
    new Error("CERT_HAS_EXPIRED: certificate has expired"),
    new TypeError("fetch failed", { cause: new Error("certificate has expired") }),
    { code: "CERT_HAS_EXPIRED", message: "certificate has expired" },
    new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" } }),
  ])("does not infer certificate expiry from a message or non-Error object", async failure => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(failure);
    await expect(run(transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 503])("does not retry HTTP %s even if the provider reports CERT_HAS_EXPIRED", async status => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "CERT_HAS_EXPIRED", message: "Provider rejected the request." },
    }), { status }));
    const error = await run(transport).catch(error => error);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(getExternalErrorDiagnostic(error)).toMatchObject({
      code: "CERT_HAS_EXPIRED", httpStatus: status, message: "Provider rejected the request.",
    });
  });

  it.each([
    ["missing body", () => new Response(null)],
    ["invalid JSON", () => new Response("CERT_HAS_EXPIRED")],
    ["invalid weather fields", () => new Response(JSON.stringify({ current_condition: [{ temp_C: "invalid" }] }))],
    ["invalid UTF-8", () => new Response(new Uint8Array([0xff]))],
    ["stream failure", () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(expired()); } }))],
  ] as const)("does not retry after receiving a response with %s", async (_name, response) => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response());
    await expect(run(transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("preserves an HTTP fallback provider diagnostic and never makes a third call", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(expired()).mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: "quota_exceeded", message: "Retry after 42 seconds.\nDaily quota exceeded." },
    }), { status: 429 }));
    const error = await run(transport).catch(error => error);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(getExternalErrorDiagnostic(error)).toEqual({
      origin: "external", provider: "weather", code: "quota_exceeded", httpStatus: 429,
      message: "Retry after 42 seconds.\nDaily quota exceeded.",
    });
  });

  it.each(["ECONNRESET", "CERT_HAS_EXPIRED"])("does not retry fallback transport failure %s", async code => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(expired()).mockRejectedValueOnce(
      Object.assign(new Error("The HTTP fallback failed."), { code }),
    );
    const error = await run(transport).catch(error => error);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(getExternalErrorDiagnostic(error)).toMatchObject({ code, message: "The HTTP fallback failed." });
  });
});

describe("weather fallback request safeguards", () => {
  it("does not start HTTP if cancellation is requested between attempts", async () => {
    const cancellation = { aborted: false };
    const transport = vi.fn<typeof fetch>(async () => { cancellation.aborted = true; throw expired(); });
    await expect(run(transport, { cancellation })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [60_000, 10_000],
    [4_000, 4_000],
  ])("does not start HTTP after the budget expires (context deadline %i ms)", async (deadlineMs, budgetMs) => {
    vi.useFakeTimers();
    const start = Date.now();
    const transport = vi.fn<typeof fetch>(async () => {
      // Advance the clock without firing the timeout, as can happen while the event loop is busy.
      vi.setSystemTime(start + budgetMs);
      throw expired();
    });
    await expect(run(transport, { deadlineMs })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [60_000, 10_000],
    [4_000, 4_000],
  ])("shares the original deadline with the fallback body (context deadline %i ms)", async (deadlineMs, budgetMs) => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        throw expired();
      })
      .mockImplementationOnce(async (_url, init) => pendingBody(init!.signal!));
    let settled = false;
    const result = run(transport, { deadlineMs }).catch(error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport).toHaveBeenCalledTimes(2);
    const signal = transport.mock.calls[0]![1]!.signal!;
    expect(transport.mock.calls[1]![1]!.signal).toBe(signal);
    await vi.advanceTimersByTimeAsync(budgetMs - 1_001);
    expect(settled).toBe(false);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(getExternalErrorDiagnostic(await result)).toMatchObject({ code: "request_interrupted" });
    expect(signal.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending fallback response body with the same signal", async () => {
    vi.useFakeTimers();
    const cancellation = { aborted: false };
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(expired())
      .mockImplementationOnce(async (_url, init) => pendingBody(init!.signal!));
    const result = run(transport, { cancellation }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport).toHaveBeenCalledTimes(2);
    cancellation.aborted = true;
    await vi.advanceTimersByTimeAsync(25);
    expect(getExternalErrorDiagnostic(await result)).toMatchObject({
      code: "request_interrupted", message: "The weather request was cancelled.",
    });
    expect(transport.mock.calls[0]![1]!.signal).toBe(transport.mock.calls[1]![1]!.signal);
    expect(transport.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("accepts exactly 256 KiB of valid JSON (fallback %s)", async fallback => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>();
    if (fallback) transport.mockRejectedValueOnce(expired());
    transport.mockResolvedValueOnce(new Response(providerBody.padEnd(262_144, " ")));
    expect(await run(transport)).toEqual(fallback ? { ...snapshot, transportWarning: warning } : snapshot);
    expect(transport).toHaveBeenCalledTimes(fallback ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("cancels bodies larger than 256 KiB without another attempt (fallback %s)", async fallback => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>();
    if (fallback) transport.mockRejectedValueOnce(expired());
    transport.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(262_144));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    })));
    const error = await run(transport).catch(error => error);
    expect(getExternalErrorDiagnostic(error)).toMatchObject({
      code: "response_too_large", message: "The weather response exceeded the 256 KiB size limit.",
    });
    expect(transport).toHaveBeenCalledTimes(fallback ? 2 : 1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
