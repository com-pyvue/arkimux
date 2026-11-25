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
Native session values are synthetic. A passing offline test is not a live result.

The [live suite](vitest.live.config.ts) makes billable calls with the configured
credentials. If the quota is not yours, get the account owner's approval first.
To run it, copy the [example case file](live/cases.example.json)
outside the repository. Set the installed CLI path and exact version, the model
you intend to call, and your evidence directory. Supply the credential through
the environment variable named in the case file, not in the JSON. From the
repository root, with dependencies installed, run:

```sh
ARKIMUX_PROVIDER_CONFORMANCE_CASES_FILE=/absolute/path/to/your-cases.json \
  ./node_modules/.bin/vitest run --config test/provider-conformance/vitest.live.config.ts
```
