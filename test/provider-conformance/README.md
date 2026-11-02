# Provider conformance suite

This directory's compatibility matrix, contract tests, embedded fake CLI fixtures
and live harness are licensed under Apache-2.0, as specified by the existing
Local V2 publication decision in `docs/agent-provider-compatibility.md`. See
`LICENSE`. This scoped notice does not relicense imported runtime implementations
or third-party packages, publish the suite, or prove public source availability.

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

For private-candidate evidence, retain this source, licence and referenced fixtures
before running tests. Resolve public adapter imports to that candidate's installed
Core bundle and prove those export identities. Keep helper-only source tests
labelled separately. Record package/source hashes and pre/post read-back results;
a passing source test alone is not package-bound conformance or gate acceptance.
