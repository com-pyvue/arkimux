// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "../../apps/packages/ui/src/index.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentExecutionWebApp } from "../../apps/hosts/web/src/index.tsx";
import { LocalWorkflowRegistryNotice, watchLocalWorkflowRegistry } from "../../apps/hosts/web/src/localWorkflowRegistry.tsx";
import { agentExecutionUiConfiguration } from "../../apps/packages/ui-profile/contract/src/index.ts";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ready = (revision: number) => ({ revision, status: "ready" });
const sourceError = { kind: "source", code: "TS2304", message: "Cannot find name 'missingStep'.", file: "src/workflows/weather.ts", line: 12, column: 7 };
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function notice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = render(<QueryClientProvider client={client}><Toaster /><LocalWorkflowRegistryNotice apiBaseUrl="http://api.test" /></QueryClientProvider>);
  return { client, ...page };
}

describe("Local workflow registry watcher", () => {
  it("uses the configured API with session headers and emits only changed snapshots", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn(), fetch = vi.fn(async () => Response.json(ready(1)));
    const stop = watchLocalWorkflowRegistry("http://api.test/", onChange, { fetch,
      requestInit: () => ({ headers: { "x-fixture-session": "local" } }) });
    await tick(); await tick(1000);
    expect(fetch).toHaveBeenCalledTimes(2); expect(onChange).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/arkimux/workflow-registry");
    expect(options).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
    expect(new Headers(options.headers).get("x-fixture-session")).toBe("local");
    expect(new Headers(options.headers).get("accept")).toBe("application/json");
    stop(); await tick(10_000); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([404, 405, 501])("silently disables an unsupported endpoint returning %s", async status => {
    vi.useFakeTimers();
    const onChange = vi.fn(), fetch = vi.fn(async () => new Response("private error", { status }));
    const stop = watchLocalWorkflowRegistry("http://api.test", onChange, { fetch });
    await tick(); await tick(10_000);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: "unsupported" });
    expect(fetch).toHaveBeenCalledTimes(1); stop();
  });

  it("retries transport and invalid-status failures without exposing their raw details", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn(), fetch = vi.fn().mockRejectedValueOnce(new Error("secret transport detail"))
      .mockResolvedValueOnce(Response.json({ revision: -1, status: "error", message: "secret payload" }))
      .mockResolvedValueOnce(Response.json(ready(2)));
    const stop = watchLocalWorkflowRegistry("http://api.test", onChange, { fetch });
    await tick(); await tick(1000);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: "unavailable" });
    await tick(1000);
    expect(onChange).toHaveBeenLastCalledWith({ kind: "status", value: ready(2) });
    expect(JSON.stringify(onChange.mock.calls)).not.toContain("secret"); stop();
  });

  it("copies only known source diagnostic fields", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn(), fetch = vi.fn(async () => Response.json({ revision: 1, status: "error",
      diagnostic: { ...sourceError, stack: "private stack", cause: { token: "private token" } }, privateField: "private payload" }));
    const stop = watchLocalWorkflowRegistry("http://api.test", onChange, { fetch });
    await tick();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: "status", value: { revision: 1, status: "error", diagnostic: sourceError } });
    expect(JSON.stringify(onChange.mock.calls)).not.toContain("private"); stop();
  });

  it.each([
    null, [], "private diagnostic", {},
    { ...sourceError, kind: "runtime" },
    { ...sourceError, code: "" }, { ...sourceError, code: "x".repeat(65) }, { ...sourceError, code: 42 },
    { ...sourceError, message: "" }, { ...sourceError, message: "x".repeat(1001) }, { ...sourceError, message: {} },
    ...["\n", "\u007f", "\u0085"].flatMap(control => [{ ...sourceError, code: `TS${control}1109` }, { ...sourceError, message: `Invalid${control}source.` }]),
    { ...sourceError, file: "" }, { ...sourceError, file: "src/" + "x".repeat(509) }, { ...sourceError, file: 42 },
    ...["/private/src/file.ts", "file:///src/file.ts", "node_modules/file.ts", "src/../private.ts", "workflows/./file.ts",
      "src//file.ts", "src/", "src/hidden\\file.ts", "src/file\n.ts", "src/file\u007f.ts", "src/file\u0085.ts"].map(file => ({ ...sourceError, file })),
    { ...sourceError, line: 0 }, { ...sourceError, column: -1 }, { ...sourceError, line: 1.5 },
    { ...sourceError, column: Number.MAX_SAFE_INTEGER + 1 }, { ...sourceError, line: "12" },
    { ...sourceError, column: null }, { ...sourceError, line: undefined }, { ...sourceError, column: undefined },
  ])("rejects malformed source diagnostic %# without emitting raw details", async diagnostic => {
    vi.useFakeTimers();
    const onChange = vi.fn(), fetch = vi.fn(async () => Response.json({ revision: 1, status: "error", message: "private raw payload", diagnostic }));
    const stop = watchLocalWorkflowRegistry("http://api.test", onChange, { fetch });
    await tick();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: "unavailable" });
    expect(JSON.stringify(onChange.mock.calls)).not.toContain("private"); stop();
  });

  it("accepts bounded diagnostics with and without a source position", async () => {
    vi.useFakeTimers();
    const diagnostic = { kind: "source", code: "C".repeat(64), message: "m".repeat(1000), file: "workflows/" + "x".repeat(502) };
    const onChange = vi.fn(), fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ revision: 1, status: "error", diagnostic }))
      .mockResolvedValueOnce(Response.json({ revision: 1, status: "error", diagnostic: { ...diagnostic, file: "src/file..ts", line: Number.MAX_SAFE_INTEGER, column: 1 } }));
    const stop = watchLocalWorkflowRegistry("http://api.test", onChange, { fetch });
    await tick();
    expect(onChange).toHaveBeenLastCalledWith({ kind: "status", value: { revision: 1, status: "error", diagnostic } });
    await tick(1000);
    expect(onChange).toHaveBeenLastCalledWith({ kind: "status", value: { revision: 1, status: "error", diagnostic: { ...diagnostic, file: "src/file..ts", line: Number.MAX_SAFE_INTEGER, column: 1 } } });
    stop();
  });

  it("bounds a stuck request and never overlaps polling requests", async () => {
    vi.useFakeTimers();
    let active = 0, maxActive = 0;
    const fetch = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => {
      active++; maxActive = Math.max(active, maxActive);
      return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => {
        active--; reject(new Error("aborted"));
      }, { once: true }));
    });
    const onChange = vi.fn(), stop = watchLocalWorkflowRegistry("http://api.test", onChange, { fetch });
    await tick(4999); expect(fetch).toHaveBeenCalledTimes(1);
    await tick(1); expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: "unavailable" });
    await tick(1000); expect(fetch).toHaveBeenCalledTimes(2); expect(maxActive).toBe(1);
    stop(); await tick(20_000); expect(active).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores a late response after teardown", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })), onChange = vi.fn();
    const stop = watchLocalWorkflowRegistry("http://api.test", onChange, { fetch });
    await tick(); stop(); finish(Response.json(ready(1))); await tick(10_000);
    expect(onChange).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Local workflow registry UI", () => {
  it.each([true, false])("shows source details in both red warnings and keeps them until a successful reload (position: %s)", async withPosition => {
    vi.useFakeTimers();
    const diagnostic = withPosition ? sourceError : { ...sourceError, file: "workflows/registry.ts", line: undefined, column: undefined };
    const location = withPosition ? "src/workflows/weather.ts:12:7" : "workflows/registry.ts";
    const description = `${location} — TS2304: Cannot find name 'missingStep'. Fix the source error and save again. The previous workflows remain available.`;
    let value: object = { revision: 1, status: "error", message: "Generic reload failure must not be duplicated.", diagnostic };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
    notice(); await tick();
    const toast = screen.getByRole("alert"), warning = screen.getByRole("status", { name: "Workflow reload warning" });
    expect(within(toast).getByText(description)).toBeTruthy();
    expect(within(warning).getByText(description)).toBeTruthy();
    expect(toast.className).toContain("text-destructive");
    expect(warning.className).toContain("border-red-500");
    expect(document.body.textContent).not.toContain("Generic reload failure");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    for (const status of ["error", "validating", "waiting"]) {
      value = status === "error" ? value : { revision: 1, status }; await tick(1000);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(within(screen.getByRole("status", { name: "Workflow reload warning" })).getByText(description)).toBeTruthy();
      if (status !== "error") expect(screen.getByRole("status", { name: "Workflow reload progress" }).textContent)
        .toContain(status === "validating" ? "Checking workflow registry changes" : "waiting for active work to finish");
    }
    value = ready(2); await tick(1000);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status", { name: "Workflow reload warning" })).toBeNull();
    value = { revision: 2, status: "validating" }; await tick(1000);
    expect(screen.queryByRole("status", { name: "Workflow reload warning" })).toBeNull();
    expect(screen.getByRole("status", { name: "Workflow reload progress" })).toBeTruthy();
  });

  it("removes an active source-error toast and persistent warning after successful reload", async () => {
    vi.useFakeTimers();
    let value: object = { revision: 1, status: "error", diagnostic: sourceError };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
    notice(); await tick();
    expect(screen.getByRole("alert").textContent).toContain(sourceError.message);
    value = ready(2); await tick(1000);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status", { name: "Workflow reload warning" })).toBeNull();
  });

  it("notifies again when the source error changes after dismissal", async () => {
    vi.useFakeTimers();
    let diagnostic = sourceError;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 1, status: "error", diagnostic })));
    notice(); await tick();
    for (const change of [{ file: "src/other.ts" }, { line: 14 }, { column: 8 }, { code: "TS1005" }, { message: "'}' expected." }]) {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      diagnostic = { ...diagnostic, ...change }; await tick(1000);
      expect(screen.getByRole("alert").textContent).toContain(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} — ${diagnostic.code}: ${diagnostic.message}`);
    }
  });

  it("renders diagnostic text without interpreting HTML", async () => {
    vi.useFakeTimers();
    const message = "Unexpected '<img src=x onerror=alert(1)>'.";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 1, status: "error", diagnostic: { ...sourceError, message } })));
    notice(); await tick();
    expect(screen.getByRole("alert").textContent).toContain(message);
    expect(screen.getByRole("status", { name: "Workflow reload warning" }).textContent).toContain(message);
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows a safe warning for malformed source details without leaking the payload", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 1, status: "error", message: "private exception",
      diagnostic: { ...sourceError, file: "/private/project/source.ts", message: "private diagnostic" } })));
    notice(); await tick();
    expect(screen.getByRole("status", { name: "Workflow reload warning" }).textContent).toContain("Could not check workflow reload status");
    expect(document.body.textContent).not.toContain("private");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["ready", "validating", "waiting"])("does not display a stray diagnostic on %s status", async status => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 1, status, diagnostic: { ...sourceError, file: "/private/file.ts" } })));
    notice(); await tick();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status", { name: "Workflow reload warning" })).toBeNull();
    expect(document.body.textContent).not.toContain("private");
    expect(document.body.textContent).not.toContain(sourceError.message);
  });

  it("shows validation/waiting progress, a dismissible error toast, persistent warning, and recovery", async () => {
    vi.useFakeTimers();
    let value: object = { revision: 1, status: "validating" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
    notice(); await tick();
    expect(screen.getByRole("status", { name: "Workflow reload progress" }).textContent).toContain("Checking workflow registry changes");
    value = { revision: 1, status: "waiting" }; await tick(1000);
    expect(screen.getByRole("status", { name: "Workflow reload progress" }).textContent).toContain("Suspended Runs do not block reload");
    value = { revision: 1, status: "error", message: "Fix the duplicate workflow identity." }; await tick(1000);
    expect(screen.getByRole("alert").textContent).toContain("Fix the duplicate workflow identity.");
    const warning = screen.getByRole("status", { name: "Workflow reload warning" });
    expect(warning.textContent).toContain("The previous workflows remain available");
    expect(warning.className).toContain("border-red-500");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    await tick(1000); expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: "Workflow reload warning" })).toBeTruthy();
    value = ready(2); await tick(1000);
    expect(screen.queryByRole("status", { name: "Workflow reload warning" })).toBeNull();
    expect(screen.queryByRole("status", { name: "Workflow reload progress" })).toBeNull();
  });

  it("does not claim last-good service is healthy when restart is required", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 1, status: "error", restartRequired: true,
      message: "Local permissions could not be restored." })));
    notice(); await tick();
    expect(screen.getByRole("alert").textContent).toContain("Stop and restart the Local server before starting new Runs");
    expect(document.body.textContent).not.toContain("previous workflows remain available");
  });

  it.each([sourceError, { ...sourceError, file: "/private/file.ts" }])("gives restart-required faults priority over current and stale source details %#", async diagnostic => {
    vi.useFakeTimers();
    let value: object = { revision: 1, status: "error", diagnostic: sourceError };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
    notice(); await tick();
    expect(screen.getByRole("alert").textContent).toContain(sourceError.message);
    value = { revision: 1, status: "error", restartRequired: true, diagnostic, message: "Local permissions could not be restored." };
    await tick(1000);
    for (const element of [screen.getByRole("alert"), screen.getByRole("status", { name: "Workflow reload warning" })]) {
      expect(element.textContent).toContain("Local permissions could not be restored.");
      expect(element.textContent).toContain("Stop and restart the Local server before starting new Runs.");
    }
    expect(document.body.textContent).not.toContain(sourceError.message);
    expect(document.body.textContent).not.toContain("previous workflows remain available");
    expect(document.body.textContent).not.toContain("private");
  });

  it("shows a safe transport warning and removes it after recovery", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("private fetch stack"))
      .mockResolvedValueOnce(Response.json(ready(1))));
    notice(); await tick();
    expect(screen.getByRole("status", { name: "Workflow reload warning" }).textContent).toContain("this page will retry automatically");
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private fetch stack");
    await tick(1000); expect(screen.queryByRole("status", { name: "Workflow reload warning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss notification" })).toBeNull();
  });

  it("refreshes both workflow caches and configuration/readiness only when the active revision changes", async () => {
    vi.useFakeTimers();
    let value: object = ready(1);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
    const { client } = notice(), invalidate = vi.spyOn(client, "invalidateQueries");
    client.setQueryData(["runs", "detail", "run-1"], { saved: true });
    await tick(); value = { revision: 1, status: "waiting" }; await tick(1000);
    expect(invalidate).not.toHaveBeenCalled();
    value = ready(2); await tick(1000);
    expect(invalidate.mock.calls.map(([filter]) => filter?.queryKey)).toEqual([
      ["workflows"], ["runs", "workflows"], ["run-configuration-definitions"], ["run-configuration-definition"],
      ["run-configuration-metadata"], ["agent-template-metadata"], ["workflow-runtime-readiness"],
    ]);
    await tick(1000); expect(invalidate).toHaveBeenCalledTimes(7);
    expect(client.getQueryData(["runs", "detail", "run-1"])).toEqual({ saved: true });
    expect(client.getQueryState(["runs", "detail", "run-1"])?.isInvalidated).toBe(false);
  });

  it("does not start Local polling for the platform profile", async () => {
    vi.useFakeTimers(); window.history.replaceState({}, "", "/users");
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json({ items: [], pagination: {} })); vi.stubGlobal("fetch", fetch);
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "managed-fixture" }} resultPlugins={[]}
      uiConfiguration={agentExecutionUiConfiguration("platform")} />);
    await tick(2000);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("workflow-registry"))).toBe(false);
  });

  it("refreshes a real workflow page without closing its draft or changing navigation", async () => {
    vi.useFakeTimers(); window.history.replaceState({}, "", "/workflows/weather/1");
    let revision = 1;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); requests.push(url.pathname);
      if (url.pathname === "/arkimux/workflow-registry") return Response.json(ready(revision));
      if (url.pathname === "/api/v1/workflows") return Response.json({ items: [{ workflow: { kind: "weather", version: 1 },
        title: revision === 1 ? "Weather" : "Updated weather", inputExample: {}, agentSlots: [], allowedRoleIds: ["developer"] }] });
      if (url.pathname.endsWith("editor-metadata")) return Response.json({ executionProviders: [] });
      if (url.pathname.includes("run-configurations") || url.pathname === "/api/v1/agent-templates") return Response.json({ items: [], pagination: {} });
      return Response.json({}, { status: 404 });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "local-fixture" }} resultPlugins={[]}
      uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    await tick(); await tick(1);
    fireEvent.click(screen.getByRole("button", { name: "Create configuration" }));
    const dialog = screen.getByRole("dialog"), input = within(dialog).getByLabelText("Run configuration JSON") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '{"draft":"keep this text"}' } });
    revision = 2; await tick(1000); await tick(1);
    expect(screen.getByRole("heading", { name: "Updated weather", level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe("/workflows/weather/1");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect((within(dialog).getByLabelText("Run configuration JSON") as HTMLTextAreaElement).value).toBe('{"draft":"keep this text"}');
    expect(requests.filter(value => value === "/api/v1/workflows")).toHaveLength(2);
    expect(requests.every(value => !value.includes("/probe"))).toBe(true);
  });
});
