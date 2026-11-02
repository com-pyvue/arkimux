import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import type { RunApiClientOptions } from "@com-pyvue/agent-execution-run-contract";
import { notify, dismissNotification, type ToastVariant } from "@com-pyvue/agent-execution-ui";

interface RegistryStatus {
  revision: number;
  status: "ready" | "validating" | "waiting" | "error";
  message?: string;
  restartRequired?: boolean;
  diagnostic?: SourceDiagnostic;
}
interface SourceDiagnostic { kind: "source"; code: string; message: string; file: string; line?: number; column?: number }
type RegistryEvent = { kind: "status"; value: RegistryStatus } | { kind: "unavailable" | "unsupported" };
interface Notification { title: string; description: string; variant: ToastVariant }
const unavailableMessage = "Could not check workflow reload status. Check that the Local server is running; this page will retry automatically.";
const reloadQueryKeys = [
  ["workflows"], ["runs", "workflows"], ["run-configuration-definitions"], ["run-configuration-definition"],
  ["run-configuration-metadata"], ["agent-template-metadata"], ["workflow-runtime-readiness"],
] as const;

function sourceDiagnostic(value: unknown): SourceDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reload diagnostic.");
  const record = value as Record<string, unknown>;
  if (record.kind !== "source"
    || typeof record.code !== "string" || record.code.length < 1 || record.code.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(record.code)
    || typeof record.message !== "string" || record.message.length < 1 || record.message.length > 1000 || /[\u0000-\u001f\u007f-\u009f]/.test(record.message)
    || typeof record.file !== "string" || record.file.length < 1 || record.file.length > 512
    || !/^(src|workflows)\//.test(record.file) || /[\\\u0000-\u001f\u007f-\u009f]/.test(record.file)
    || record.file.split("/").some(part => !part || part === "." || part === "..")
    || ((record.line !== undefined || record.column !== undefined)
      && (!Number.isSafeInteger(record.line) || (record.line as number) < 1
        || !Number.isSafeInteger(record.column) || (record.column as number) < 1))) throw new Error("Invalid reload diagnostic.");
  return { kind: "source", code: record.code, message: record.message, file: record.file,
    ...(record.line !== undefined ? { line: record.line as number, column: record.column as number } : {}) };
}

function registryStatus(value: unknown): RegistryStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reload status.");
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || !["ready", "validating", "waiting", "error"].includes(record.status as string)
    || (record.message !== undefined && (typeof record.message !== "string" || record.message.length > 2000))
    || (record.restartRequired !== undefined && typeof record.restartRequired !== "boolean")) throw new Error("Invalid reload status.");
  return { revision: record.revision as number, status: record.status as RegistryStatus["status"],
    ...(record.message !== undefined ? { message: record.message as string } : {}),
    ...(record.restartRequired !== undefined ? { restartRequired: record.restartRequired as boolean } : {}),
    ...(record.status === "error" && !record.restartRequired && record.diagnostic !== undefined
      ? { diagnostic: sourceDiagnostic(record.diagnostic) } : {}) };
}

/** Local-only metadata. No overlapping requests, no provider probes, and no raw
 * transport/parser exception is displayed. An absent endpoint disables the watcher.
 */
export function watchLocalWorkflowRegistry(apiBaseUrl: string, onChange: (event: RegistryEvent) => void,
  options: { requestInit?: RunApiClientOptions["requestInit"]; fetch?: typeof fetch } = {}): () => void {
  let stopped = false, signature: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
  const emit = (event: RegistryEvent) => {
    const next = JSON.stringify(event);
    if (!stopped && signature !== next) { signature = next; onChange(event); }
  };
  const poll = async () => {
    const controller = new AbortController(); active = controller;
    const timeout = setTimeout(() => { controller.abort(); emit({ kind: "unavailable" }); }, 5000); deadline = timeout;
    try {
      const supplied = await options.requestInit?.() ?? {};
      if (stopped || controller.signal.aborted) return;
      const headers = new Headers(supplied.headers); headers.set("accept", "application/json");
      const response = await (options.fetch ?? globalThis.fetch)(`${apiBaseUrl.replace(/\/$/, "")}/arkimux/workflow-registry`,
        { ...supplied, method: "GET", headers, credentials: supplied.credentials ?? "include", cache: "no-store", signal: controller.signal });
      if ([404, 405, 501].includes(response.status)) { emit({ kind: "unsupported" }); stopped = true; return; }
      if (!response.ok) throw new Error("Reload status unavailable.");
      emit({ kind: "status", value: registryStatus(await response.json()) });
    } catch {
      emit({ kind: "unavailable" });
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    }
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(deadline); active?.abort(); };
}

export function LocalWorkflowRegistryNotice(props: { apiBaseUrl: string; requestInit?: RunApiClientOptions["requestInit"] }) {
  const queryClient = useQueryClient();
  const requestInit = useRef(props.requestInit); requestInit.current = props.requestInit;
  const [event, setEvent] = useState<RegistryEvent>();
  const [notice, setNotice] = useState<Notification>();
  useEffect(() => {
    let revision: number | undefined, issue: string | undefined;
    let notificationId: number | undefined;
    let sourceFailure: RegistryEvent | undefined;
    return watchLocalWorkflowRegistry(props.apiBaseUrl, (next) => {
      if (next.kind === "status") {
        if (revision !== undefined && revision !== next.value.revision) {
          for (const queryKey of reloadQueryKeys) void queryClient.invalidateQueries({ queryKey });
        }
        revision = next.value.revision;
        if (next.value.status === "ready" || next.value.status === "error") {
          sourceFailure = next.value.status === "error" && next.value.diagnostic && !next.value.restartRequired ? next : undefined;
        }
      }
      const displayed = sourceFailure && next.kind === "status" && (next.value.status === "validating" || next.value.status === "waiting")
        ? sourceFailure : next;
      const nextNotification = notificationFor(displayed), nextIssue = nextNotification && JSON.stringify(nextNotification);
      if (nextIssue !== issue) {
        issue = nextIssue;
        if (notificationId !== undefined) dismissNotification(notificationId);
        notificationId = nextNotification ? notify(nextNotification) : undefined;
      }
      setNotice(nextNotification);
      setEvent(next);
    }, { requestInit: () => requestInit.current?.() ?? {} });
  }, [props.apiBaseUrl, queryClient]);

  const progress = event?.kind === "status" && (event.value.status === "validating" || event.value.status === "waiting") ? event.value.status : undefined;
  return <>
    {notice ? <section role="status" aria-label="Workflow reload warning" className={`mx-4 mt-4 flex gap-3 rounded-lg border-l-4 p-4 md:mx-8 ${notice.variant === "error"
      ? "border-red-500 bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100"
      : "border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"}`}>
      <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div><p className="font-semibold">{notice.title}</p><p className="text-sm">{notice.description}</p></div>
    </section> : null}
    {progress ? <section role="status" aria-label="Workflow reload progress" className="mx-4 mt-4 flex items-center gap-3 rounded-lg border bg-muted/40 p-4 text-sm md:mx-8">
      <LoaderCircle className="size-5 shrink-0 animate-spin" aria-hidden="true" />
      <p>{progress === "validating" ? "Checking workflow registry changes…" : "Workflow reload is waiting for active work to finish. Suspended Runs do not block reload."}</p>
    </section> : null}
  </>;
}

function notificationFor(event: RegistryEvent): Notification | undefined {
  if (event.kind === "unavailable") return { title: "Workflow reload status unavailable", description: unavailableMessage, variant: "warning" };
  if (event.kind !== "status" || event.value.status !== "error") return undefined;
  const restart = event.value.restartRequired;
  const diagnostic = !restart && event.value.diagnostic;
  if (diagnostic) {
    const location = diagnostic.line !== undefined ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}` : diagnostic.file;
    return { title: "Workflow reload failed", variant: "error",
      description: `${location} — ${diagnostic.code}: ${diagnostic.message} Fix the source error and save again. The previous workflows remain available.` };
  }
  return { title: restart ? "Workflow reload requires a restart" : "Workflow reload failed", variant: "error",
    description: [event.value.message, restart ? "Stop and restart the Local server before starting new Runs." : "The previous workflows remain available. Fix the registry and save again."].filter(Boolean).join(" ") };
}
