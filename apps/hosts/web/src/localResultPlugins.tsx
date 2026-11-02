import { useEffect, useState } from "react";
import type { AnyResultReactPlugin, ResultRendererProps } from "@com-pyvue/agent-execution-result-presentation";
import { ResultRendererAlert } from "@com-pyvue/agent-execution-result-presentation";

export const rendererFailureMessage = "Your Run and result are unaffected. Showing original JSON.";
export const rendererConnectionMessage = "Your Run and result are unaffected. Showing original JSON; retrying automatically.";

export async function loadLocalResultPlugins(apiBaseUrl: string): Promise<AnyResultReactPlugin[]> {
  const response = await fetch(`${apiBaseUrl}/arkimux/result-renderers`, { credentials: "include" });
  if (!response.ok) return [];
  const values: unknown = await response.json();
  return pluginsFor(values, apiBaseUrl);
}

function pluginsFor(values: unknown, apiBaseUrl: string): AnyResultReactPlugin[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || typeof value.resultKind !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.resultKind)
      || !Number.isSafeInteger(value.payloadSchemaVersion) || value.payloadSchemaVersion < 1) return false;
    const key = `${value.resultKind}@${value.payloadSchemaVersion}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map((value) => ({
    resultKind: value.resultKind, payloadSchemaVersion: value.payloadSchemaVersion,
    validatePayload: (payload: unknown) => payload,
    Component: (props: ResultRendererProps) => <LocalProjectResult {...props} apiBaseUrl={apiBaseUrl} />,
  }));
}

/** One bounded metadata request at a time; changes replace views without resetting navigation. */
export function watchLocalResultPlugins(apiBaseUrl: string, onChange: (plugins: AnyResultReactPlugin[], unavailableReason?: string, tone?: "error" | "warning") => void): () => void {
  let stopped = false;
  let signature: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  const poll = async () => {
    active = new AbortController();
    const timeout = setTimeout(() => active?.abort(), 5000);
    try {
      const response = await fetch(`${apiBaseUrl}/arkimux/result-renderers`, { credentials: "include", cache: "no-store", signal: active.signal });
      if (!response.ok) throw new Error("Renderer metadata unavailable.");
      const values: unknown = await response.json();
      if (!Array.isArray(values)) throw new Error("Invalid renderer metadata.");
      const status = response.headers.get("X-ArkiMux-Renderer-Status");
      const next = JSON.stringify([response.headers.get("X-ArkiMux-Renderer-Revision"), status, values]);
      if (!stopped && next !== signature) {
        signature = next;
        if (status === "error") onChange([], rendererFailureMessage, "error");
        else onChange(pluginsFor(values, apiBaseUrl));
      }
    } catch {
      if (!stopped && signature !== "unavailable") { signature = "unavailable"; onChange([], rendererConnectionMessage, "warning"); }
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    }
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); active?.abort(); };
}

function LocalProjectResult({ result, apiBaseUrl }: ResultRendererProps & { apiBaseUrl: string }) {
  const [html, setHtml] = useState<string>();
  const [failure, setFailure] = useState<"renderer" | "connection" | "absent">();
  useEffect(() => {
    let stopped = false;
    let active: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setHtml(undefined); setFailure(undefined);
    const load = async () => {
      const controller = new AbortController(); active = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${apiBaseUrl}/arkimux/result-views/${encodeURIComponent(result.runRef.executionId)}/${encodeURIComponent(result.resultId)}`, { credentials: "include", signal: controller.signal, cache: "no-store" });
        if (stopped) return;
        if (response.status === 422) { setFailure("renderer"); return; }
        if (response.status === 404) { setFailure("absent"); return; }
        if (!response.ok) throw new Error("Renderer request failed.");
        const value = await response.text();
        if (!stopped) { setHtml(value); setFailure(undefined); }
      } catch {
        if (!stopped) { setFailure("connection"); retry = setTimeout(() => void load(), 1000); }
      } finally { clearTimeout(timeout); }
    };
    void load();
    return () => { stopped = true; clearTimeout(retry); active?.abort(); };
  }, [apiBaseUrl, result.runRef.executionId, result.resultId]);
  if (failure) return <section className="space-y-3">{failure === "absent"
    ? <p className="text-sm text-muted-foreground">No compatible result renderer is installed.</p>
    : <ResultRendererAlert tone={failure === "connection" ? "warning" : "error"} message={failure === "connection" ? rendererConnectionMessage : rendererFailureMessage} />}
    <pre>{JSON.stringify(result, null, 2)}</pre></section>;
  if (html === undefined) return <p>Loading result view…</p>;
  // fetch + srcDoc does not carry the HTML response's CSP header into the frame.
  const isolatedHtml = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">${html}`;
  return <iframe title="Workflow result" sandbox="" srcDoc={isolatedHtml} className="min-h-[40rem] w-full border-0" />;
}
