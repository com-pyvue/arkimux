import { ErrorNotification, notify } from "@com-pyvue/agent-execution-ui";
import { Copy } from "lucide-react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogHeader, DialogTitle } from "@com-pyvue/agent-execution-ui";
import type { RunApiClientOptions } from "@com-pyvue/agent-execution-run-contract";

interface LocalUsageStatus {
  schemaVersion: 1;
  arkimuxVersion?: string;
  choice: "undecided" | "accepted" | "declined";
  sharingEnabled: boolean;
  promptEligible: boolean;
  consentExpired?: boolean;
  privacyNoticeVersion: string;
  provider: { kind: "arkimux"; configured: boolean };
  deliveryState: string;
  credentialDeletionPending: boolean;
  pendingEventCount: number;
  localRetentionDays: number;
  remoteRetentionDays: number | "indefinite" | null;
  remoteDeletion: "installation-authenticated";
  hasUnrequestedEarlierWithdrawal?: boolean;
  installationId?: string | null;
  privacyHistory?: Array<{ id: string; kind: "consent_granted" | "consent_expired" | "sharing_stopped" | "deletion_requested" | "deletion_accepted" | "deletion_completed";
    at?: string; installationId?: string; notice?: string; requestId?: string; completionDueAt?: string; recovered?: boolean }>;
  deletionRequest?: { status: "pending" | "accepted"; receipt?: { request_id: string; completion_due_at: string; status: string } } | null;
  privacy: { usageRetentionDays: number | "indefinite"; queryRetentionDays: number;
    logRetentionDays: number; deletionDescription: string } | null;
}

const privacyTermsPath = "/settings/privacy/terms";
const archiveDisclosure = "When you stop sharing, we delete the original events. For journeys shared under the archive notice, we keep the month, ordered steps, operation pairings and relative timing indefinitely under a new random key. The archive has no installation ID or exact timestamps and cannot be deleted by installation ID.";
const sandboxArchiveNotice = "dev-sandbox-archive-v1";
function archiveCopy(status?: LocalUsageStatus) {
  if (status?.privacyNoticeVersion === sandboxArchiveNotice) return "Dev sandbox only: choosing Yes lets ArkiMux keep your designated installation’s coded usage history after you stop sharing or after five inactive minutes. Original rows are deleted. The archive keeps the month, ordered steps, operation pairings and relative times under a random key, with no installation ID or exact timestamps. It has no automatic expiry and cannot be deleted by your installation ID.";
  return status?.privacyNoticeVersion === "usage-with-withdrawal-archive-v1-disclosed" ? archiveDisclosure : null;
}
const bundledNotice = { version: "usage-only-withdrawal-v1", localRetentionDays: 7 } as const;

export function LocalUsageSharingPrompt(props: LocalUsageProps) {
  const location = useLocation();
  const [confirmEarlier, setConfirmEarlier] = useState(false);
  const { data: status } = useLocalUsageStatus(props);
  const saveChoice = useSaveLocalUsageChoice(props);
  const [error, setError] = useState<string>();
  const choose = async (choice: "yes" | "no" | "ask-later") => {
    setError(undefined);
    try { await saveChoice(choice); setConfirmEarlier(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const promptOpen = status?.promptEligible === true && location.pathname !== privacyTermsPath;
  return <Dialog open={promptOpen}
    onOpenChange={(open) => { if (!open && promptOpen) void choose("ask-later"); }}
    aria-labelledby="local-usage-title">
    <DialogHeader><DialogTitle id="local-usage-title">Help improve ArkiMux</DialogTitle></DialogHeader>
    <DialogContent className="space-y-4">
      {status?.consentExpired && <p>Your usage-sharing choice expired due to inactivity. Sharing is off unless you choose Yes again.</p>}
      <p><strong>Our mission is to help developers go from idea to a running production workflow as fast as possible. Help us improve ArkiMux.</strong></p>
      <p className="text-sm text-muted-foreground">Share Local setup steps and session timing. Error reports stay local. No workflow content, prompts, results, credentials, or personal identity. Sharing is optional and does not affect Local features.</p>
      <p className="text-sm text-muted-foreground">Read the <Link className="underline underline-offset-4" to={privacyTermsPath}>Privacy Notice {status?.privacyNoticeVersion}</Link> before choosing. You can change your choice in Settings.</p>
      {archiveCopy(status) && <p>{archiveCopy(status)}</p>}
      {status?.privacyNoticeVersion === "installation-retention-180d-v1" && <p>Sharing expires after the service’s inactivity period (up to 180 days). Failed setup and connection tests count as activity; their error text is not sent.</p>}
      {error ? <ErrorNotification description={error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => void choose("ask-later")}>Ask later</Button>
        {confirmEarlier && status?.hasUnrequestedEarlierWithdrawal
          ? <><p>Declining will also request deletion of the earlier installation’s linked usage.</p><Button variant="outline" onClick={() => setConfirmEarlier(false)}>Cancel</Button><Button onClick={() => void choose("no")}>Confirm deletion</Button></>
          : <Button variant="outline" onClick={() => status?.hasUnrequestedEarlierWithdrawal ? setConfirmEarlier(true) : void choose("no")}>No</Button>}
        <Button onClick={() => void choose("yes")}>{status?.privacyNoticeVersion === sandboxArchiveNotice ? "Yes, share and archive sandbox usage" : "Yes"}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

export function LocalPrivacySettings(props: LocalUsageProps) {
  const { data: status, error: statusError } = useLocalUsageStatus(props);
  const saveChoice = useSaveLocalUsageChoice(props);
  const [error, setError] = useState<string>();
  const action = status?.choice === "accepted" ? "stop" : status?.hasUnrequestedEarlierWithdrawal ? "earlier" : null;
  const target = action && JSON.stringify([action,status?.choice,status?.installationId,status?.privacyNoticeVersion]);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const confirmDelete = !!target && confirmTarget === target;
  const [deleting, setDeleting] = useState(false);
  const queryClient = useQueryClient();
  const deleteShared = async () => {
    setDeleting(true); setError(undefined);
    try {
      if (action === "stop" || status?.choice === "undecided") await saveChoice("no");
      else if (action === "earlier") {
        const queryKey = statusQueryKey(props); await queryClient.cancelQueries({ queryKey });
        const updated = await request(props, "POST", { confirm: true }, "/deletion");
        queryClient.setQueryData(queryKey, updated);
      }
      setConfirmTarget(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Deletion could not start."); }
    finally { setDeleting(false); }
  };
  const choose = async (choice: "yes" | "no") => {
    setError(undefined);
    try { await saveChoice(choice); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const copyInstallationId = async () => {
    if (!status?.installationId) return;
    try { await navigator.clipboard.writeText(status.installationId); notify({ title: "Installation ID copied", description: "Copied to your clipboard.", variant: "success" }); }
    catch { setError("Could not copy the installation ID. Select and copy it manually."); }
  };
  return <main className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
    <header><p className="text-sm text-muted-foreground">Settings</p><h1 className="text-3xl font-semibold">Privacy</h1>
      <Link className="text-sm underline underline-offset-4" to="/settings/diagnostics">Open Diagnostics</Link></header>
    <Card><CardHeader><CardTitle>Optional Local usage sharing</CardTitle><CardDescription>Pseudonymous product signals and session timing. Error reports stay local.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {!status ? <p>Loading…</p> : <>
          <p><strong>Current choice:</strong> {status.choice === "accepted" ? "Yes" : status.choice === "declined" ? "No" : "Not decided"}</p>
          {!confirmDelete && status.choice !== "accepted" && archiveCopy(status) && <p>{archiveCopy(status)}</p>}
          <div className="flex flex-wrap items-center gap-2"><strong>Installation ID:</strong>
            {status.installationId ? <><code className="break-all select-text">{status.installationId}</code>
              <Button variant="ghost" size="icon" aria-label="Copy installation ID" title="Copy installation ID" onClick={() => void copyInstallationId()}><Copy aria-hidden="true" className="size-4" /></Button></>
              : <span>{status.choice === "accepted" ? "Registering…" : "No active installation"}</span>}
          </div>
          <p className="text-sm text-muted-foreground">One optional choice covers all ArkiMux projects in this OS user account: Local setup steps and session timing. Error reports, workflow content, and credentials are not shared.</p>
          <p className="text-sm text-muted-foreground"><Link className="underline underline-offset-4" to={privacyTermsPath}>Read the Privacy Notice {status.privacyNoticeVersion}</Link> for the exact data, exclusions, retention, and deletion rules.</p>
          <p className="text-sm text-muted-foreground">Provider: ArkiMux Telemetry Service ({status.provider.configured ? "configured" : "not configured"}). Delivery: {deliveryLabel(status.deliveryState)}. Pending events for this project: {status.pendingEventCount}.</p>
          {status.credentialDeletionPending ? <p role="status">Sharing is stopped for the old identity. Unlock the OS credential store so Local can finish deleting its credential.</p> : null}
          {!(confirmDelete && action) && <div className="flex flex-wrap gap-2">
            {status.choice !== "accepted" && <Button disabled={status.deletionRequest?.status === "pending"} onClick={() => void choose("yes")}>{status.privacyNoticeVersion === sandboxArchiveNotice ? "Share and archive sandbox usage" : "Share usage"}</Button>}
            {status.choice === "undecided" && <Button variant="outline" onClick={() => action === "earlier" ? setConfirmTarget(target) : void choose("no")}>Do not share</Button>}
            {action === "stop" && <Button variant="outline" onClick={() => setConfirmTarget(target)}>Stop sharing…</Button>}
            {action === "earlier" && status.choice === "declined" && <Button variant="outline" onClick={() => setConfirmTarget(target)}>Delete earlier shared data…</Button>}
          </div>}
          {status.deletionRequest?.status === "pending" ? <p role="status">Sharing has stopped. Local is waiting to submit your deletion request. Keep the service configuration and OS credential available; it will retry automatically. Delivery: {deliveryLabel(status.deliveryState)}.</p> : null}
          {confirmDelete && action ? <div className="space-y-2 rounded border p-3">
            <p>{action === "stop" ? "New uploads stop immediately. Any unsent events are discarded." : "Local will request deletion of data still linked to the earlier installation."} The service removes the original source usage data within seven days. Your workflows, runs and results are not deleted.</p>
            {archiveCopy(status) && <p>{archiveCopy(status)}</p>}
            <Button disabled={deleting} onClick={() => void deleteShared()}>{action === "stop" ? "Confirm stop sharing" : "Confirm deletion"}</Button>{" "}
            <Button variant="outline" disabled={deleting} onClick={() => setConfirmTarget(null)}>Cancel</Button>
          </div> : null}
        </>}
        {error || statusError ? <ErrorNotification description={error ?? statusError?.message} /> : null}
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>Privacy history</CardTitle><CardDescription>Saved only on this machine for this OS user account. Earlier events may be missing; unknown times and installation IDs are not reconstructed.</CardDescription></CardHeader>
      <CardContent>{status?.privacyHistory?.length ? <ol className="space-y-4" aria-label="Privacy history">
        {status.privacyHistory.map(entry => <li key={entry.id} className="space-y-1 border-b pb-3 last:border-0">
          <p className="font-medium">{privacyEventLabels[entry.kind]}</p>
          <p className="text-sm text-muted-foreground">{entry.at ? <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time> : "Time not recorded"}{entry.recovered ? " · Recovered from saved state" : ""}</p>
          <p className="text-sm break-all">Installation: <code>{entry.installationId ?? "Not recorded"}</code></p>
          {entry.notice ? <p className="text-sm break-all">Privacy Notice: {entry.notice}</p> : null}
          {entry.requestId ? <p className="text-sm break-all">Request: <code>{entry.requestId}</code></p> : null}
          {entry.kind === "deletion_accepted" ? <p className="text-sm text-muted-foreground">The service accepted this request; Local has not confirmed completion.{entry.completionDueAt ? ` Source-data deletion due by ${new Date(entry.completionDueAt).toLocaleString()}.` : ""}</p> : null}
          {entry.kind === "deletion_completed" ? <p className="text-sm text-muted-foreground">The service confirmed source data and catalog entries were removed. Existing query-result files expire separately.</p> : null}
        </li>)}
      </ol> : <p className="text-sm text-muted-foreground">{status ? "No privacy events recorded yet." : "Loading history…"}</p>}</CardContent>
    </Card>
  </main>;
}

const privacyEventLabels = { consent_granted: "Consent granted", consent_expired: "Consent expired", sharing_stopped: "Sharing stopped",
  deletion_requested: "Deletion requested", deletion_accepted: "Deletion accepted", deletion_completed: "Deletion completed" } as const;

export function LocalPrivacyTerms(props: LocalUsageProps) {
  const { data: status, error } = useLocalUsageStatus(props);
  return <main className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
    <header className="space-y-2">
      <Link className="text-sm underline underline-offset-4" to="/settings/privacy">← Back to Privacy</Link>
      <h1 className="text-3xl font-semibold">Local usage Privacy Notice</h1>
      <p className="text-sm text-muted-foreground">Version {status?.privacyNoticeVersion ?? bundledNotice.version}</p>
    </header>
    {error ? <ErrorNotification description={`Current server status is unavailable: ${error.message}`} /> : null}
    <Card><CardContent className="space-y-5 pt-6">
      <section className="space-y-2"><h2 className="text-lg font-semibold">Your choice</h2>
        {status?.privacyNoticeVersion === "installation-retention-180d-v1" && <p>Consent expires at the service’s inactivity cutoff (at most 180 days). Connection creation or testing (including failed attempts), configuration saves (including failures), run starts and successful result fetches count. Opening Local and retrying an upload do not count. The old installation ID is retired. Sharing resumes under a new ID only if you choose Yes again.</p>}
        <p>Local usage sharing is off until you choose Yes or Share usage. One choice covers the allowed signals below across ArkiMux projects in this OS user account. No, Ask later, closing the prompt, and leaving the choice undecided send no usage events and change no Local capability. Ask later records no consent decision and can prompt again after a later Local server start.</p>
        <p>After Yes, Local creates a random registration identity and registers an installation account with ArkiMux's dedicated AWS Cognito pool in the background. Its posting credential stays in the OS credential store, not project files or the browser. The resulting pseudonymous ID connects signals across projects; it is not a MAC address, hardware fingerprint or Managed identity. Choosing No stops collection and clears queued data. Local keeps the credential to request and confirm withdrawal. If the credential store is locked, deletion is retried and shown in Settings.</p>
      </section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">What is shared</h2>
        <p>The recipient is the ArkiMux Telemetry Service hosted on AWS. The Local server sends consent granted, Local started, connection creation/testing, configuration saved, run started/succeeded/failed/cancelled, and result fetched events. A fetch means the API returned a result payload for a successful run; it does not prove human viewing. Browser and CLI clients count equally.</p>
        <p>Events contain version, event and installation IDs{(status?.privacyNoticeVersion === "installation-retention-180d-v1" || status?.privacyNoticeVersion === sandboxArchiveNotice) ? "" : " (older formats also contain a journey ID)"}, coded kind, occurrence and send timestamps, and an opaque operation ID where needed. The service adds receipt time. Reports measure consent to the first successful result fetch, including pauses, not hands-on time. Missing events remain missing.</p>
      </section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">Local diagnostics and GitHub issues</h2>
        <p>ArkiMux does not collect error reports automatically, even with Share usage enabled. Error messages, stack traces, and diagnostic files stay on this computer. Pending error uploads from older versions are discarded.</p>
        <p>To ask for help, open <Link className="underline underline-offset-4" to="/settings/diagnostics">Diagnostics</Link> and choose Report an issue on GitHub. The form includes only the framework version and blank prompts for expected behavior, actual behavior, and reproduction steps. No trace or file is attached automatically. You choose what to copy, paste, or attach and submit the issue yourself on GitHub.</p>
        <p>GitHub issues are public. Original diagnostics can contain private information, including error messages, stack traces, and machine paths. Review downloaded files or edit copied diagnostics in your editor or the GitHub form before sharing. Remove credentials and any information you do not want to disclose. You are responsible for the content you submit.</p>
        <p>Original files are stored under <code>.arkimux/local/diagnostics</code> in this project: at most 20 records for 7 days, with each record limited to 256 KiB. They are captured independently of usage-sharing consent. Changing consent does not upload or delete these files. Deleting a local diagnostic does not delete a GitHub issue. Delete shared data covers the usage telemetry service and does not delete GitHub content.</p>
      </section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">What stays private</h2>
        <p>ArkiMux does not send workflow, provider, effect, or developer-input error content; unfiltered messages or stacks, source text, prompts, results, absolute machine paths, credentials, human identity, or Managed identity. Usage sharing is suppressed during CI, install, and postinstall. AWS necessarily processes network addresses for transport and security; IP is not an analytics field.</p>
      </section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">Storage and deletion</h2>
        <p>Accepting a new notice starts a fresh sharing identity. Local keeps the earlier credential in your OS credential store for deletion only. It does not use it to send usage, and choosing Yes does not withdraw the earlier installation.</p>
        <p>Each project's outbox holds at most 100 events for {status?.localRetentionDays ?? bundledNotice.localRetentionDays} days under the shared OS-user telemetry directory. Retries use stable event IDs. Delivery is not guaranteed. Choosing No stops new uploads and clears pending events; an in-flight request cannot be recalled. Deleting a Cognito account does not delete uploaded data.</p>
        <p>Privacy history is saved locally in this OS user account, including consent choices, known installation IDs and deletion receipts. It is not uploaded. Stopping sharing or deleting shared data keeps this local history so earlier choices and requests remain visible.</p>
        <p>Stopping sharing requests authenticated withdrawal. If an earlier installation still has linked usage, you can request its deletion from Privacy settings. Local retries offline without renewed consent and retains the credential until removal is confirmed. Acceptance is not confirmation of removal. {archiveCopy(status) ?? "No real usage rows are currently approved for archive retention."} The service deletes the installation's source data and catalog entries within seven days. Existing query-result files may still contain that data and are not deleted by this request. They become eligible for automatic expiration {status?.privacy?.queryRetentionDays ?? 7} days after each file is created, rounded up to the next midnight UTC; AWS removal is asynchronous and may take longer. In-flight queries are not cancelled and their result files expire on the same basis. Queue and dead-letter copies retain at most seven days and cannot restore deleted source data. Minimal request and suppression records remain to reject old uploads; these are not analytics. Previously downloaded reports cannot be recalled.</p>
        {status?.privacy ? <p>Configured retention: usage {status.privacyNoticeVersion === sandboxArchiveNotice ? "until withdrawal or five inactive minutes for the designated sandbox" : status.privacyNoticeVersion === "installation-retention-180d-v1" ? "until withdrawal or the service’s inactivity cutoff (up to 180 days without a qualifying action)" : status.privacy.usageRetentionDays === "indefinite" ? "has no automatic expiry" : `${status.privacy.usageRetentionDays} days`}, query results {status.privacy.queryRetentionDays} days, security/service logs {status.privacy.logRetentionDays} days. Deletion: {status.privacy.deletionDescription}</p>
          : <p>The AWS recipient's retention and deletion policy is not configured. No telemetry can be uploaded until an approved service configuration is supplied and you consent to its notice.</p>}
      </section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">Separate permissions</h2>
        <p>This choice is separate from the Apache-2.0 licence, website terms, marketing consent, account creation, payment, and every workflow runtime permission.</p>
      </section>
    </CardContent></Card>
  </main>;
}

interface LocalUsageProps {
  apiBaseUrl: string;
  session: { cacheKey: string; requestInit?: RunApiClientOptions["requestInit"] };
}

function statusQueryKey(props: LocalUsageProps) {
  return ["local-usage-status", props.apiBaseUrl, props.session.cacheKey] as const;
}

export function useLocalUsageStatus(props: LocalUsageProps) {
  return useQuery({ queryKey: statusQueryKey(props), queryFn: () => readStatus(props), retry: false, refetchInterval: 5000 });
}

function deliveryLabel(state: string) {
  return ({ disabled: "disabled", "not-configured": "not configured", "registration-pending": "registration pending",
    connected: "connected", retrying: "waiting to retry", "credential-rejected": "credential rejected, sharing paused",
    "credential-store-unavailable": "OS credential store unavailable", "invalid-event": "invalid event discarded" } as Record<string, string>)[state] ?? "unavailable";
}

function useSaveLocalUsageChoice(props: LocalUsageProps) {
  const queryClient = useQueryClient();
  return async (choice: "yes" | "no" | "ask-later") => {
    const queryKey = statusQueryKey(props);
    await queryClient.cancelQueries({ queryKey });
    const status = await writeChoice(props, choice);
    queryClient.setQueryData<LocalUsageStatus>(queryKey, status);
  };
}

async function readStatus(props: LocalUsageProps): Promise<LocalUsageStatus> {
  return request(props, "GET");
}

async function writeChoice(props: LocalUsageProps, choice: "yes" | "no" | "ask-later"): Promise<LocalUsageStatus> {
  return request(props, "PUT", { choice });
}

async function request(props: LocalUsageProps, method: "GET" | "PUT" | "POST", body?: unknown, suffix = ""): Promise<LocalUsageStatus> {
  const supplied = await props.session.requestInit?.() ?? {};
  const headers = new Headers(supplied.headers);
  headers.set("accept", "application/json");
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${props.apiBaseUrl.replace(/\/$/, "")}/api/v1/local/privacy${suffix}`, {
    ...supplied, method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => undefined) as LocalUsageStatus | { error?: { message?: string } } | undefined;
  if (!response.ok) {
    const failure = value && "error" in value ? value.error?.message : undefined;
    throw new Error(failure ?? `Privacy request failed with status ${response.status}.`);
  }
  return value as LocalUsageStatus;
}
