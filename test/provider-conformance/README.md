# Provider conformance suite

See the [provider compatibility guide](../../docs/agent-provider-compatibility.md)
for adapter features, authentication modes and the limits of each kind of test.
The suite is covered by the [suite licence](LICENSE); dependencies retain their own terms.

Run offline tests from the repository root with `npm run test:provider-contract`.
`contract/local-v2-connections.contract.test.ts` exercises the four Local V2
Connection modes using real ArkiMux authentication adapters and synthetic CLIs:
Codex native, Pi Codex native, Pi Anthropic stored key, and Claude native.
Each gets completion, failure, cancellation and timeout checks; the Pi key path
must not fall back to a native session. All results use one controlled schema.
Metrics pass the shared validator, including Claude native-tool counts on failure.

These checks do not call a provider, read user sessions, prove installed upstream
CLI compatibility, or prove whole-workflow replay and Results API persistence.
Native session values are synthetic. The separate live harness requires explicit
quota approval and exact installed runtime/model observations. Missing or skipped
live cases never become passing through the offline suite.
