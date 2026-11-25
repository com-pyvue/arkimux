# External and internal error diagnostics

When a provider fails, Local redacts known credential values and common secret
patterns from its error message. Other sensitive details may remain. Review
the message before sharing it.
When ArkiMux itself fails, Local shows a short message rather than exposing the original exception.

## What you see

- For a provider failure, Local shows the provider’s redacted explanation and,
  when available, its error code and HTTP status. The explanation can include
  suggested options, public links and request IDs, but not terminal control sequences.
- The diagnostic comes from the reported error, not unrelated assistant output
  or the entire request or response.
- For an unexpected ArkiMux failure, the action shows a short framework message,
  not the original exception or stack trace.
- A shortened debugger response points to saved failure evidence containing the
  complete redacted diagnostic. Storage does not silently shorten provider messages.

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
origin from the wording of an arbitrary exception. Pass known credential values
in `secretValues` so they are redacted along with recognized patterns before
the error leaves the adapter or is stored.

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
