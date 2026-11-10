# Local responsibilities

Draft for owner review, prepared 5 November 2026. Local runs on the developer's
computer. It is not an ArkiMux-operated production hosting service.

| Area | ArkiMux Local provides | Developer or operator responsibility |
| --- | --- | --- |
| Workflow execution | The released workflow contracts, Local execution and typed-result APIs | Choose suitable workflows, validate business behavior and authorize effects |
| Models and external services | The adapters and configurations actually tested for that release | Obtain provider access, follow provider terms, pay provider charges and approve model/tool use |
| Credentials | Separate Local credential handling and native CLI integration | Protect the host, permissions and provider accounts; rotate exposed keys |
| Inputs and outputs | Declared schema validation | Obtain data rights, assess privacy, review output correctness and decide whether an action is appropriate |
| Effects | Declared effect execution and persisted operation state | Review external writes, retries, permissions, idempotency and uncertain outcomes; effects can incur cost or change real systems |
| Run state | Local persistence and supported recovery behavior | Back up required data, test restoration and plan for disk loss or corruption |
| Availability and security | Local development controls and documented limits | Restrict access to the machine, patch dependencies, monitor workloads and handle incidents |
| Updates and compatibility | Versioned code and documented tested behavior | Pin versions, test upgrades and maintain custom adapters |
| Support | The support policy adopted for the release | Keep reproducible examples and redact evidence before sharing |
| Usage sharing | Optional bounded usage collection and a separate deletion action | Choose whether to share; protect the retained installation credential if deletion is needed |

Provider API keys entered in Local are currently stored as plaintext files with
owner-only mode-0600 permissions under `.arkimux/local/credentials/values`. This
is not an encrypted production vault. Native CLIs manage their own login storage.
Telemetry posting credentials use the OS credential store; that is a different
credential path. See the [privacy notice](PRIVACY-NOTICE.md).

## Limits of the demonstrated behavior

A valid typed result is not proof that the result is factually correct. One
committed ArkiMux step completion is not a guarantee of exactly-once delivery of
an external side effect. Normal workflow runs can call real providers and
effects. The isolated mock debugger is a separate, explicitly authorized mode,
not a safety guarantee for ordinary execution.

Local currently demonstrates one built-in workflow engine and whole-run Local
execution, with sequential graph/control execution. It does not promise parallel
branches, public engine/host/storage replacement plugins, cross-engine parity,
automatic framework translation, or migration of in-flight executions. A wait
for input does not mean zero storage cost or a promise that an external provider
will behave unchanged indefinitely.

Managed Cloud, Publisher commerce and maintained customer-cloud deployment are
not offered by this Local pack. There is no implied hosting, maintenance,
compatibility, certification, warranty, support response time or SLA for a future
service. Any such service needs separately agreed terms.
