import { useLocalUsageStatus } from "./localUsageSharing.tsx";
import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@com-pyvue/agent-execution-ui";
import type { RunApiClientOptions } from "@com-pyvue/agent-execution-run-contract";

interface DiagnosticSummary {
  schemaVersion: 1;
  diagnosticId: string;
  recordedAt: string;
  arkimuxVersion: string;
  component: string;
  operation: string;
}
interface DiagnosticRecord extends DiagnosticSummary {
  runtime: { nodeVersion: string; platform: string; architecture: string };
  error: { name: string; message: string; stack?: string; cause?: unknown; errors?: unknown[] };
  truncated: boolean;
}
interface DiagnosticsProps {
  apiBaseUrl: string;
  session: { cacheKey: string; requestInit?: RunApiClientOptions["requestInit"] };
}

export function LocalDiagnosticsSettings(props: DiagnosticsProps) {
  return <LocalDiagnosticsContent key={JSON.stringify([props.apiBaseUrl, props.session.cacheKey])} {...props} />;
}

function LocalDiagnosticsContent(props: DiagnosticsProps) {
  const { data: status } = useLocalUsageStatus(props);
  const [items, setItems] = useState<DiagnosticSummary[]>([]);
  const [selected, setSelected] = useState<DiagnosticRecord>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const inspection = useRef(0);
  const [deleting, setDeleting] = useState(false);
  const refresh = async () => {
    setError(undefined);
    setLoadState("loading");
    try {
      const value = await request<{ items: DiagnosticSummary[] }>(props, "/api/v1/local/diagnostics", "GET");
      setItems(value.items);
      if (selected && !value.items.some(item => item.diagnosticId === selected.diagnosticId)) setSelected(undefined);
      setLoadState("ready");
    } catch (caught) { setLoadState("failed"); throw caught; }
  };
  useEffect(() => { void refresh().catch(showError); }, [props.apiBaseUrl, props.session.cacheKey]);
  const showError = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const inspect = async (diagnosticId: string) => {
    const current = ++inspection.current;
    setError(undefined);
    setSelected(undefined); setCopied(false);
    try {
      const record = await request<DiagnosticRecord>(props, `/api/v1/local/diagnostics/${diagnosticId}`, "GET");
      if (current !== inspection.current) return;
      setSelected(record); setCopied(false);
    }
    catch (caught) { if (current === inspection.current) showError(caught); }
  };
  const remove = async (diagnosticId?: string) => {
    ++inspection.current;
    setError(undefined);
    setSelected(undefined); setCopied(false); setDeleting(true);
    try {
      await request<void>(props, diagnosticId ? `/api/v1/local/diagnostics/${diagnosticId}` : "/api/v1/local/diagnostics", "DELETE");
      await refresh();
    } catch (caught) { showError(caught); }
    finally { setDeleting(false); }
  };
  const copyId = async (diagnosticId: string) => {
    try { await navigator.clipboard.writeText(diagnosticId); }
    catch { setError("Could not copy the diagnostic ID."); }
  };
  const copyDiagnostic = async () => {
    if (!selected) return;
    const current = inspection.current;
    setError(undefined); setCopied(false);
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
      if (current === inspection.current) setCopied(true);
    }
    catch { if (current === inspection.current) setError("Could not copy the diagnostic. Select and copy it manually."); }
  };
  const download = (record: DiagnosticRecord) => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(record, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `arkimux-diagnostic-${record.diagnosticId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return <main className="mx-auto max-w-5xl space-y-6 p-6 lg:p-8">
    <header><p className="text-sm text-muted-foreground">Settings</p><h1 className="text-3xl font-semibold">Diagnostics</h1>
      <Link className="text-sm underline underline-offset-4" to="/settings/privacy">Open Privacy</Link></header>
    <Card><CardHeader><CardTitle>Local diagnostics</CardTitle>
      <CardDescription>Inspect original error details saved on this computer.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><strong>Full diagnostic files stay on this computer.</strong> ArkiMux does not upload error reports automatically. You decide whether to report an issue and which details to share. <Link className="underline underline-offset-4" to="/settings/privacy/terms">Read the Privacy Notice</Link>.</p>
        <p className="text-sm text-muted-foreground">At most 20 records are kept for 7 days under <code>.arkimux/local/diagnostics</code>. Each record is limited to 256 KiB. GitHub issues are public; you review and submit the issue yourself.</p>
        <div className="flex items-center justify-between gap-3"><a className="text-sm underline underline-offset-4" href={issueUrl(selected?.arkimuxVersion ?? status?.arkimuxVersion)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Report an issue on GitHub</a><Button variant="outline" disabled={deleting || loadState !== "ready" || items.length === 0} onClick={() => void remove()}>Delete all</Button></div>
        {loadState === "loading" ? <p role="status">Loading diagnostics…</p> : loadState === "failed" ? <div className="space-y-2"><p>Diagnostics could not be loaded.</p><Button variant="outline" onClick={() => void refresh().catch(showError)}>Try again</Button></div> : items.length === 0 ? <p>No local diagnostics recorded.</p> : <div className="space-y-2">{items.map(item => <div key={item.diagnosticId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <div><p className="font-medium">{item.component}: {item.operation}</p><p className="text-sm text-muted-foreground">{new Date(item.recordedAt).toLocaleString()}</p><code className="text-xs">{item.diagnosticId}</code></div>
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={deleting} onClick={() => void inspect(item.diagnosticId)}>Inspect</Button><Button variant="outline" onClick={() => void copyId(item.diagnosticId)}>Copy ID</Button><Button variant="outline" disabled={deleting} onClick={() => void remove(item.diagnosticId)}>Delete</Button></div>
        </div>)}</div>}
        {selected ? <section className="space-y-3 rounded-md border p-4" aria-label="Diagnostic details"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold">Diagnostic details</h2>
          <div className="flex items-center gap-2"><Button variant="outline" size="icon" title="Copy diagnostic" aria-label="Copy diagnostic" onClick={() => void copyDiagnostic()}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {copied ? <path d="m5 12 4 4 10-10" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}
            </svg>
          </Button><Button variant="outline" onClick={() => download(selected)}>Download JSON</Button></div></div>
          <pre aria-label="Diagnostic JSON" className="max-h-[32rem] select-text overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-xs">{JSON.stringify(selected, null, 2)}</pre>
          <p className="text-sm">GitHub issues are public. Before submitting, edit the copied text in your editor or the GitHub form to remove credentials, private paths, and anything you do not want to disclose. The issue form includes only the framework version and blank prompts. No diagnostic or file is attached automatically.</p>
          {copied ? <p role="status">Diagnostic copied. Review and remove private information before sharing.</p> : null}</section> : null}
        {error ? <ErrorNotification description={error} /> : null}
      </CardContent>
    </Card>
  </main>;
}

async function request<T>(props: DiagnosticsProps, path: string, method: "GET" | "DELETE"): Promise<T> {
  const supplied = await props.session.requestInit?.() ?? {};
  const headers = new Headers(supplied.headers);
  headers.set("accept", "application/json");
  const response = await fetch(`${props.apiBaseUrl.replace(/\/$/, "")}${path}`, { ...supplied, method, headers });
  if (response.status === 204) return undefined as T;
  const value = await response.json().catch(() => undefined) as T | { error?: { message?: string } } | undefined;
  if (!response.ok) {
    const failure = value && typeof value === "object" && "error" in value ? value.error?.message : undefined;
    throw new Error(failure ?? "Diagnostics request failed.");
  }
  return value as T;
}

/** Never include diagnostic content, local paths or identifiers in an external URL. */
function issueUrl(version?: string): string {
  const safeVersion = version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : "Please enter your ArkiMux version";
  const url = new URL("https://github.com/com-pyvue/arkimux/issues/new");
  url.searchParams.set("title", "Bug report");
  url.searchParams.set("body", `ArkiMux version: ${safeVersion}\n\n### Expected behavior\n\n### Actual behavior\n\n### Steps to reproduce\n\n### Optional diagnostic details\nOnly paste or attach information you want to make public. Remove credentials and private data before submitting.`);
  return url.href;
}
