# Local privacy notice

**Pyvue LLC operates ArkiMux** and decides why and how optional Local usage
data is used. For privacy questions, requests or complaints, email
<privacy@arkimux.ai>. You do not need an ArkiMux account to contact us.

This is a preview notice, not a production notice in effect. In Local, open
**Settings → Privacy** to see the recipient and notice version for your installation.

## Data used to run your workflows

Local stores project configuration, Run inputs, outputs, artifacts and state on
your computer. Your workflows, effects and selected provider CLIs can send data
to external services or change external systems. Review the permissions and
policies of those services; disabling ArkiMux usage sharing does not disable
workflow network calls or a provider's own data collection.

Local stores provider API keys in plaintext project files, not an encrypted
vault. On POSIX systems Local requests mode `0600` (owner read/write) for new
key files; migration preserves an existing file's permissions, which may be
broader. On Windows, check the file's access control list. Native provider CLIs
manage their own login data.
Neither is the telemetry posting credential, which uses the OS credential store.
Protect the host and exclude credentials and local state from source control.

## Optional usage sharing

We ask for your consent to measure where setup fails, whether the same
installation later succeeds, and how long it takes to fetch a first result.
That helps us tell whether changes to Local improve the experience. We
link steps by installation because counting failures and successes separately
would not tell us whether the installation that failed recovered.

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
AWS hosts the telemetry service for Pyvue LLC. The preview service stores
telemetry in Ireland (AWS region `eu-west-1`). This is the storage location,
not a guarantee that all support access or other processing takes place there.
Event occurrence times can measure elapsed journey time across restarts and
pauses, not hands-on work time.

The allowed fields are schema version, random event and installation IDs,
event kind, occurrence and send timestamps, ArkiMux version and, where needed,
an opaque operation ID. The older event format also includes a consent-journey
ID; the installation-retention and dev-sandbox formats do not. The service adds
receipt time. Usage events do not contain workflow source, inputs, prompts,
outputs, Run IDs, absolute paths, provider error content, credentials, human
identity or Managed identity.
AWS necessarily processes network addresses for transport and security; an IP
address is not a field in the analytics event schema.

## Delivery and retention

Match the version in **Settings → Privacy** to the rule below. The service keeps
usage events linked to your installation while sharing is active. When sharing
ends, it deletes the original events. What remains depends on the notice you accepted.

| Notice version | When sharing ends | What remains of your usage events |
| --- | --- | --- |
| `installation-retention-180d-v1` | When you stop sharing or reach the service’s inactivity cutoff (at most 180 consecutive days) | No archive. This is an inactivity limit, not a limit on the age of individual events while sharing is active. |
| `dev-sandbox-archive-v1` (designated sandbox installations only) | When you stop sharing or after five inactive minutes | Only with a fresh Yes to this notice: month, ordered steps, operation pairings and relative times under a random installation key. No original IDs or exact timestamps. |
| `usage-with-withdrawal-archive-v1-disclosed` (earlier archive notice) | When you stop sharing; no inactivity cutoff | Only with a fresh Yes to this notice: consent month, ordered steps, journey-local operation numbers, relative times and a timing-validity flag under a random journey key. No original IDs, exact timestamps or build version. |
| `usage-only-withdrawal-v1` | When you stop sharing; no inactivity cutoff | No archive. |

For the two notices with an inactivity cutoff, creating or testing a connection,
saving a configuration (including failed attempts), starting a Run, or fetching
a result successfully counts as activity. Failed attempts send a code, not error
text. Opening Local, retrying an upload, or refreshing credentials does not count.
After expiry, sharing requires a fresh Yes and a new, unlinked installation ID.

Both archives keep the reduced history indefinitely. Once the link is removed,
we cannot look up or delete an archived sequence by installation ID. Removing
identifiers does not by itself make a distinctive sequence anonymous. Consent
to one notice does not opt you into another.

### Other records

| Data | Current handling |
| --- | --- |
| Pending usage | Shared OS-user storage, bounded to 100 events per project and seven days; temporary failures retry with stable event IDs |
| Query-result files | Become eligible for expiry seven days after each file's creation, rounded to midnight UTC; AWS removal is asynchronous and can take longer |
| Service/security logs | Seven days in the preview service |
| Delivery and failed-delivery queues | Seven-day retention |
| Privacy history | Retained locally, including known consent decisions, installation IDs and deletion receipts; not uploaded |
| Original error diagnostics | Local only: at most 20 records, each at most 256 KiB, pruned after seven days when Local records or accesses diagnostics |

The installed Privacy page shows its recipient configuration and delivery state.
An unconfigured recipient cannot receive telemetry. Delivery can fail or events
can expire or be dropped at the bounds; consent is not a delivery guarantee.
For a different recipient, check the retention shown in Settings → Privacy.

## Stop sharing and delete uploaded usage

Before sharing, choose **Share usage** or **Do not share**. When already sharing,
**Stop sharing… → Confirm stop sharing** stops collection and upload immediately,
clears unsent usage and requests authenticated withdrawal. Earlier clients label
this action **Delete shared data**. After stopping, the Privacy page shows a
separate deletion action only for earlier linked data not yet requested for
withdrawal. An in-flight upload cannot be recalled.
Local retries offline requests without renewed
consent. The service removes the installation's source data and catalog entries
within seven days. An accepted request is not confirmation of removal. Local
keeps the credential to follow up until the service confirms completion.
Accepting a new notice starts a fresh sharing identity. Local keeps the old
credential in the OS credential store solely to withdraw the old installation.
It does not use that credential to upload usage or send a withdrawal merely
because you chose Yes. Requests go only to the original recipient.
Minimal deletion records remain to reject old uploads; privacy history stays
on this computer. Older versions that already discarded a credential cannot
recover it from the installation ID alone.

Existing query-result files are not purged by that action and expire on the
file-age basis above. In-flight queries are not cancelled; downloaded reports
cannot be recalled. Deletion does not remove your projects, Run files, local
diagnostics, native provider accounts, or material you submitted to GitHub.

## Privacy requests and complaints

Email <privacy@arkimux.ai> and tell us what you want to know or change. This is
a private contact, not a public GitHub issue. Google Workspace handles the email
for Pyvue LLC; your sender address and the message you choose to send are
visible to us so we can respond. Please do not send passwords, posting
credentials, workflow content or diagnostic files.

We keep privacy correspondence while we handle your request and any follow-up.
Once it is no longer needed, we delete it, unless we need to keep it to meet a
legal obligation or resolve a dispute.

Depending on the law that applies to you, you may ask to access, correct,
delete or receive a portable copy of your data, restrict its use or object to
processing. You can withdraw consent in Settings → Privacy without giving a
reason. This stops future sharing; it does not change whether earlier
processing was lawful. If your concern is unresolved, or you prefer not to
contact us first, you may complain directly to the data protection authority
responsible for your location.

We do not use your email address as the installation ID. If you need help with
a specific withdrawal, tell us which notice you saw and whether Local showed a
request receipt. An installation ID alone is not proof that you control it.
Where a sandbox archive has already removed the link to your installation, we
cannot use that ID to find or erase its archived rows.

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
provider accounts and payment. If you take part in an observed study session,
its detailed records stay on your computer. Sharing Local usage does not give
permission to track your website visits or contact you through an interest form
or for marketing.
