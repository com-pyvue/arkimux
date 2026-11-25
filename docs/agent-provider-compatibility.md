# Local provider compatibility

ArkiMux starts a provider CLI for an agent step. The CLI, the model provider,
and the authentication method all matter: a working Codex login does not test
Pi, and a working Pi session does not test an Anthropic API key.

## Which Local connections are tested?

The [Local connection tests](../test/provider-conformance/contract/local-v2-connections.contract.test.ts)
exercise four combinations: **Codex with a native session**, **Pi with an OpenAI
Codex session**, **Pi with a stored Anthropic API key**, and **Claude Code with a
native session**. They cover completion, failure, cancellation, and timeout using
real ArkiMux adapters and **fake CLI processes**. They do not establish that your
installed CLI, credentials, model, quota, or billing will work.

Use **Connections → Test connection** for a live check of your selected binding.
It makes a minimal inference request, can consume quota, and does not verify
access to every model. Pi with a native Anthropic session is not the same
connection as Pi with a stored Anthropic key. Kimi is experimental and is not
offered as a Local Connection.

## Adapter and authentication combinations

These rows describe adapter behavior, not a list of options guaranteed to
appear in the UI. A preset identifies a configuration template; a target ID
does not identify an available preset. Test IDs refer to the catalog below.

<!-- BEGIN GENERATED:PROVIDER_EXECUTION_COMBINATION_MATRIX -->
| Combination | Execution provider | Model provider | Authentication target | Wrapper support | Notes | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| `codex-openai-native-session` | `codex-cli` | openai | runtime-native; current auth-provider ID: `codex-native-session` | Supported | Uses the logged-in Codex CLI session. Readiness can remain indeterminate until execution confirms model and quota eligibility. | Evidence: `APC-E003`, `APC-E014`. |
| `codex-openai-api-key` | `codex-cli` | openai | stored-credential; auth-provider preset ID: `codex-openai-api-key` | Supported | The key is resolved at invocation and injected as OPENAI_API_KEY. | Evidence: `APC-E001`, `APC-E013`. |
| `pi-openai-codex-native-session` | `pi-cli` | openai-codex | runtime-native; current auth-provider ID: `pi-openai-codex-session` | Supported | Uses the Pi runtime with its OpenAI Codex session and installed model catalog. | Evidence: `APC-E004`, `APC-E014`. |
| `pi-openai-api-key` | `pi-cli` | openai | stored-credential; auth-provider preset ID: `pi-openai-api-key` | Supported | Uses Pi's OpenAI protocol and the installed text-model catalog. | Evidence: `APC-E004`, `APC-E013`. |
| `pi-anthropic-api-key` | `pi-cli` | anthropic | stored-credential; auth-provider preset ID: `pi-anthropic-api-key` | Partial | The configuration and catalog path exist, but current automated runner evidence does not call Anthropic through the real Pi CLI. | Evidence: `APC-E004`, `APC-E013`. |
| `pi-anthropic-native-session` | `pi-cli` | anthropic | runtime-native; target auth-provider ID: `pi-anthropic-session` | Partial | A native Pi Anthropic request was rejected for third-party extra-usage billing. Use the separate stored-key connection for Pi with Anthropic; a native session is not a substitute for that key. | Evidence: `APC-E020`. |
| `claude-anthropic-native-session` | `claude-code-cli` | anthropic | runtime-native; current auth-provider ID: `claude-code-native-session` | Partial | Native auth status and failure normalization exist, but there is no real-provider success test in the repository. | Evidence: `APC-E008`, `APC-E014`. |
| `claude-anthropic-api-key` | `claude-code-cli` | anthropic | stored-credential; auth-provider preset ID: `claude-code-anthropic-api-key` | Partial | Key injection and stream parsing have fake-adapter evidence. Shared native-tool metrics validation and live evidence remain open. | Evidence: `APC-E007`, `APC-E013`. |
| `pi-command-credential` | `pi-cli` | configured | command; configured auth-provider ID: `user-defined` | Partial | The core registry can run a fixed helper, but the portal does not create this binding and no live provider combination is certified. | Evidence: `APC-E012`. |
| `pi-kimi-platform-api-key` | `pi-cli` | moonshotai | stored-credential; auth-provider preset ID: `pi-kimi-platform-api-key` | Experimental | Experimental adapter hooks only; not offered as a Local Connection. | Evidence: `APC-E004`, `APC-E013`. |
| `kimi-native-session` | `kimi-code-cli` | kimi | runtime-native; current auth-provider ID: `kimi-code-native-session` | Experimental | Adapter groundwork exists, but it is excluded from the public compatibility promise. | Evidence: `APC-E009`, `APC-E010`. |
| `kimi-platform-api-key` | `kimi-code-cli` | kimi | stored-credential; auth-provider preset ID: `kimi-code-platform-api-key` | Experimental | The model environment and key path exist only as experimental groundwork. | Evidence: `APC-E009`, `APC-E013`. |
<!-- END GENERATED:PROVIDER_EXECUTION_COMBINATION_MATRIX -->

## Common wrapper contract

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

Adapters do not own [workflow checkpoints, replay, or external-effect safety](durable-workflow-engine.md).

## Adapter capabilities

**Supported** means the wrapper implements the feature; **Partial** means the
cell names a limitation. **Experimental** is not a supported Local feature.
**Unsupported** means the wrapper does not provide it; **N/A** means it does not
apply. None of these labels alone means a live account was tested.

<!-- BEGIN GENERATED:PROVIDER_CAPABILITY_MATRIX -->
| Capability | Codex CLI | Pi CLI | Claude Code CLI | Kimi Code CLI |
| --- | --- | --- | --- | --- |
| **Input / Single text prompt**<br>`single-text-prompt` | **Supported** — Delivered through stdin. Evidence: `APC-E001`, `APC-E018`. | **Supported** — Delivered through stdin. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Delivered through stdin. Evidence: `APC-E007`, `APC-E018`. | **Experimental** — Delivered through an isolated prompt file. Evidence: `APC-E009`, `APC-E018`. |
| **Input / Working directory**<br>`working-directory` | **Supported** — Child process uses request.cwd. Evidence: `APC-E001`. | **Supported** — Child process uses request.cwd. Evidence: `APC-E004`. | **Supported** — Child process uses request.cwd. Evidence: `APC-E007`. | **Experimental** — Child process uses request.cwd. Evidence: `APC-E009`. |
| **Input / Message history**<br>`message-history` | **Unsupported** — No message-history or role-separated input. | **Unsupported** — No message-history or role-separated input. | **Unsupported** — No message-history or role-separated input. | **Unsupported** — No message-history or role-separated input. |
| **Input / Multimodal input**<br>`multimodal-input` | **Unsupported** — No image, audio, or file-part input. | **Unsupported** — No image, audio, or file-part input. | **Unsupported** — No image, audio, or file-part input. | **Unsupported** — No image, audio, or file-part input. |
| **Configuration / Model selection**<br>`model-selection` | **Supported** — Forwards the model as Codex configuration. Evidence: `APC-E001`, `APC-E016`, `APC-E018`. | **Supported** — Requires provider and model values. Evidence: `APC-E004`, `APC-E016`, `APC-E018`. | **Supported** — Requires a Claude model or alias. Evidence: `APC-E007`, `APC-E016`, `APC-E018`. | **Experimental** — Requires a Kimi model value. Evidence: `APC-E009`, `APC-E016`, `APC-E018`. |
| **Configuration / Reasoning or thinking control**<br>`reasoning-control` | **Supported** — Uses model_reasoning_effort. Evidence: `APC-E002`, `APC-E016`, `APC-E018`. | **Supported** — Uses thinking, including off. Evidence: `APC-E004`, `APC-E016`, `APC-E018`. | **Supported** — Uses effort. Evidence: `APC-E007`, `APC-E016`, `APC-E018`. | **Experimental** — Uses thinking-effort. Evidence: `APC-E009`, `APC-E016`, `APC-E018`. |
| **Configuration / Model-provider routing**<br>`model-provider-routing` | **Partial** — Accepts arbitrary Codex model_provider configuration, but the adapter tests cover OpenAI. Evidence: `APC-E001`. | **Supported** — Requires an explicit provider and installed text-model catalog entry. Evidence: `APC-E004`. | **N/A** — The adapter is fixed to the native Anthropic protocol. | **Experimental** — Supports kimi, anthropic, or openai provider types. Evidence: `APC-E009`. |
| **Configuration / Provider-native parameters**<br>`provider-native-parameters` | **Supported** — Forwards scalar and scalar-array values as sorted Codex --config entries. Evidence: `APC-E001`, `APC-E016`, `APC-E018`. | **Supported** — Strictly accepts provider, model, and thinking. Evidence: `APC-E004`, `APC-E016`, `APC-E018`. | **Supported** — Accepts model, effort, permission mode, and maximum USD budget. Evidence: `APC-E007`, `APC-E016`, `APC-E018`. | **Experimental** — Accepts provider type, base URL, context size, capabilities, and thinking effort. Evidence: `APC-E009`, `APC-E016`, `APC-E018`. |
| **Readiness / Executable and version preflight**<br>`executable-preflight` | **Supported** — Resolves explicit, repository-local, then PATH executable. Evidence: `APC-E015`, `APC-E018`. | **Supported** — Uses the shared executable resolver and version probe. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Also checks the configured required version. Evidence: `APC-E015`, `APC-E018`. | **Experimental** — Also checks the configured required version. Evidence: `APC-E009`, `APC-E018`. |
| **Authentication / Runtime-native session**<br>`runtime-native-authentication` | **Supported** — Uses Codex login status and isolated child home links. Evidence: `APC-E003`. | **Partial** — The generic runner can use auth.json, but Pi Anthropic native Connection setup and live proof are missing. Evidence: `APC-E020`. | **Supported** — Uses claude auth status and provider-reported identity when available. Evidence: `APC-E008`. | **Experimental** — Uses the configured Kimi native-session home. Evidence: `APC-E010`. |
| **Authentication / API-key authentication**<br>`api-key-authentication` | **Supported** — Supports environment and stored OpenAI keys. Evidence: `APC-E001`, `APC-E011`, `APC-E013`. | **Supported** — Supports environment and stored keys for configured model providers. Evidence: `APC-E004`, `APC-E011`, `APC-E013`. | **Supported** — Supports environment and stored Anthropic keys. Evidence: `APC-E007`, `APC-E011`, `APC-E013`. | **Experimental** — Supports environment and stored Kimi model keys. Evidence: `APC-E009`, `APC-E011`, `APC-E013`. |
| **Authentication / Credential command**<br>`command-authentication` | **Partial** — Supported by core configuration, not current portal creation. Evidence: `APC-E012`. | **Partial** — Supported by core configuration, not current portal creation. Evidence: `APC-E012`. | **Partial** — Supported by core configuration, not current portal creation. Evidence: `APC-E012`. | **Experimental** — Implemented by the shared auth registry but outside the product promise. Evidence: `APC-E012`. |
| **Authentication / Active connection probe**<br>`active-connection-probe` | **Supported** — Uses a low-effort tool-free probe prompt. Evidence: `APC-E014`. | **Supported** — Can try later stable catalog models after a model-access failure. Evidence: `APC-E014`. | **Supported** — Uses Haiku, low effort, and plan permission mode. Evidence: `APC-E014`. | **Experimental** — Uses the experimental Kimi runtime and model. Evidence: `APC-E014`. |
| **Authentication / Provider proxy operation grant**<br>`provider-proxy-authentication` | **Unsupported** — No provider proxy authentication or protocol path. | **Unsupported** — No provider proxy authentication or protocol path. | **Unsupported** — No provider proxy authentication or protocol path. | **Unsupported** — Kimi is not in the planned first proxy boundary. |
| **Execution / Allowlisted child environment**<br>`environment-isolation` | **Supported** — Unrelated host variables are excluded. Evidence: `APC-E001`, `APC-E018`. | **Supported** — Unrelated host variables are excluded. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Uses the shared allowlisted environment path. Evidence: `APC-E007`, `APC-E011`, `APC-E018`. | **Experimental** — Uses the shared allowlisted environment path. Evidence: `APC-E009`, `APC-E011`, `APC-E018`. |
| **Execution / Ephemeral invocation session**<br>`ephemeral-session` | **Supported** — Uses --ephemeral and removes its temporary child home. Evidence: `APC-E001`. | **Supported** — Uses --no-session and removes its temporary agent directory. Evidence: `APC-E004`. | **Supported** — Uses --no-session-persistence. Evidence: `APC-E007`. | **Experimental** — One-shot execution exists, but no no-session flag is enforced. Evidence: `APC-E009`, `APC-E010`. |
| **Execution / Timeout termination**<br>`timeout-termination` | **Supported** — Sends SIGTERM, then SIGKILL after two seconds. Evidence: `APC-E019`. | **Supported** — Sends SIGTERM, then SIGKILL after two seconds. Evidence: `APC-E019`. | **Supported** — Uses the shared streaming-process timeout. Evidence: `APC-E019`. | **Experimental** — Uses the shared streaming-process timeout. Evidence: `APC-E019`. |
| **Execution / External cancellation**<br>`external-cancellation` | **Unsupported** — No caller cancellation signal or method. | **Unsupported** — No caller cancellation signal or method. | **Unsupported** — No caller cancellation signal or method. | **Unsupported** — No caller cancellation signal or method. |
| **Execution / Automatic retry**<br>`automatic-retry` | **Unsupported** — No automatic execution retry. | **Unsupported** — No automatic execution retry. | **Unsupported** — No automatic execution retry. | **Unsupported** — No automatic execution retry. |
| **Execution / Provider request idempotency**<br>`provider-idempotency` | **Unsupported** — No provider request idempotency key. | **Unsupported** — No provider request idempotency key. | **Unsupported** — No provider request idempotency key. | **Unsupported** — No provider request idempotency key. |
| **Execution / Host-controlled scratch**<br>`host-controlled-scratch` | **Unsupported** — Runner chooses temporary paths instead of receiving host scratch. | **Unsupported** — Runner chooses temporary paths instead of receiving host scratch. | **Unsupported** — Runner chooses temporary paths instead of receiving host scratch. | **Unsupported** — Runner chooses temporary paths instead of receiving host scratch. |
| **Output / Provider-neutral final text**<br>`final-text-result` | **Supported** — Reads Codex --output-last-message, with stdout fallback. Evidence: `APC-E001`, `APC-E018`. | **Supported** — Requires exactly one successful final assistant message. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Projects the result event into the last-message artifact. Evidence: `APC-E007`, `APC-E018`. | **Experimental** — Projects the final non-tool assistant message. Evidence: `APC-E009`, `APC-E018`. |
| **Output / Native event-stream artifact**<br>`native-event-artifact` | **Supported** — Captures Codex JSONL stdout. Evidence: `APC-E001`, `APC-E018`. | **Supported** — Captures Pi JSONL stdout. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Captures Claude streaming JSON stdout. Evidence: `APC-E007`, `APC-E018`. | **Experimental** — Captures Kimi streaming JSON stdout. Evidence: `APC-E009`, `APC-E018`. |
| **Output / Caller-facing response streaming**<br>`caller-response-streaming` | **Unsupported** — Only artifact capture is live; callers wait for completion. | **Unsupported** — Only artifact capture is live; callers wait for completion. | **Unsupported** — Only artifact capture is live; callers wait for completion. | **Unsupported** — Only artifact capture is live; callers wait for completion. |
| **Output / Provider-native structured output**<br>`provider-native-structured-output` | **Unsupported** — No provider-native JSON Schema response contract. | **Unsupported** — No provider-native JSON Schema response contract. | **Unsupported** — No provider-native JSON Schema response contract. | **Unsupported** — No provider-native JSON Schema response contract. |
| **Output / Normalized lifecycle events**<br>`normalized-lifecycle-events` | **Partial** — Execution events exist; declared preflight event has no producer. Evidence: `APC-E017`. | **Partial** — Execution events exist; declared preflight event has no producer. Evidence: `APC-E017`. | **Partial** — Execution events exist; declared preflight event has no producer. Evidence: `APC-E017`. | **Experimental** — Experimental execution uses the shared lifecycle event contract. Evidence: `APC-E017`. |
| **Tools / Runner-native tools**<br>`native-tools` | **Partial** — Native command execution remains available, but apps and plugins are disabled and tools are not portable. Evidence: `APC-E002`. | **N/A** — All Pi built-in tools are deliberately disabled. | **Partial** — Native tool use is controlled only through permission mode and is not portable. Evidence: `APC-E007`. | **Experimental** — Native tool calls are observed but remain outside the public promise. Evidence: `APC-E009`. |
| **Tools / Guarded read-only repository tools**<br>`guarded-repository-tools` | **N/A** — Codex does not use the Pi extension contract. | **Supported** — Optional runner-owned extension exposes four guarded tools. Evidence: `APC-E005`, `APC-E006`. | **N/A** — Claude does not use the Pi extension contract. | **N/A** — Kimi does not use the Pi extension contract. |
| **Tools / Portable custom tools**<br>`portable-custom-tools` | **Unsupported** — No shared tool declaration and result contract. | **Unsupported** — No shared tool declaration and result contract. | **Unsupported** — No shared tool declaration and result contract. | **Unsupported** — No shared tool declaration and result contract. |
| **Metrics / Basic execution metrics**<br>`basic-execution-metrics` | **Supported** — Produces the shared metric envelope. Evidence: `APC-E001`, `APC-E017`, `APC-E018`, `APC-E019`. | **Supported** — Produces the shared metric envelope. Evidence: `APC-E004`, `APC-E017`, `APC-E018`, `APC-E019`. | **Partial** — Produces the envelope, but native-tool-call currently fails shared validation. Evidence: `APC-E007`, `APC-E017`, `APC-E018`, `APC-E019`. | **Experimental** — Produces the envelope, but native-tool-call currently fails shared validation. Evidence: `APC-E009`, `APC-E017`, `APC-E018`, `APC-E019`. |
| **Metrics / Input, cached, and output tokens**<br>`token-usage` | **Supported** — Projects input, cached input, and output tokens. Evidence: `APC-E002`, `APC-E018`. | **Supported** — Aggregates input, cache read, and output across assistant messages. Evidence: `APC-E004`, `APC-E018`. | **Supported** — Projects input, cache-read input, and output tokens. Evidence: `APC-E007`, `APC-E018`. | **Experimental** — Projects available input, cached input, and output tokens. Evidence: `APC-E009`, `APC-E018`. |
| **Metrics / Reasoning-token usage**<br>`reasoning-token-usage` | **Supported** — Reads reasoning_output_tokens. Evidence: `APC-E002`. | **Supported** — Aggregates Pi reasoning usage. Evidence: `APC-E004`. | **Unsupported** — Current Claude parser does not project reasoning tokens. | **Unsupported** — Current Kimi parser does not project reasoning tokens. |
| **Metrics / Provider-estimated cost**<br>`estimated-cost` | **Unsupported** — Current Codex event projection has no cost field. | **Supported** — Aggregates native usage cost totals. Evidence: `APC-E004`. | **Supported** — Projects total_cost_usd. Evidence: `APC-E007`. | **Unsupported** — Current Kimi parser has no cost projection. |
| **Metrics / Tool-call metrics**<br>`tool-call-metrics` | **Partial** — Counts command_execution items and infers search or read operations from command text. Evidence: `APC-E002`. | **Supported** — Uses exact guarded repository audit metrics when the extension is installed. Evidence: `APC-E005`, `APC-E006`. | **Partial** — Counts native tool_use blocks, but shared validation rejects its unit. Evidence: `APC-E007`. | **Experimental** — Counts native tool_calls, but shared validation rejects its unit. Evidence: `APC-E009`. |
| **Metrics / Detailed provider diagnostics**<br>`detailed-provider-metrics` | **Unsupported** — Not present in the common metric contract. | **Unsupported** — Not present in the common metric contract. | **Unsupported** — Not present in the common metric contract. | **Unsupported** — Not present in the common metric contract. |
| **Artifacts / Standard local artifacts**<br>`standard-artifacts` | **Supported** — Produces all four standard local files. Evidence: `APC-E001`, `APC-E018`, `APC-E019`. | **Supported** — Produces all four standard local files. Evidence: `APC-E004`, `APC-E018`, `APC-E019`. | **Supported** — Produces all four standard local files. Evidence: `APC-E007`, `APC-E018`, `APC-E019`. | **Experimental** — Produces all four standard local files. Evidence: `APC-E009`, `APC-E018`, `APC-E019`. |
| **Artifacts / Repository-tool audit artifact**<br>`repository-tool-audit` | **N/A** — No runner-owned guarded repository tool adapter. | **Supported** — Produced when the guarded repository extension is installed. Evidence: `APC-E005`, `APC-E006`. | **N/A** — No runner-owned guarded repository tool adapter. | **N/A** — No runner-owned guarded repository tool adapter. |
| **Artifacts / Retained-output secret redaction**<br>`retained-output-redaction` | **Unsupported** — Retained native output has no secret-redaction guarantee. | **Unsupported** — Retained native output has no secret-redaction guarantee. | **Unsupported** — Retained native output has no secret-redaction guarantee. | **Unsupported** — Retained native output has no secret-redaction guarantee. |
| **Errors / Typed readiness status**<br>`readiness-status` | **Supported** — Reports native login method and actionable remediation. Evidence: `APC-E003`, `APC-E014`. | **Supported** — Reports runtime and selected authentication availability. Evidence: `APC-E004`, `APC-E014`. | **Supported** — Reports account and plan metadata when exposed by Claude. Evidence: `APC-E008`, `APC-E014`. | **Experimental** — Reports experimental Kimi session availability. Evidence: `APC-E010`, `APC-E014`. |
| **Errors / Execution failures with metrics**<br>`execution-errors-with-metrics` | **Supported** — Uses CodexCliAgentRunError. Evidence: `APC-E003`, `APC-E019`. | **Supported** — Uses PiCliAgentRunError for exit and output-contract failures. Evidence: `APC-E004`, `APC-E019`. | **Partial** — Uses ClaudeCodeCliAgentRunError, subject to the native-tool metric validation gap. Evidence: `APC-E008`, `APC-E019`. | **Experimental** — Uses KimiCodeCliAgentRunError outside the public promise. Evidence: `APC-E009`, `APC-E019`. |
| **Errors / Normalized provider errors**<br>`normalized-provider-errors` | **Partial** — Preserves selected provider explanations and keeps credential redaction separate; a shared error taxonomy is not claimed. Evidence: `APC-E003`. | **Unsupported** — Preserves selected provider explanations; no shared provider-neutral error taxonomy. | **Partial** — Preserves the native-session failure explanation without guessing plan eligibility; no shared error taxonomy. Evidence: `APC-E008`. | **Unsupported** — Preserves selected provider explanations; no shared provider-neutral error taxonomy. |
| **Errors / Common execution error codes**<br>`common-error-codes` | **Unsupported** — No common machine-readable execution error code. | **Unsupported** — No common machine-readable execution error code. | **Unsupported** — No common machine-readable execution error code. | **Unsupported** — No common machine-readable execution error code. |
| **Security / Secret-free run configuration**<br>`secret-free-run-configuration` | **Supported** — Credential references remain separate from parameters. Evidence: `APC-E013`, `APC-E016`. | **Supported** — Credential references remain separate from parameters. Evidence: `APC-E013`, `APC-E016`. | **Supported** — Credential references remain separate from parameters. Evidence: `APC-E013`, `APC-E016`. | **Experimental** — Uses the shared secret-free configuration contract. Evidence: `APC-E013`, `APC-E016`. |
<!-- END GENERATED:PROVIDER_CAPABILITY_MATRIX -->

## How to read the tests

Run `npm run test:provider-contract` from the repository root for the offline
suite. A **contract** test checks ArkiMux types or behavior. An **adapter** test
can exercise the real wrapper with a controlled executable. Neither is proof
of compatibility with an upstream service today. An actual provider request
requires your permission and may incur charges.

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
