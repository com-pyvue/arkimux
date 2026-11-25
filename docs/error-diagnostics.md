# External and internal error diagnostics

When a provider fails, Local shows its explanation after removing credentials.
When ArkiMux itself fails, Local shows a short message rather than exposing the original exception.

## What you see

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
provider runners, storage or engine implementations.
See the [Weather Advisor effect](../cli/scaffold/workflows/weather-advisor/src/weather-effect.ts) for an example.

## Inspect or share a Local diagnostic

Open **Settings → Diagnostics**, select a framework failure, and choose **Inspect**.
The original record stays on your computer; it can include a stack trace, paths,
or other private details. Provider and workflow failures are not collected on
this page. They are reported where the operation failed, such as Connections or a Run.

Copying or downloading a diagnostic does not send it anywhere. **Report an issue**
opens a public GitHub form without attaching the record. If you choose to share
details, remove credentials, private paths, workflow content, and anything else
you do not want to publish. For retention, deletion, and usage sharing, see the
[Local privacy notice](legal/PRIVACY-NOTICE.md). For a suspected vulnerability,
use [private security reporting](../SECURITY.md) instead.
