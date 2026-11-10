# Local privacy notice

Draft for owner review, prepared 5 November 2026. This describes the current
usage-only Local implementation. It does not change the notice version displayed
by an installed Local server or replace an existing sharing choice. The legal
operator, public contact route and effective date must be confirmed before this
becomes a final public notice.

## Data used to run your workflows

Local stores project configuration, Run inputs, outputs, artifacts and state on
your computer. Your workflows, effects and selected provider CLIs can send data
to external services or change external systems. Review the permissions and
policies of those services; disabling ArkiMux usage sharing does not disable
workflow network calls or a provider's own data collection.

Provider API keys entered in Local are stored in plaintext mode-0600 project
files, not an encrypted vault. Native provider CLIs manage their own login data.
Neither is the telemetry posting credential, which uses the OS credential store.
Protect the host and exclude credentials and local state from source control.

## Optional usage sharing

Sharing is off until you choose Yes or Share usage. No, Ask later, closing the
prompt, or leaving it undecided do not authorize usage uploads and do not remove
Local features. Ask later can prompt again after a later Local start.
One choice covers ArkiMux projects in the same OS user account for the current
recipient and notice. A changed recipient/notice requires a matching choice.
CI suppression and `ARKIMUX_DISABLE_TELEMETRY=1` prevent usage sending; installing
packages is not consent to sharing.

With consent and a configured recipient, Local registers a random installation
identity with the dedicated AWS Cognito service in the background. Its posting
credential stays in the OS credential store, not in the browser. The resulting
ID is pseudonymous, not anonymous: it connects usage across your projects for
that OS user account. It is not based on a MAC address or hardware fingerprint
and is not joined to a Managed user account.

The Local API/runtime sends these coded event groups to the ArkiMux Telemetry
Service on AWS: consent granted, Local started, connection created or tested,
configuration saved, Run started/completed/failed/cancelled, and successful
result-payload fetch. A fetch is not evidence that a person viewed the result.
The reviewed service configuration uses AWS region `eu-west-1`; this draft does
not claim a production deployment or a wider data-residency guarantee.
Event occurrence times can measure elapsed journey time across restarts and
pauses, not hands-on work time.

The allowed fields are schema version, random event/installation/consent-journey
IDs, event kind, occurrence and send timestamps, ArkiMux version and, where
needed, an opaque operation ID. The service adds receipt time. Usage events do
not contain workflow source, inputs, prompts, outputs, Run IDs, absolute paths,
provider error content, credentials, human identity or Managed identity.
AWS necessarily processes network addresses for transport and security; an IP
address is not a field in the analytics event schema.

## Delivery and retention

| Data | Current handling |
| --- | --- |
| Pending usage | Shared OS-user storage, bounded to 100 events per project and seven days; temporary failures retry with stable event IDs |
| Uploaded usage | No automatic expiry under the current approved service configuration; used for product/journey comparison until deletion is requested |
| Query-result files | Become eligible for expiry seven days after each file's creation, rounded to midnight UTC; AWS removal is asynchronous and can take longer |
| Service/security logs | Current approved configuration uses seven-day retention |
| Delivery and failed-delivery queues | Seven-day retention |
| Privacy history | Retained locally, including known consent decisions, installation IDs and deletion receipts; not uploaded |
| Original error diagnostics | Local only: at most 20 records, each at most 256 KiB, pruned after seven days when Local records or accesses diagnostics |

The installed Privacy page shows its recipient configuration and delivery state.
An unconfigured recipient cannot receive telemetry. Delivery can fail or events
can expire or be dropped at the bounds; consent is not a delivery guarantee.
Retention values for a different approved recipient must be disclosed in its
configured notice rather than inferred from this draft.

## Stop sharing and delete uploaded usage

Do not share stops new uploads, clears queued usage and retires the local posting
identity/credential. It does not request deletion of usage already uploaded, and
cannot recall an in-flight request.

Delete shared data is a separate authenticated action in Settings > Privacy.
Use it before choosing No: the installation credential is needed to prove which
data to delete. It stops sharing and clears pending usage immediately. An offline
request remains pending; acceptance is not proof of completed deletion. After
acceptance, the service removes the installation's source data and catalog
entries within seven days. Minimal deletion/suppression records remain to reject
old uploads; they are not analytics. Local removes the posting credential after
the request is accepted. Privacy history remains on this computer.

Existing query-result files are not purged by that action and expire on the
file-age basis above. In-flight queries are not cancelled; downloaded reports
cannot be recalled. Deletion does not remove your projects, Run files, local
diagnostics, native provider accounts, or material you submitted to GitHub.

## Diagnostics and deliberate sharing

No error report, message, stack trace or diagnostic file is uploaded automatically,
even with usage sharing enabled. Local captures bounded diagnostics independently
of that choice. They may contain private messages, paths or other sensitive
details; do not assume that a diagnostic is safe to publish.

Diagnostics lets you inspect, download or explicitly copy the displayed record.
Copying is not submission. Report an issue opens a GitHub form with the framework
version and blank prompts; no trace, diagnostic ID or file is attached. Review
and redact any material before you submit it. GitHub issues are public and use
GitHub's own policies. Deleting a local record or requesting telemetry deletion
does not delete a GitHub issue.

## Separate permissions

Local usage consent is separate from the Apache licence, workflow permissions,
provider accounts, payment and marketing consent. Detailed observed-session
study records remain local and require an explicitly observed session; ordinary
usage events are not proof of a complete measured session.

This notice does not authorize website analytics or interest-form contact.
Those surfaces need their own declared fields, recipients, purpose and retention
before real submissions. A private preview must use isolated synthetic test
records, not collect real leads under this Local choice.
