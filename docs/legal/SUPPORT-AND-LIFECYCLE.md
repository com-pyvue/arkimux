# Local support and lifecycle

Draft proposal for owner review, prepared 5 November 2026. This is not an adopted
support commitment, paid service contract or SLA. External legal review is a
separate decision.

## Proposed support policy

Provide community, best-effort support through the public project's issue
tracker. Do not promise a response time, resolution time, 24-hour coverage,
priority support, long-term maintenance window, certification or production
readiness. Acknowledging an issue is not a promise to fix it.

Use [security reporting](../../SECURITY.md), not a public issue, for private
vulnerability details. Never include credentials, customer data or unreviewed
diagnostics. Support and security contact routes must be confirmed before release.

## Versions and compatibility

The current source review branch is not an accepted stable release. It requires
Node.js 24 or newer. Follow the exact provider CLI and model configurations tested
for the release you use; that is not a promise that any provider version, model,
account plan or custom adapter will work.

Before a release, publish its exact version, supported/tested configuration list,
known limitations and relevant changes. Distinguish an unsupported combination
from a confirmed product defect. The developer maintains custom adapters and
tests their own application, effects and provider terms.

## Updates and recovery

Pin dependency versions, back up required Run/configuration data and test upgrades
before relying on them. Follow documented contract/version changes. Do not resume
an interrupted execution against changed definitions unless the runtime explicitly
permits it. Downgrading a package is not a guaranteed way to reverse a persisted
state change or an already executed external effect.

Proposed practice: document breaking changes, deprecations and migration steps in
the affected release. No fixed support period or advance-notice interval is
promised by this draft. Existing released Apache rights are not withdrawn by a
later support or service-policy change. See [LICENSE](../../LICENSE) for warranty
and liability terms rather than treating this policy as an additional exclusion.
