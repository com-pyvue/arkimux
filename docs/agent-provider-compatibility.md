# Agent Provider Compatibility and Conformance

Status: historical compatibility contract snapshot; not a current support or release claim
Last reviewed: 2026-09-04

> **Local V2 publication decision.** The compatibility matrix, automated
> conformance suite, and supported Codex, Claude, and Pi adapters will be public
> Apache-2.0 artifacts in `com-pyvue/arkimux`. They become released product
> artifacts only after the Local V2 public-distribution gate passes. Until then,
> this document describes a working contract, not a public release claim.

## Summary

ArkiMux already gives Codex CLI, Pi CLI, and Claude Code CLI one common
execution boundary. Kimi Code CLI also has adapter code, but it is experimental
and is not part of a known customer journey or the public portability promise.

The public-source Agent Provider Adapters library boundary is useful but narrow. It accepts one text
prompt, runs one CLI process, waits for completion, and returns final text plus
common metrics and artifact paths. It does not yet provide caller-facing
streaming, external cancellation, automatic retries, provider idempotency,
provider-native structured output, or portable custom tools.

The machine-readable source for the tables in this document is
`test/provider-conformance/provider-capabilities.ts`. Runtime code remains the
source for what the product actually does. This document and its manifest are
the source for compatibility claims and conformance work.

## Terms

- **Execution provider** is the CLI adapter ArkiMux starts, such as Codex CLI or
  Pi CLI.
- **Model provider** is the model protocol used by that CLI, such as OpenAI or
  Anthropic.
- **Authentication provider** is the selected source of a native session or API
  key.
- **Execution combination** is one execution provider, model provider, and
  authentication kind tested together.
- **Host** owns one complete workflow attempt. Local macOS, managed
  `lambda-bounded@1`, and managed `fargate-workspace@1` are different hosts and
  need separate evidence for every applicable combination. A host does not run
  one separate compute job per workflow step.

These parts must stay separate. For example, Pi CLI can use an OpenAI model or
an Anthropic model. Proving Pi with OpenAI does not prove Pi with Anthropic.

## Current product boundary

The required advertised Local V2 release set contains exactly four
native-session Connections:

- Codex Native Session;
- Pi Codex Session;
- Pi Claude Session; and
- Claude Native Session.

The Pi Claude Connection is still a candidate gap, not a completed product
capability. Existing local API-key Connections are optional and do not expand
the advertised Local V2 portability claim or its four required rows. If an
optional type is shown, it still needs exact release evidence. Its first
required journey proof is Managed V1 or Managed V2.

Kimi Code CLI and Pi with Kimi are experimental groundwork only. They must not
appear in public compatibility claims, known journey gates, or release blockers.

Local V2 has not passed its journey gates yet. `Supported` in this document
describes the current wrapper implementation only. It is not a Local V2,
managed-host, product-release, or public-marketing claim.

## Common wrapper contract

The public-source Agent Provider Adapters library defines the adapter contract and conformance kit.
Every execution adapter exposes `preflight()` and `run()`.

The current run request contains:

- working directory;
- one text prompt;
- timeout in milliseconds;
- authentication-provider ID;
- provider-native parameters;
- optional artifact prefix, label, and attempt number.

The current result contains:

- one final text output;
- completion, failure, or timeout status;
- elapsed time;
- common artifact paths;
- tool-use counters where available;
- token usage and provider-estimated cost where available.

Each adapter owns its provider-specific command flags, event parsing, and
authentication injection. Portable workflow code declares a semantic Agent
Slot through the Workflow SDK. The durable workflow engine resolves that slot
and calls the common Agent Provider Adapters boundary, so workflow code does not
depend on a specific CLI's output format. The adapter returns
`AgentExecutionResult`; the engine commits the containing step and returns its
`CompletedStepV1`.

The Agent Provider Adapters does not own workflow step checkpoints, workflow replay,
or external effect safety. Managed execution keeps the specialized
`BrokerOperation` and `AgentInvocationRef` contract for an agent call. The
containing `StepCheckpoint` refers to that operation. The complete relationship
is defined in
[`durable-workflow-engine.md`](./durable-workflow-engine.md).

## Capability status rules

| Status | Meaning | Required record |
| --- | --- | --- |
| **Supported** | The current wrapper implements the full capability described by the row. | At least one evidence ID. Live or managed evidence can still be required by a journey gate. |
| **Partial** | A useful part works, but a named limitation remains. | At least one evidence ID and at least one tracking ID. |
| **Unsupported** | The wrapper does not offer this capability. | At least one tracking ID. The related test is skipped, not passed. |
| **Experimental** | Code or evidence exists, but it is outside the released product promise. | Evidence or a tracking ID. It cannot satisfy a released journey gate. |
| **N/A** | The capability does not apply to this adapter by design. | No evidence or tracking ID. |

`Supported` is always wrapper-level status. Product status and journey release
are recorded separately. A wrapper-level pass cannot replace required live or
managed evidence.

Feature status and test outcome are different:

- feature status is one of the five values above;
- a test outcome is pass, fail, or skip;
- an unsupported feature must be a named skip with its tracking ID;
- a missing credential may skip an optional developer run, but a release gate
  must supply its required credentials and cannot silently skip.

## Capability matrix

<!-- BEGIN GENERATED:PROVIDER_CAPABILITY_MATRIX -->
| Capability | Codex CLI | Pi CLI | Claude Code CLI | Kimi Code CLI |
| --- | --- | --- | --- | --- |
| **Input / Single text prompt**<br>`single-text-prompt` | **Supported** — Delivered through stdin. Evidence: `APC-E001`, `APC-E018`. | **Supported** — Delivered through stdin. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Delivered through stdin. Evidence: `APC-E007`, `APC-E018`. | **Experimental** — Delivered through an isolated prompt file. Evidence: `APC-E009`, `APC-E018`. |
| **Input / Working directory**<br>`working-directory` | **Supported** — Child process uses request.cwd. Evidence: `APC-E001`. | **Supported** — Child process uses request.cwd. Evidence: `APC-E004`. | **Supported** — Child process uses request.cwd. Evidence: `APC-E007`. | **Experimental** — Child process uses request.cwd. Evidence: `APC-E009`. |
| **Input / Message history**<br>`message-history` | **Unsupported** — No message-history or role-separated input. Tracking: `APC-GAP-013`. | **Unsupported** — No message-history or role-separated input. Tracking: `APC-GAP-013`. | **Unsupported** — No message-history or role-separated input. Tracking: `APC-GAP-013`. | **Unsupported** — No message-history or role-separated input. Tracking: `APC-GAP-013`. |
| **Input / Multimodal input**<br>`multimodal-input` | **Unsupported** — No image, audio, or file-part input. Tracking: `APC-GAP-013`. | **Unsupported** — No image, audio, or file-part input. Tracking: `APC-GAP-013`. | **Unsupported** — No image, audio, or file-part input. Tracking: `APC-GAP-013`. | **Unsupported** — No image, audio, or file-part input. Tracking: `APC-GAP-013`. |
| **Configuration / Model selection**<br>`model-selection` | **Supported** — Forwards the model as Codex configuration. Evidence: `APC-E001`, `APC-E016`, `APC-E018`. | **Supported** — Requires provider and model values. Evidence: `APC-E004`, `APC-E016`, `APC-E018`. | **Supported** — Requires a Claude model or alias. Evidence: `APC-E007`, `APC-E016`, `APC-E018`. | **Experimental** — Requires a Kimi model value. Evidence: `APC-E009`, `APC-E016`, `APC-E018`. |
| **Configuration / Reasoning or thinking control**<br>`reasoning-control` | **Supported** — Uses model_reasoning_effort. Evidence: `APC-E002`, `APC-E016`, `APC-E018`. | **Supported** — Uses thinking, including off. Evidence: `APC-E004`, `APC-E016`, `APC-E018`. | **Supported** — Uses effort. Evidence: `APC-E007`, `APC-E016`, `APC-E018`. | **Experimental** — Uses thinking-effort. Evidence: `APC-E009`, `APC-E016`, `APC-E018`. |
| **Configuration / Model-provider routing**<br>`model-provider-routing` | **Partial** — Accepts arbitrary Codex model_provider configuration, but candidate proof is OpenAI-focused. Evidence: `APC-E001`. Tracking: `APC-GAP-001`. | **Supported** — Requires an explicit provider and installed text-model catalog entry. Evidence: `APC-E004`. | **N/A** — The adapter is fixed to the native Anthropic protocol. | **Experimental** — Supports kimi, anthropic, or openai provider types. Evidence: `APC-E009`. |
| **Configuration / Provider-native parameters**<br>`provider-native-parameters` | **Supported** — Forwards scalar and scalar-array values as sorted Codex --config entries. Evidence: `APC-E001`, `APC-E016`, `APC-E018`. | **Supported** — Strictly accepts provider, model, and thinking. Evidence: `APC-E004`, `APC-E016`, `APC-E018`. | **Supported** — Accepts model, effort, permission mode, and maximum USD budget. Evidence: `APC-E007`, `APC-E016`, `APC-E018`. | **Experimental** — Accepts provider type, base URL, context size, capabilities, and thinking effort. Evidence: `APC-E009`, `APC-E016`, `APC-E018`. |
| **Readiness / Executable and version preflight**<br>`executable-preflight` | **Supported** — Resolves explicit, repository-local, then PATH executable. Evidence: `APC-E015`, `APC-E018`. | **Supported** — Uses the shared executable resolver and version probe. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Also checks the configured required version. Evidence: `APC-E015`, `APC-E018`. | **Experimental** — Also checks the configured required version. Evidence: `APC-E009`, `APC-E018`. |
| **Authentication / Runtime-native session**<br>`runtime-native-authentication` | **Supported** — Uses Codex login status and isolated child home links. Evidence: `APC-E003`. | **Partial** — The generic runner can use auth.json, but Pi Anthropic native Connection setup and live proof are missing. Evidence: `APC-E020`. Tracking: `APC-GAP-001`, `APC-GAP-018`. | **Supported** — Uses claude auth status and provider-reported identity when available. Evidence: `APC-E008`. | **Experimental** — Uses the configured Kimi native-session home. Evidence: `APC-E010`. Tracking: `APC-GAP-016`. |
| **Authentication / API-key authentication**<br>`api-key-authentication` | **Supported** — Supports environment and stored OpenAI keys. Evidence: `APC-E001`, `APC-E011`, `APC-E013`. | **Supported** — Supports environment and stored keys for configured model providers. Evidence: `APC-E004`, `APC-E011`, `APC-E013`. | **Supported** — Supports environment and stored Anthropic keys. Evidence: `APC-E007`, `APC-E011`, `APC-E013`. | **Experimental** — Supports environment and stored Kimi model keys. Evidence: `APC-E009`, `APC-E011`, `APC-E013`. |
| **Authentication / Credential command**<br>`command-authentication` | **Partial** — Supported by core configuration, not current portal creation. Evidence: `APC-E012`. Tracking: `APC-GAP-015`. | **Partial** — Supported by core configuration, not current portal creation. Evidence: `APC-E012`. Tracking: `APC-GAP-015`. | **Partial** — Supported by core configuration, not current portal creation. Evidence: `APC-E012`. Tracking: `APC-GAP-015`. | **Experimental** — Implemented by the shared auth registry but outside the product promise. Evidence: `APC-E012`. Tracking: `APC-GAP-015`. |
| **Authentication / Active connection probe**<br>`active-connection-probe` | **Supported** — Uses a low-effort tool-free probe prompt. Evidence: `APC-E014`. | **Supported** — Can try later stable catalog models after a model-access failure. Evidence: `APC-E014`. | **Supported** — Uses Haiku, low effort, and plan permission mode. Evidence: `APC-E014`. | **Experimental** — Uses the experimental Kimi runtime and model. Evidence: `APC-E014`. |
| **Authentication / Provider proxy operation grant**<br>`provider-proxy-authentication` | **Unsupported** — No provider proxy authentication or protocol path. Tracking: `APC-GAP-010`. | **Unsupported** — No provider proxy authentication or protocol path. Tracking: `APC-GAP-010`. | **Unsupported** — No provider proxy authentication or protocol path. Tracking: `APC-GAP-010`. | **Unsupported** — Kimi is not in the planned first proxy boundary. Tracking: `APC-GAP-010`. |
| **Execution / Allowlisted child environment**<br>`environment-isolation` | **Supported** — Unrelated host variables are excluded. Evidence: `APC-E001`, `APC-E018`. | **Supported** — Unrelated host variables are excluded. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Uses the shared allowlisted environment path. Evidence: `APC-E007`, `APC-E011`, `APC-E018`. | **Experimental** — Uses the shared allowlisted environment path. Evidence: `APC-E009`, `APC-E011`, `APC-E018`. |
| **Execution / Ephemeral invocation session**<br>`ephemeral-session` | **Supported** — Uses --ephemeral and removes its temporary child home. Evidence: `APC-E001`. | **Supported** — Uses --no-session and removes its temporary agent directory. Evidence: `APC-E004`. | **Supported** — Uses --no-session-persistence. Evidence: `APC-E007`. | **Experimental** — One-shot execution exists, but no no-session flag is enforced. Evidence: `APC-E009`, `APC-E010`. Tracking: `APC-GAP-016`. |
| **Execution / Timeout termination**<br>`timeout-termination` | **Supported** — Sends SIGTERM, then SIGKILL after two seconds. Evidence: `APC-E019`. | **Supported** — Sends SIGTERM, then SIGKILL after two seconds. Evidence: `APC-E019`. | **Supported** — Uses the shared streaming-process timeout. Evidence: `APC-E019`. | **Experimental** — Uses the shared streaming-process timeout. Evidence: `APC-E019`. |
| **Execution / External cancellation**<br>`external-cancellation` | **Unsupported** — No caller cancellation signal or method. Tracking: `APC-GAP-003`. | **Unsupported** — No caller cancellation signal or method. Tracking: `APC-GAP-003`. | **Unsupported** — No caller cancellation signal or method. Tracking: `APC-GAP-003`. | **Unsupported** — No caller cancellation signal or method. Tracking: `APC-GAP-003`. |
| **Execution / Automatic retry**<br>`automatic-retry` | **Unsupported** — No automatic execution retry. Tracking: `APC-GAP-004`. | **Unsupported** — No automatic execution retry. Tracking: `APC-GAP-004`. | **Unsupported** — No automatic execution retry. Tracking: `APC-GAP-004`. | **Unsupported** — No automatic execution retry. Tracking: `APC-GAP-004`. |
| **Execution / Provider request idempotency**<br>`provider-idempotency` | **Unsupported** — No provider request idempotency key. Tracking: `APC-GAP-004`. | **Unsupported** — No provider request idempotency key. Tracking: `APC-GAP-004`. | **Unsupported** — No provider request idempotency key. Tracking: `APC-GAP-004`. | **Unsupported** — No provider request idempotency key. Tracking: `APC-GAP-004`. |
| **Execution / Host-controlled scratch**<br>`host-controlled-scratch` | **Unsupported** — Runner chooses temporary paths instead of receiving host scratch. Tracking: `APC-GAP-009`. | **Unsupported** — Runner chooses temporary paths instead of receiving host scratch. Tracking: `APC-GAP-009`. | **Unsupported** — Runner chooses temporary paths instead of receiving host scratch. Tracking: `APC-GAP-009`. | **Unsupported** — Runner chooses temporary paths instead of receiving host scratch. Tracking: `APC-GAP-009`. |
| **Output / Provider-neutral final text**<br>`final-text-result` | **Supported** — Reads Codex --output-last-message, with stdout fallback. Evidence: `APC-E001`, `APC-E018`. | **Supported** — Requires exactly one successful final assistant message. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Projects the result event into the last-message artifact. Evidence: `APC-E007`, `APC-E018`. | **Experimental** — Projects the final non-tool assistant message. Evidence: `APC-E009`, `APC-E018`. |
| **Output / Native event-stream artifact**<br>`native-event-artifact` | **Supported** — Captures Codex JSONL stdout. Evidence: `APC-E001`, `APC-E018`. | **Supported** — Captures Pi JSONL stdout. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Captures Claude streaming JSON stdout. Evidence: `APC-E007`, `APC-E018`. | **Experimental** — Captures Kimi streaming JSON stdout. Evidence: `APC-E009`, `APC-E018`. |
| **Output / Caller-facing response streaming**<br>`caller-response-streaming` | **Unsupported** — Only artifact capture is live; callers wait for completion. Tracking: `APC-GAP-002`. | **Unsupported** — Only artifact capture is live; callers wait for completion. Tracking: `APC-GAP-002`. | **Unsupported** — Only artifact capture is live; callers wait for completion. Tracking: `APC-GAP-002`. | **Unsupported** — Only artifact capture is live; callers wait for completion. Tracking: `APC-GAP-002`. |
| **Output / Provider-native structured output**<br>`provider-native-structured-output` | **Unsupported** — No provider-native JSON Schema response contract. Tracking: `APC-GAP-005`. | **Unsupported** — No provider-native JSON Schema response contract. Tracking: `APC-GAP-005`. | **Unsupported** — No provider-native JSON Schema response contract. Tracking: `APC-GAP-005`. | **Unsupported** — No provider-native JSON Schema response contract. Tracking: `APC-GAP-005`. |
| **Output / Normalized lifecycle events**<br>`normalized-lifecycle-events` | **Partial** — Execution events exist; declared preflight event has no producer. Evidence: `APC-E017`. Tracking: `APC-GAP-014`. | **Partial** — Execution events exist; declared preflight event has no producer. Evidence: `APC-E017`. Tracking: `APC-GAP-014`. | **Partial** — Execution events exist; declared preflight event has no producer. Evidence: `APC-E017`. Tracking: `APC-GAP-014`. | **Experimental** — Experimental execution uses the shared lifecycle event contract. Evidence: `APC-E017`. Tracking: `APC-GAP-014`. |
| **Tools / Runner-native tools**<br>`native-tools` | **Partial** — Native command execution remains available, but apps and plugins are disabled and tools are not portable. Evidence: `APC-E002`. Tracking: `APC-GAP-006`, `APC-GAP-017`. | **N/A** — All Pi built-in tools are deliberately disabled. | **Partial** — Native tool use is controlled only through permission mode and is not portable. Evidence: `APC-E007`. Tracking: `APC-GAP-006`, `APC-GAP-007`. | **Experimental** — Native tool calls are observed but remain outside the public promise. Evidence: `APC-E009`. Tracking: `APC-GAP-006`, `APC-GAP-007`. |
| **Tools / Guarded read-only repository tools**<br>`guarded-repository-tools` | **N/A** — Codex does not use the Pi extension contract. | **Supported** — Optional runner-owned extension exposes four guarded tools. Evidence: `APC-E005`, `APC-E006`. | **N/A** — Claude does not use the Pi extension contract. | **N/A** — Kimi does not use the Pi extension contract. |
| **Tools / Portable custom tools**<br>`portable-custom-tools` | **Unsupported** — No shared tool declaration and result contract. Tracking: `APC-GAP-006`. | **Unsupported** — No shared tool declaration and result contract. Tracking: `APC-GAP-006`. | **Unsupported** — No shared tool declaration and result contract. Tracking: `APC-GAP-006`. | **Unsupported** — No shared tool declaration and result contract. Tracking: `APC-GAP-006`. |
| **Metrics / Basic execution metrics**<br>`basic-execution-metrics` | **Supported** — Produces the shared metric envelope. Evidence: `APC-E001`, `APC-E017`, `APC-E018`, `APC-E019`. | **Supported** — Produces the shared metric envelope. Evidence: `APC-E004`, `APC-E017`, `APC-E018`, `APC-E019`. | **Partial** — Produces the envelope, but native-tool-call currently fails shared validation. Evidence: `APC-E007`, `APC-E017`, `APC-E018`, `APC-E019`. Tracking: `APC-GAP-007`. | **Experimental** — Produces the envelope, but native-tool-call currently fails shared validation. Evidence: `APC-E009`, `APC-E017`, `APC-E018`, `APC-E019`. Tracking: `APC-GAP-007`. |
| **Metrics / Input, cached, and output tokens**<br>`token-usage` | **Supported** — Projects input, cached input, and output tokens. Evidence: `APC-E002`, `APC-E018`. | **Supported** — Aggregates input, cache read, and output across assistant messages. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Projects input, cache-read input, and output tokens. Evidence: `APC-E007`, `APC-E018`. | **Experimental** — Projects available input, cached input, and output tokens. Evidence: `APC-E009`, `APC-E018`. |
| **Metrics / Reasoning-token usage**<br>`reasoning-token-usage` | **Supported** — Reads reasoning_output_tokens. Evidence: `APC-E002`. | **Supported** — Aggregates Pi reasoning usage. Evidence: `APC-E004`. | **Unsupported** — Current Claude parser does not project reasoning tokens. Tracking: `APC-GAP-017`. | **Unsupported** — Current Kimi parser does not project reasoning tokens. Tracking: `APC-GAP-017`. |
| **Metrics / Provider-estimated cost**<br>`estimated-cost` | **Unsupported** — Current Codex event projection has no cost field. Tracking: `APC-GAP-017`. | **Supported** — Aggregates native usage cost totals. Evidence: `APC-E004`. | **Supported** — Projects total_cost_usd. Evidence: `APC-E007`. | **Unsupported** — Current Kimi parser has no cost projection. Tracking: `APC-GAP-017`. |
| **Metrics / Tool-call metrics**<br>`tool-call-metrics` | **Partial** — Counts command_execution items and infers search or read operations from command text. Evidence: `APC-E002`. Tracking: `APC-GAP-017`. | **Supported** — Uses exact guarded repository audit metrics when the extension is installed. Evidence: `APC-E005`, `APC-E006`. | **Partial** — Counts native tool_use blocks, but shared validation rejects its unit. Evidence: `APC-E007`. Tracking: `APC-GAP-007`, `APC-GAP-017`. | **Experimental** — Counts native tool_calls, but shared validation rejects its unit. Evidence: `APC-E009`. Tracking: `APC-GAP-007`, `APC-GAP-017`. |
| **Metrics / Detailed provider diagnostics**<br>`detailed-provider-metrics` | **Unsupported** — Not present in the common metric contract. Tracking: `APC-GAP-017`. | **Unsupported** — Not present in the common metric contract. Tracking: `APC-GAP-017`. | **Unsupported** — Not present in the common metric contract. Tracking: `APC-GAP-017`. | **Unsupported** — Not present in the common metric contract. Tracking: `APC-GAP-017`. |
| **Artifacts / Standard local artifacts**<br>`standard-artifacts` | **Supported** — Produces all four standard local files. Evidence: `APC-E001`, `APC-E018`, `APC-E019`. | **Supported** — Produces all four standard local files. Evidence: `APC-E004`, `APC-E018`, `APC-E019`. | **Supported** — Produces all four standard local files. Evidence: `APC-E007`, `APC-E018`, `APC-E019`. | **Experimental** — Produces all four standard local files. Evidence: `APC-E009`, `APC-E018`, `APC-E019`. |
| **Artifacts / Repository-tool audit artifact**<br>`repository-tool-audit` | **N/A** — No runner-owned guarded repository tool adapter. | **Supported** — Produced when the guarded repository extension is installed. Evidence: `APC-E005`, `APC-E006`. | **N/A** — No runner-owned guarded repository tool adapter. | **N/A** — No runner-owned guarded repository tool adapter. |
| **Artifacts / Retained-output secret redaction**<br>`retained-output-redaction` | **Unsupported** — Retained native output has no secret-redaction guarantee. Tracking: `APC-GAP-012`. | **Unsupported** — Retained native output has no secret-redaction guarantee. Tracking: `APC-GAP-012`. | **Unsupported** — Retained native output has no secret-redaction guarantee. Tracking: `APC-GAP-012`. | **Unsupported** — Retained native output has no secret-redaction guarantee. Tracking: `APC-GAP-012`. |
| **Errors / Typed readiness status**<br>`readiness-status` | **Supported** — Reports native login method and actionable remediation. Evidence: `APC-E003`, `APC-E014`. | **Supported** — Reports runtime and selected authentication availability. Evidence: `APC-E004`, `APC-E014`. | **Supported** — Reports account and plan metadata when exposed by Claude. Evidence: `APC-E008`, `APC-E014`. | **Experimental** — Reports experimental Kimi session availability. Evidence: `APC-E010`, `APC-E014`. |
| **Errors / Execution failures with metrics**<br>`execution-errors-with-metrics` | **Supported** — Uses CodexCliAgentRunError. Evidence: `APC-E003`, `APC-E019`. | **Supported** — Uses PiCliAgentRunError for exit and output-contract failures. Evidence: `APC-E004`, `APC-E019`. | **Partial** — Uses ClaudeCodeCliAgentRunError, subject to the native-tool metric validation gap. Evidence: `APC-E008`, `APC-E019`. Tracking: `APC-GAP-007`. | **Experimental** — Uses KimiCodeCliAgentRunError outside the public promise. Evidence: `APC-E009`, `APC-E019`. Tracking: `APC-GAP-007`. |
| **Errors / Normalized provider errors**<br>`normalized-provider-errors` | **Partial** — Preserves selected provider explanations and keeps credential redaction separate; a shared error taxonomy is not claimed. Evidence: `APC-E003`. Tracking: `APC-GAP-011`. | **Unsupported** — Preserves selected provider explanations; no shared provider-neutral error taxonomy. Tracking: `APC-GAP-011`. | **Partial** — Preserves the native-session failure explanation without guessing plan eligibility; no shared error taxonomy. Evidence: `APC-E008`. Tracking: `APC-GAP-011`. | **Unsupported** — Preserves selected provider explanations; no shared provider-neutral error taxonomy. Tracking: `APC-GAP-011`. |
| **Errors / Common execution error codes**<br>`common-error-codes` | **Unsupported** — No common machine-readable execution error code. Tracking: `APC-GAP-011`. | **Unsupported** — No common machine-readable execution error code. Tracking: `APC-GAP-011`. | **Unsupported** — No common machine-readable execution error code. Tracking: `APC-GAP-011`. | **Unsupported** — No common machine-readable execution error code. Tracking: `APC-GAP-011`. |
| **Security / Secret-free run configuration**<br>`secret-free-run-configuration` | **Supported** — Credential references remain separate from parameters. Evidence: `APC-E013`, `APC-E016`. | **Supported** — Credential references remain separate from parameters. Evidence: `APC-E013`, `APC-E016`. | **Supported** — Credential references remain separate from parameters. Evidence: `APC-E013`, `APC-E016`. | **Experimental** — Uses the shared secret-free configuration contract. Evidence: `APC-E013`, `APC-E016`. |
<!-- END GENERATED:PROVIDER_CAPABILITY_MATRIX -->

The `portable-custom-tools` row means tools that an agent CLI can call through
one provider-neutral declaration. It is not the workflow Effect/Tool SDK. Local
V2 can use a typed workflow effect while agent-callable custom tools remain an
unsupported provider capability.

## Execution combinations

Native-session values marked **current** below are IDs in
`core/config/agent-providers.default.json`. A value marked **target** is required
by a journey but is not productized yet. API-key values are current portal
preset IDs; the user chooses the final Authentication Configuration ID when the
configuration is created. Command authentication has no fixed ID, so its target
is explicitly shown as user-defined.

<!-- BEGIN GENERATED:PROVIDER_EXECUTION_COMBINATION_MATRIX -->
| Combination | Product status | Execution provider | Model provider | Authentication target | Wrapper support | Journey | Notes | Evidence | Tracking |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `codex-openai-native-session` | candidate | `codex-cli` | openai | runtime-native; current auth-provider ID: `codex-native-session` | Supported | Local V2 | Uses the logged-in Codex CLI session. Readiness can remain indeterminate until execution confirms model and quota eligibility. | Evidence: `APC-E003`, `APC-E014`. | Tracking: `APC-GAP-001`. |
| `codex-openai-api-key` | candidate | `codex-cli` | openai | stored-credential; auth-provider preset ID: `codex-openai-api-key` | Supported | Local V2 optional; Managed V1; Managed V2 gate | Managed V1 reference combination and one row of the Managed V2 portability gate. The key is resolved at invocation and injected as OPENAI_API_KEY. | Evidence: `APC-E001`, `APC-E013`. | Tracking: `APC-GAP-001`. |
| `pi-openai-codex-native-session` | candidate | `pi-cli` | openai-codex | runtime-native; current auth-provider ID: `pi-openai-codex-session` | Supported | Local V2 | Uses the Pi runtime with its OpenAI Codex session and installed model catalog. | Evidence: `APC-E004`, `APC-E014`. | Tracking: `APC-GAP-001`. |
| `pi-openai-api-key` | candidate | `pi-cli` | openai | stored-credential; auth-provider preset ID: `pi-openai-api-key` | Supported | Local V2 optional; Managed V2 gate | Uses Pi's OpenAI protocol and the installed text-model catalog. | Evidence: `APC-E004`, `APC-E013`. | Tracking: `APC-GAP-001`. |
| `pi-anthropic-api-key` | candidate | `pi-cli` | anthropic | stored-credential; auth-provider preset ID: `pi-anthropic-api-key` | Partial | Local V2 revision 7 required; Managed V2 gate | The configuration and catalog path exist, but current automated runner evidence does not call Anthropic through the real Pi CLI. | Evidence: `APC-E004`, `APC-E013`. | Tracking: `APC-GAP-001`. |
| `pi-anthropic-native-session` | candidate | `pi-cli` | anthropic | runtime-native; target auth-provider ID: `pi-anthropic-session` | Partial | Historical Local V2 revision 6; not a revision 7 requirement | A native Pi Anthropic request was rejected for third-party extra-usage billing. Revision 7 requires the separate API-key path instead. Existing native records are preserved, not promoted to API-key evidence. | Evidence: `APC-E020`. | Tracking: `APC-GAP-001`, `APC-GAP-018`. |
| `claude-anthropic-native-session` | candidate | `claude-code-cli` | anthropic | runtime-native; current auth-provider ID: `claude-code-native-session` | Partial | Local V2 | Native auth status and failure normalization exist, but there is no real-provider success test in the repository. | Evidence: `APC-E008`, `APC-E014`. | Tracking: `APC-GAP-001`, `APC-GAP-007`. |
| `claude-anthropic-api-key` | candidate | `claude-code-cli` | anthropic | stored-credential; auth-provider preset ID: `claude-code-anthropic-api-key` | Partial | Local V2 optional; Managed V2 gate | Key injection and stream parsing have fake-adapter evidence. Shared native-tool metrics validation and live evidence remain open. | Evidence: `APC-E007`, `APC-E013`. | Tracking: `APC-GAP-001`, `APC-GAP-007`. |
| `pi-command-credential` | candidate | `pi-cli` | configured | command; configured auth-provider ID: `user-defined` | Partial | Prospect only | The core registry can run a fixed helper, but the portal does not create this binding and no live provider combination is certified. | Evidence: `APC-E012`. | Tracking: `APC-GAP-001`, `APC-GAP-015`. |
| `pi-kimi-platform-api-key` | experimental | `pi-cli` | moonshotai | stored-credential; auth-provider preset ID: `pi-kimi-platform-api-key` | Experimental | Prospect only | Implementation hooks and presets exist, but Kimi-related portability was removed from known journeys. | Evidence: `APC-E004`, `APC-E013`. | Tracking: `APC-GAP-001`, `APC-GAP-008`. |
| `kimi-native-session` | experimental | `kimi-code-cli` | kimi | runtime-native; current auth-provider ID: `kimi-code-native-session` | Experimental | Prospect only | Adapter groundwork exists, but it is excluded from the public compatibility promise. | Evidence: `APC-E009`, `APC-E010`. | Tracking: `APC-GAP-008`, `APC-GAP-016`. |
| `kimi-platform-api-key` | experimental | `kimi-code-cli` | kimi | stored-credential; auth-provider preset ID: `kimi-code-platform-api-key` | Experimental | Prospect only | The model environment and key path exist only as experimental groundwork. | Evidence: `APC-E009`, `APC-E013`. | Tracking: `APC-GAP-008`. |
<!-- END GENERATED:PROVIDER_EXECUTION_COMBINATION_MATRIX -->

## Conformance test levels

The suite uses four levels. A higher level does not replace the lower levels.

| Level | What runs | What it proves |
| --- | --- | --- |
| `contract` | Shared types, validators, registries, projections, and manifest rules with no real CLI or network. | The common ArkiMux contract is internally consistent. |
| `adapter` | The real ArkiMux adapter starts a controlled fake CLI process. | Arguments, prompt delivery, environment isolation, parsing, artifacts, timeouts, cleanup, and failures behave as expected. |
| `live-provider` | A pinned real CLI calls a real provider with a real session or API key. | The current CLI, account, model protocol, output stream, usage fields, and provider errors work together. |
| `managed-host` | The live-provider case runs inside the pinned whole-workflow runtime image, execution profile, and target architecture. | The full combination works within its accepted complete-attempt Lambda or Fargate host, managed scratch or attempt-local workspace, secrets, IAM, networking, and image dependencies. It does not imply a separate host per step. |

Workflow checkpoint, replay, mismatch, effect-safety, and whole-run host tests
belong to the durable engine and Execution Host conformance suites. They do not
belong in this provider matrix and cannot make an unsupported provider feature
pass.

The test matrix is:

`execution provider × model protocol × authentication kind × execution profile/host`

A combination passes only for the exact values recorded by its evidence. A pass
for another model protocol, auth kind, operating system, CPU architecture, CLI
version, or image does not transfer automatically.

### Contract and adapter suite

These tests must run in normal CI. They must not need network access, a paid
account, or a developer's native session. They cover:

- manifest integrity and generated-document drift;
- one common request and result shape;
- exact provider-native configuration forwarding;
- prompt delivery and final output extraction;
- selected-credential injection and unrelated-secret exclusion;
- timeout and child-process cleanup;
- required artifacts and common metrics;
- provider-specific output and failure parsing;
- declared unsupported features as named skips.

### Live-provider suite

Live tests are opt-in because they use provider accounts, quotas, and money. A
case definition supplies the non-secret configuration. Start from
`test/provider-conformance/live/cases.example.json` for an ad hoc local check.
CI or the operator supplies credentials through environment variables named by
that file.

Run the suites with:

```sh
npm run test:provider-contract
ARKIMUX_PROVIDER_CONFORMANCE_CASES_FILE=/absolute/path/to/cases.json npm run test:provider-live
ARKIMUX_PROVIDER_CONFORMANCE_CASES_FILE=/absolute/path/to/release-cases.json npm run test:provider-release
```

The normal `npm test` command includes only the deterministic contract suite.
It never runs the live-provider suite.

Before any model call, the live suite validates every case, every required
credential, every executable, every exact CLI version, and every local
authentication preflight. One failed preflight stops the whole set. API-key
cases use empty isolated native-session homes, so an existing local login cannot
silently satisfy an API-key case.

The current release profile is `managed-v2-provider-portability`. It requires
exactly Codex/OpenAI, Pi/OpenAI, Pi/Anthropic, and Claude/Anthropic API-key
combinations, with every applicable bounded Weather Advisor
`lambda-bounded@1` and repository-coding `fargate-workspace@1` fixture/profile
case and the checked-in CLI pins. A release case file must be tracked in the
repository at the exact tested Git revision, and the full worktree must be
clean. No complete release case file is checked in yet, so the release command
cannot produce release evidence today. That file is created and committed when
the candidate models, profiles, and immutable managed images are frozen.

Current profile pins are Codex CLI `0.145.0`, Pi CLI `0.84.3`, and Claude Code
CLI `2.1.241`.

Every live evidence record must include:

- execution-provider ID and version;
- model provider and exact model;
- authentication kind, without the credential value;
- operating system and CPU architecture;
- prompt and expected final text;
- observed artifact hashes, metrics, and safe error details;
- start time, elapsed time, and pass or fail result.

Live tests use one small fixed prompt, a maximum 60-second timeout, and a
post-run reported-cost assertion. That assertion is not a hard spend cap for
providers that do not expose one. Claude cases must also set its native
`max-budget-usd` at or below the assertion value. No case may print, persist, or
hash secret values. Evidence stores only safe fields, byte counts, and hashes
computed after known environment credentials are replaced with a redaction
marker. It never stores raw prompts, outputs, artifact paths, or artifact text.

### Managed-host suite

Managed tests run each applicable live case through its immutable candidate
profile and image. Their evidence must also record:

- execution-profile ID and revision;
- image digest;
- Lambda runtime or Fargate task shape plus exact architecture;
- scratch or attempt-local workspace location, high-water mark, and cleanup
  result;
- secret reference used, not the secret value;
- workspace, workflow, environment, run, and slot boundary IDs;
- IAM denial checks outside the selected workspace boundary.

The managed release gate must fail when a required fixture/profile case is
missing, skipped, or uses a different profile revision, architecture, or image
digest.

## Evidence catalog

Current entries below prove contract or fake-adapter behavior. None of them is a
live-provider or managed-host success yet.

<!-- BEGIN GENERATED:PROVIDER_EVIDENCE_TABLE -->
| Evidence ID | Level | Providers | Test file | Test name | What it proves |
| --- | --- | --- | --- | --- | --- |
| `APC-E001` | adapter | `codex-cli` | `test/core/codex-auth-integration.test.ts` | gives Codex only allowlisted environment and selected authentication | Uses a fake Codex executable to prove prompt delivery, selected-key injection, environment filtering, final output, and temporary-home cleanup. |
| `APC-E002` | contract | `codex-cli` | `test/core/codex-cli-agent-runner.test.ts` | projects comparable usage and shell-command metrics | Proves Codex JSONL token and shell-command metric projection. |
| `APC-E003` | contract | `codex-cli` | `test/core/codex-cli-agent-runner.test.ts` | preserves the provider's model eligibility explanation without inventing advice | Proves the selected Codex access-error explanation is preserved without substituting normalized advice or exposing unrelated event fields. |
| `APC-E004` | adapter | `pi-cli` | `test/agent-input/code/pi-cli-agent-runner.test.ts` | runs Pi ephemerally and normalizes its JSON event stream | Uses a fake Pi executable to prove fixed flags, prompt delivery, key isolation, artifacts, usage, and temporary-directory cleanup. |
| `APC-E005` | adapter | `pi-cli` | `test/agent-input/code/guarded-repository-tools.test.ts` | paginates deterministic listings, searches, reads, and batch reads | Proves the four guarded read-only repository operations and pagination. |
| `APC-E006` | adapter | `pi-cli` | `test/agent-input/code/guarded-repository-tools.test.ts` | rejects absolute paths, traversal, symlink escapes, binary files, and oversized reads | Proves the guarded repository boundary and bounded results. |
| `APC-E007` | adapter | `claude-code-cli` | `test/core/native-cli-agent-runners.test.ts` | runs Claude Code through the provider-independent execution contract | Uses a fake Claude executable to prove prompt delivery, key injection, final output, tool count, usage, and estimated cost. |
| `APC-E008` | adapter | `claude-code-cli` | `test/core/native-cli-agent-runners.test.ts` | preserves Claude's authentication error without guessing plan eligibility | Proves the selected Claude native-session failure is preserved without invented plan eligibility advice. |
| `APC-E009` | adapter | `kimi-code-cli` | `test/core/native-cli-agent-runners.test.ts` | runs Kimi Code with an isolated prompt file and ephemeral model environment | Uses a fake Kimi executable to prove the experimental adapter's prompt file, model environment, output, usage, and tool count. |
| `APC-E010` | adapter | `kimi-code-cli` | `test/core/native-cli-agent-runners.test.ts` | runs Kimi Code against the runtime-native session home | Proves that the experimental Kimi adapter can reuse its configured native-session home. |
| `APC-E011` | contract | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | `test/core/agent-auth-provider.test.ts` | maps only the selected environment credential into the target variable | Proves generic environment-key preparation and disposal. |
| `APC-E012` | contract | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | `test/core/agent-auth-provider.test.ts` | retrieves a credential from a fixed helper without exposing helper details | Proves generic command-backed credential retrieval. |
| `APC-E013` | contract | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | `test/core/agent-credential-store.test.ts` | stores a write-only local credential with restrictive permissions and resolves it only at execution | Proves stored-key metadata separation and invocation-time resolution. |
| `APC-E014` | contract | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | `test/core/agent-execution-provider.test.ts` | performs an isolated minimal auth probe without workflow context or tools | Proves the active connection-check contract. |
| `APC-E015` | adapter | `codex-cli`, `claude-code-cli` | `test/core/codex-auth-integration.test.ts` | preflights the same repository-local Codex executable that execution resolves | Together with the matching Claude test, proves repository-local executable resolution and preflight identity. |
| `APC-E016` | contract | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | `test/core/run-configuration.test.ts` | validates provider-native parameters and prohibits persisted secrets | Proves persisted parameter validation and secret-like key rejection. |
| `APC-E017` | contract | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | `test/core/run-records.test.ts` | validates deterministic performance summaries containing provider costs | Proves the provider-neutral attempt and run-performance aggregation contract. |
| `APC-E018` | adapter | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | `test/provider-conformance/contract/agent-execution-provider.contract.test.ts` | preflights and runs through the provider-neutral contract | Runs every real adapter against a controlled fake CLI to prove common preflight, prompt, configuration, key isolation, final output, artifacts, and metrics. |
| `APC-E019` | adapter | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | `test/provider-conformance/contract/agent-execution-provider.contract.test.ts` | terminates a timed-out invocation and retains provider-neutral diagnostics | Runs every real adapter against a controlled hanging CLI to prove timeout termination, typed failure metrics, and retained diagnostics. |
| `APC-E020` | adapter | `pi-cli` | `test/provider-conformance/contract/agent-execution-provider.contract.test.ts` | runs Pi with an Anthropic native session through an isolated agent directory | Uses a fake Pi executable and a configured Anthropic auth.json session to prove the generic native-session execution path and isolated copied agent directory. |
<!-- END GENERATED:PROVIDER_EVIDENCE_TABLE -->

## Unsupported capability behavior

An unsupported row remains in the matrix and the automated suite. Its test must
be skipped with the matching tracking ID and a short reason. It must never use a
no-op implementation and report a false pass.

When a capability becomes implemented:

1. add or update the test first;
2. run it at the required test level;
3. add its evidence record to the manifest;
4. change the status and regenerate this document;
5. update the journey gate only if that journey needs the capability.

Experimental capabilities follow the same evidence rules, but do not satisfy a
released journey gate.

## Known inconsistencies and gaps

These are current facts, not completed fixes:

- The metrics TypeScript type and Claude/Kimi adapters use
  `native-tool-call`, but the shared runtime validator rejects that value.
- Product documents place Kimi in prospects, while the current registry,
  editor metadata, templates, native-session rows, and authentication presets
  still expose Kimi-related entries.
- Local V2 names Pi Claude Session, but the current default configuration and
  UI expose only Pi OpenAI Codex Session. The generic Pi Anthropic native path
  has fake-adapter evidence only.
- Current automated runner tests use fake CLI executables. They do not prove a
  real current CLI, provider account, model, or streamed protocol.
- The target architecture gives scratch ownership to the execution host, but
  the current runners still choose their own temporary paths.
- A preflight lifecycle event is declared in the common event type, but no
  current producer emits it.

<!-- BEGIN GENERATED:PROVIDER_GAP_TABLE -->
| Tracking ID | Gap | Status | Providers | Current meaning |
| --- | --- | --- | --- | --- |
| `APC-GAP-001` | No real-provider conformance suite | open | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | Current automated runner evidence uses fake CLI executables. It does not prove current pinned CLIs against live provider protocols, accounts, streaming, tools, or errors. |
| `APC-GAP-002` | No caller-facing response streaming | prospect | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | Runners append native output to local artifacts while executing, but return to callers only after the process closes. |
| `APC-GAP-003` | No external cancellation contract | open | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | The execution request has no AbortSignal or cancellation method. Only timeout-driven child termination exists. |
| `APC-GAP-004` | No automatic retry or provider idempotency contract | prospect | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | Attempt is metadata only. The wrapper does not retry execution or carry a provider idempotency key. Managed dispatch recovery is a separate host concern and does not provide either wrapper behavior. |
| `APC-GAP-005` | No provider-native structured output | prospect | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | ArkiMux parses final text as JSON after execution. It does not send a JSON Schema, validate a typed result, or repair invalid output at the provider boundary. |
| `APC-GAP-006` | No portable tool contract | prospect | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | Native tools differ by runner. Only Pi has a runner-owned extension point and current guarded repository implementation. |
| `APC-GAP-007` | Native tool-call metrics fail shared validation | open | `claude-code-cli`, `kimi-code-cli` | The metrics type and runners use native-tool-call, while the shared validator currently accepts only shell-command and guarded-repository-operation. |
| `APC-GAP-008` | Kimi product exposure conflicts with the prospect decision | open | `kimi-code-cli` | Product documents exclude Kimi, but current default registry, editor metadata, templates, native-session rows, and authentication presets still contain it. |
| `APC-GAP-009` | Runners still allocate their own temporary paths | accepted | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | The target host-controlled scratch contract is not implemented. Claude also has no runner-owned isolated configuration home today. Managed V1 owns this contract for released managed providers; Kimi remains excluded. |
| `APC-GAP-010` | Provider proxy is not implemented | prospect | `codex-cli`, `pi-cli`, `claude-code-cli` | There is no proxy protocol adapter, workload identity, short-lived operation grant, proxy usage policy, or proxy conformance evidence. |
| `APC-GAP-011` | No common execution error taxonomy | open | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | Runners throw provider-specific Error subclasses with messages and optional metrics. Only selected Codex and Claude failures are normalized. |
| `APC-GAP-012` | No retained-output secret redaction | open | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | The platform avoids persisting configured credentials, but native stdout, stderr, and final output are retained without a runner-level redaction guarantee. |
| `APC-GAP-013` | Input is one text prompt only | prospect | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | The common request has no message history, role-separated instructions, image, audio, or file-part input. |
| `APC-GAP-014` | Preflight lifecycle event is declared but not emitted | open | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | agent-preflight-completed exists in RunEvent, but no current producer emits it. |
| `APC-GAP-015` | Command authentication is configuration-only | prospect | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | The core authentication registry supports a credential command, but the current portal creates stored-credential bindings rather than command bindings. |
| `APC-GAP-016` | Kimi session isolation is not enforced | open | `kimi-code-cli` | The experimental Kimi command does not request no-session behavior, and native authentication reuses the configured session home. |
| `APC-GAP-017` | Usage and diagnostic metrics are not equal across runners | prospect | `codex-cli`, `pi-cli`, `claude-code-cli`, `kimi-code-cli` | Reasoning tokens, cost, detailed tool counts, stop reason, request ID, time to first token, and rate-limit data vary or are absent. |
| `APC-GAP-018` | Pi Anthropic native Connection is not productized | open | `pi-cli` | The generic Pi native-session runner can read an Anthropic session from auth.json, but the current default configuration and UI expose only Pi OpenAI Codex Session, and no real-provider proof exists. |
<!-- END GENERATED:PROVIDER_GAP_TABLE -->

## Evidence and document update rules

- Evidence IDs are stable. Do not reuse an old ID for a different test.
- Evidence source paths are repository-relative file paths without line numbers
  or anchors.
- Every evidence entry names the exact test whose behavior it represents.
- Fake-adapter evidence cannot be called live-provider evidence.
- A live or managed evidence artifact must record pinned versions and a safe
  failure phase. It must not contain credential values.
- Generated blocks must be rendered from the manifest. Do not edit their table
  rows by hand.
- A status change, new combination, new evidence record, or new gap requires a
  manifest change and regenerated blocks in the same commit.

## Definition of done for one execution combination

An execution combination is ready for its declared journey only when:

1. its required capability rows have no unsupported or unresolved partial
   status for that journey;
2. contract and adapter tests pass in normal CI;
3. the exact real CLI, model protocol, and authentication kind pass the
   live-provider suite;
4. a managed journey also passes every applicable managed-host fixture/profile
   case on the exact candidate profile revision, architecture, and image digest;
5. evidence is stored without secrets and linked by stable evidence IDs;
6. the matrix, gap table, journey gate, and public claim say the same thing.
