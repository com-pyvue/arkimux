# Local support and lifecycle

## Community support

For help with Local, open a [public GitHub issue](https://github.com/com-pyvue/arkimux/issues).
Support is best-effort. There is no guaranteed response time, fix, 24-hour
coverage, or maintenance window. Acknowledging an issue is not a promise to fix it.

Use [security reporting](../../SECURITY.md), not a public issue, for private
vulnerability details. Never include credentials, customer data or unreviewed
diagnostics. Send privacy requests to <privacy@arkimux.ai>, not to the issue tracker.

## Versions and compatibility

Local requires Node.js 24 or newer. Use the provider CLI and model configurations
tested with your version. Other combinations may not work. You maintain your
custom adapters and are responsible for testing your application and effects.

## Updates and recovery

Pin dependency versions, back up required Run/configuration data and test upgrades
before relying on them. Follow documented contract/version changes. Do not resume
an interrupted execution against changed definitions unless the runtime explicitly
permits it. Downgrading a package is not a guaranteed way to reverse a persisted
state change or an already executed external effect.

There is no fixed support period or advance-notice interval. Changes to support
do not take away Apache rights already granted. See [LICENSE](../../LICENSE)
for the warranty and liability terms.
