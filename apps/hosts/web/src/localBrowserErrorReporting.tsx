import { Component, useEffect, useMemo, type ReactNode } from "react";
import { ErrorNotification, Toaster } from "@com-pyvue/agent-execution-ui";
import { serializeError } from "@com-pyvue/agent-execution-core/internal/application/errorDiagnostics.ts";
import type { AuthenticatedWebSession } from "./index.tsx";

export function createBrowserErrorReporter(apiBaseUrl: string, session: AuthenticatedWebSession) {
  const seen = new WeakSet<object>();
  let windowStart = 0, count = 0;
  return (error: unknown): void => {
    void (async () => {
      try {
        if (error instanceof Error && ["AbortError", "AgentExecutionCancelledError"].includes(error.name)) return;
        if (error && typeof error === "object") {
          if (seen.has(error)) return;
          seen.add(error);
        }
        const now = Date.now(); if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
        if (++count > 10) return;
        // Leave room for the bounded cause/aggregate structure within the
        // receiver's 16 KiB request limit. This sends only to the Local API.
        const body = JSON.stringify(serializeError(error, {
          maxTextBytes: 14 * 1024, maxMessageLength: 4096, maxStackLength: 12000,
        }));
        if (new TextEncoder().encode(body).byteLength > 16 * 1024) return;
        const supplied = await session.requestInit?.() ?? {};
        const headers = new Headers(supplied.headers); headers.set("content-type", "application/json");
        await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/v1/local/diagnostics/browser`, { ...supplied, method: "POST", headers, body, signal: AbortSignal.timeout(3000) });
      } catch { /* No toast, retry or recursive report for reporting failures. */ }
    })();
  };
}

export function LocalBrowserErrorReporting(props: { apiBaseUrl: string; session: AuthenticatedWebSession; children: ReactNode }) {
  const report = useMemo(() => createBrowserErrorReporter(props.apiBaseUrl, props.session), [props.apiBaseUrl, props.session.cacheKey]);
  useEffect(() => {
    const error = (event: ErrorEvent) => report(event.error ?? event.message);
    const rejection = (event: PromiseRejectionEvent) => report(event.reason);
    window.addEventListener("error", error); window.addEventListener("unhandledrejection", rejection);
    return () => { window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); };
  }, [report]);
  return <LocalInterfaceBoundary report={report}>{props.children}</LocalInterfaceBoundary>;
}

class LocalInterfaceBoundary extends Component<{ report(error: unknown): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.report(error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <><Toaster /><main className="p-8"><h1>Local could not display this page.</h1><p>Your saved runs are unchanged.</p><button onClick={() => location.reload()}>Reload page</button></main><ErrorNotification description="The Local interface encountered an error. Reload the page to try again." /></>;
  }
}
