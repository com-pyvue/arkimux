# External and internal error diagnostics

Providers already return useful explanations, but ArkiMux previously discarded
some of them and exposed some unclassified internal exceptions instead.

## Rule

- Preserve a provider's selected error message, code and HTTP status. Keep its
  formatting, option lists, public links and request identifiers.
- Remove actual credentials and terminal control sequences. A provider response
  is not assumed to be secret-free. Do not remove ordinary explanations merely
  because they mention a key, token, path, payload or model.
- Select explicit error events, not unrelated assistant output or entire
  request/response objects. Existing process and response-size guards still apply.
- Unknown ArkiMux exceptions become a short, authored message. Do not publish
  their stack, host paths, raw exception objects or arbitrary `Error.message`.
- A shortened debugger response points to saved failure evidence containing the
  complete safe diagnostic. Storage does not silently shorten provider messages.

## Adapter and effect boundary

Use `ExternalProviderError` only where an external failure has been identified:

```ts
throw new ExternalProviderError("weather", providerMessage, {
  code: providerCode,
  httpStatus: response.status,
  secretValues: resolvedCredentialValues,
});
```

The public metadata is `{ origin: "external", provider, message, code?,
httpStatus? }`. Runtime wrappers preserve this metadata; they do not infer the
origin from the wording of an arbitrary exception. Credentials are removed at
the adapter before the error crosses IPC or enters storage.

`public-workflow-imports@2` permits the diagnostic error/types,
`getExternalErrorDiagnostic`, and `credentialSecretValues` from the Core package.
This lets declared effects report provider failures without importing private
provider runners, storage or engine implementations. Weather's effect, read step
and workflow contract advance to version 2; its public workflow identity remains
`weather-advisor@1` and its result schema is unchanged.

## Audit coverage

| Audit item | Corrected behavior |
| --- | --- |
| 1 | Weather retains TLS causes, HTTP status and provider text/code. |
| 2 | Connection diagnostics preserve formatting and survive API/store validation. |
| 3 | Authentication/model/billing classification no longer replaces provider explanations. |
| 4 | Failed status commands are distinguished from a definite logged-out response. |
| 5 | Explicit terminal errors cannot become successful Connection checks, even with exit code zero. |
| 6 | Provider diagnostics survive host/worker IPC, Run settlement and resume. |
| 7 | Headless failure and step evidence retain the safe diagnostic. |
| 8 | Unknown internal errors use authored messages in probes, Runs, the review bridge and AWS CLI handlers. |
| 9 | Each runner removes its actual resolved credentials, including custom environment bindings. |
| 10 | Repository-tool errors retain useful relative-path guidance without raw filesystem errors. |
| 11 | ECS placement failures retain diagnostics and fail the queue item instead of acknowledging success. |
| 12 | AWS adapters classify service exceptions before the API boundary. Existing authorization and expected not-found/conflict handling remain. |
| 13 | DynamoDB export failures include FailureCode and FailureMessage. |
| 14 | Cognito OAuth failures retain code, description and HTTP status. |
| 15 | The npm failure record retains complete secret-scrubbed stdout/stderr; failure to start npm has a friendly explanation. |

## Verification

Regression tests use fake providers, mocked AWS services and local worker/HTTP
fixtures. No live provider request, AWS deployment or npm publication is needed.
Tests cover long messages, credential echoes, unknown internal errors, terminal
error events, stored Connection results, worker restart/resume and debugger
evidence. A private candidate rebuild is required to put source changes into the
CLI's bundled packages. Previously generated projects are not rewritten or
silently upgraded.

### Verification recorded on 2026-09-15

- Core: 478 tests passed. The final native-status refinement also passed its
  57 affected tests and an independent 106-test adapter review.
- Application API/UI: 190 tests passed. AWS: 49 tests passed. Repository tools:
  14 tests passed. Provider contracts: 130 passed, 66 explicitly skipped by the
  existing capability matrix.
- CLI/debugger: 464 passed, with one confirmed pre-existing failure excluded
  from the final rerun. Candidate wrapper: 50 tests passed.
- Roadmap: the full suite passed 1,056 tests with one stale assertion expecting
  internal exception text. After correcting that assertion, all 48 affected
  bridge/store tests passed.
- Full project typecheck, private candidate build, candidate package integrity
  and the latest packaged native-auth source check passed.
- Review inventory: 99 OCR-selected files, 63 reviewed for this change and
  36 skipped because they contain only earlier staged feature/acceptance work
  (63.6% of the whole dirty-worktree inventory, 100% of the selected in-scope
  files). Changed tests excluded by OCR's default test filter were reviewed too.

The separate existing failure is
`test/cli/headless-reader-integration.test.ts`, "kills the worker on guarded
reader failure without exposing inspector diagnostics or resuming", line 322.
Its stack-hook canary is written when the test expects no execution. It fails
against both current source and the Git-index baseline, loaded in memory without
reverting the worktree. The error-diagnostics changes did not cause it, and this
audit does not claim that debugger safety check passes. It needs a separate fix.
