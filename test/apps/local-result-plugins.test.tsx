// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocalResultPlugins, watchLocalResultPlugins, rendererFailureMessage, rendererConnectionMessage } from "../../apps/hosts/web/src/localResultPlugins.tsx";
import { ResultRendererErrorBoundary } from "../../apps/packages/result-presentation/src/index.ts";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const result = { envelopeSchemaVersion: 1 as const, resultKind: "weather-advisor.result", runRef: { executionId: "run-1" }, resultId: "weather.json", publishedAt: "2026-09-05T00:00:00Z", payload: { schemaVersion: 1 } };
describe("Local project renderer integration", () => {
  it("loads renderer metadata and HTML from the configured API, not the UI origin", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ resultKind: result.resultKind, payloadSchemaVersion: 1 }])))
      .mockResolvedValueOnce(new Response("<h1>Weather</h1>"));
    vi.stubGlobal("fetch", fetch);
    const [plugin] = await loadLocalResultPlugins("http://127.0.0.1:8787");
    const Component = plugin.Component;
    render(<Component result={result} />);
    const frame = await screen.findByTitle("Workflow result");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Weather</h1>");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["http://127.0.0.1:8787/arkimux/result-renderers", "http://127.0.0.1:8787/arkimux/result-views/run-1/weather.json"]);
  });
  it("shows JSON after a view HTTP error without poisoning the error boundary for repaired views", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ resultKind: result.resultKind, payloadSchemaVersion: 1 }])))
      .mockResolvedValueOnce(new Response("failure", { status: 422 })));
    const [plugin] = await loadLocalResultPlugins("http://127.0.0.1:8787"); const Component = plugin.Component;
    render(<ResultRendererErrorBoundary fallback={() => <pre>Original JSON remains available</pre>}><Component result={result} /></ResultRendererErrorBoundary>);
    const alert = await screen.findByRole("alert", { name: "Result renderer failed" });
    expect(alert.textContent).toContain(rendererFailureMessage);
    expect(alert.className).toContain("border-red-500");
    expect(alert.className).toContain("bg-red-50");
    expect(alert.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(screen.getByText(/"weather.json"/)).toBeTruthy();
  });
  it("polls revisions without replacing unchanged plugins, handles errors and stops cleanly", async () => {
    vi.useFakeTimers();
    const values = [{ resultKind: result.resultKind, payloadSchemaVersion: 1 }];
    const response = (revision: number) => new Response(JSON.stringify(values), { headers: { "X-ArkiMux-Renderer-Revision": String(revision) } });
    const fetch = vi.fn().mockResolvedValueOnce(response(1)).mockResolvedValueOnce(response(1))
      .mockResolvedValueOnce(response(2)).mockResolvedValueOnce(new Response("failed", { status: 500 }))
      .mockResolvedValueOnce(response(3));
    vi.stubGlobal("fetch", fetch);
    const changes = vi.fn();
    const stop = watchLocalResultPlugins("http://api.test", changes);
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes.mock.calls[0][0][0].Component).not.toBe(changes.mock.calls[1][0][0].Component);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveBeenLastCalledWith([], rendererConnectionMessage, "warning");
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes.mock.lastCall![0]).toHaveLength(1);
    stop(); await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("replaces a displayed failed view with repaired HTML when the plugin revision changes", async () => {
    let revision = 1;
    const values = [{ resultKind: result.resultKind, payloadSchemaVersion: 1 }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("result-renderers")
      ? new Response(JSON.stringify(values), { headers: { "X-ArkiMux-Renderer-Revision": String(revision) } })
      : revision === 1 ? new Response("failed", { status: 422 }) : new Response("<h1>Repaired</h1>")));
    const first = await loadLocalResultPlugins("http://api.test");
    const First = first[0].Component;
    const page = render(<First result={result} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    revision = 2;
    const repaired = await loadLocalResultPlugins("http://api.test");
    const Repaired = repaired[0].Component;
    await act(async () => page.rerender(<Repaired result={result} />));
    expect((await screen.findByTitle("Workflow result")).getAttribute("srcdoc")).toContain("Repaired");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("distinguishes broken startup from absent registration and clears the notice on repair", async () => {
    vi.useFakeTimers();
    const values = [{ resultKind: result.resultKind, payloadSchemaVersion: 1 }];
    const response = (status: string, entries: unknown[]) => new Response(JSON.stringify(entries), { headers: { "X-ArkiMux-Renderer-Revision": "1", "X-ArkiMux-Renderer-Status": status } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response("error", []))
      .mockResolvedValueOnce(response("unavailable", [])).mockResolvedValueOnce(response("ready", values)));
    const changes = vi.fn(); const stop = watchLocalResultPlugins("http://api.test", changes);
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toHaveBeenLastCalledWith([], rendererFailureMessage, "error");
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveBeenLastCalledWith([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes.mock.lastCall![0]).toHaveLength(1);
    expect(changes.mock.lastCall).toHaveLength(1);
    stop();
  });
  it("does not label a missing view as a renderer failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ resultKind: result.resultKind, payloadSchemaVersion: 1 }])))
      .mockResolvedValueOnce(new Response("private response", { status: 404 })));
    const [plugin] = await loadLocalResultPlugins("http://api.test"); const Component = plugin.Component;
    render(<Component result={result} />);
    expect(await screen.findByText("No compatible result renderer is installed.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("private response")).toBeNull();
  });
  it("times out a stuck view request and cancels its retry on unmount", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ resultKind: result.resultKind, payloadSchemaVersion: 1 }])))
      .mockImplementationOnce((_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    vi.stubGlobal("fetch", fetch);
    const [plugin] = await loadLocalResultPlugins("http://api.test"); const Component = plugin.Component;
    const page = render(<Component result={result} />);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole("alert", { name: "Could not load renderer" }).textContent).toContain(rendererConnectionMessage);
    page.unmount();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("retries a view connection failure without a metadata revision change and clears the notice", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ resultKind: result.resultKind, payloadSchemaVersion: 1 }])))
      .mockRejectedValueOnce(new Error("private network details")).mockResolvedValueOnce(new Response("<h1>Connected again</h1>"));
    vi.stubGlobal("fetch", fetch);
    const [plugin] = await loadLocalResultPlugins("http://api.test"); const Component = plugin.Component;
    render(<Component result={result} />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const alert = screen.getByRole("alert", { name: "Could not load renderer" });
    expect(alert.textContent).toContain(rendererConnectionMessage);
    expect(alert.className).toContain("border-amber-500");
    expect(alert.className).toContain("bg-amber-50");
    expect(screen.getByText(/"weather.json"/)).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTitle("Workflow result").getAttribute("srcdoc")).toContain("Connected again");
  });
});
