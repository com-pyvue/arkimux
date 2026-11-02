// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createBrowserErrorReporter, LocalBrowserErrorReporting } from "../../apps/hosts/web/src/localBrowserErrorReporting.tsx";

const session = { cacheKey: "local", requestInit: () => ({ credentials: "include" as const }) };
afterEach(() => { cleanup(); document.head.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture() {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 })); vi.stubGlobal("fetch", fetch);
  const error = new TypeError("private detail"); error.stack = `TypeError: private detail\n    at render (${location.origin}/assets/index-test.js:1:100)`;
  return { fetch, error, report: createBrowserErrorReporter(location.origin, session) };
}
describe("Local browser diagnostics", () => {
  it("forwards a framework crash to Local once, never directly to telemetry", async () => {
    const f = fixture(); f.report(f.error); f.report(f.error);
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    expect(f.fetch.mock.calls[0]![0]).toBe(`${location.origin}/api/v1/local/diagnostics/browser`);
    expect(f.fetch.mock.calls[0]![1]?.credentials).toBe("include");
  });
  it("retains custom, project, extension and foreign-origin traces locally without ownership checks", async () => {
    const f = fixture();
    for (const url of [`${location.origin}/arkimux/result-views/project.js`, "https://foreign.test/assets/index-test.js", "chrome-extension://extension/script.js"]) {
      const error = new Error("private project data"); error.name = "ProjectRendererError";
      error.stack = `ProjectRendererError: private project data\n    at ${url}:1:1`; f.report(error);
    }
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    for (const [url, init] of f.fetch.mock.calls) {
      expect(url).toBe(`${location.origin}/api/v1/local/diagnostics/browser`);
      expect(JSON.parse(String(init?.body))).toMatchObject({ name: "ProjectRendererError", message: "private project data" });
    }
    expect(String(f.fetch.mock.calls[1]![1]?.body)).toContain("https://foreign.test/assets/index-test.js");
  });
  it("preserves causes and aggregate errors, including errors without stacks and primitive throws", async () => {
    const f = fixture();
    const nested = new Error("original cause"); nested.name = "WorkflowFailure"; nested.stack = undefined;
    const error = new AggregateError([nested, "plain nested value"], "outer failure", { cause: new TypeError("cause detail") });
    f.report(error); f.report("plain thrown value");
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(f.fetch.mock.calls[0]![1]?.body))).toMatchObject({
      name: "AggregateError", message: "outer failure", cause: { name: "TypeError", message: "cause detail" },
      errors: [{ name: "WorkflowFailure", message: "original cause" }, { name: "NonError", message: "plain nested value" }],
    });
    expect(JSON.parse(String(f.fetch.mock.calls[1]![1]?.body))).toEqual({ name: "NonError", message: "plain thrown value" });
  });
  it("bounds multibyte traces without dropping them and ignores expected cancellation", async () => {
    const f = fixture();
    const error = new Error("💥".repeat(5000)); error.name = "PluginError"; error.stack = "💥".repeat(20000);
    f.report(error);
    f.report(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    const body = String(f.fetch.mock.calls[0]![1]?.body);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.parse(body)).toMatchObject({ name: "PluginError", truncated: true });
  });
  it("bounds reports and quietly handles a failed diagnostic request", async () => {
    const f = fixture(); f.fetch.mockRejectedValue(new Error("network failed"));
    for (let i = 0; i < 20; i++) { const error = new Error("crash"); error.stack = f.error.stack; f.report(error); }
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(10));
  });
  it("keeps the browser event message when no Error object is available", async () => {
    const f = fixture();
    render(<LocalBrowserErrorReporting apiBaseUrl={location.origin} session={session}><p>Ready</p></LocalBrowserErrorReporting>);
    window.dispatchEvent(new ErrorEvent("error", { error: null, message: "Renderer resource failed" }));
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(f.fetch.mock.calls[0]![1]?.body))).toEqual({ name: "NonError", message: "Renderer resource failed" });
  });
  it("shows a recoverable page and shared toast when React rendering fails", async () => {
    const f = fixture(); vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => { throw f.error; };
    render(<LocalBrowserErrorReporting apiBaseUrl={location.origin} session={session}><Broken /></LocalBrowserErrorReporting>);
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
  });
});
