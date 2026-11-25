# Security reporting

[Report a vulnerability privately on GitHub](https://github.com/com-pyvue/arkimux/security/advisories/new).
Sign in and use this form to reach ArkiMux maintainers. Submitting a report
does not create a public issue. There is no promised response time or bounty.

## Report safely

Do not publish credentials, private source/data or a working exploit in a public
issue. Prepare a minimal report describing the affected version, impact, required
access, safe reproduction steps and any suggested mitigation. Redact supporting
diagnostics. Do not test against other people's installations, accounts or data
without their permission.

## Current Local limits

Local is a development server, not an internet-facing multi-user hosting service.
Keep it bound to loopback; do not expose it through a public tunnel or reverse
proxy without a separately reviewed security design. Protect the OS account and
files. Local stores provider keys in plaintext. It requests mode `0600` for new
POSIX key files; migrated files keep their existing permissions. On Windows,
check the file's access control list. Native CLIs and telemetry use different
credential paths; see [Privacy](docs/legal/PRIVACY-NOTICE.md).

Normal workflows can execute real tools, effects and provider requests. Review
them before invocation. The Docker mock debugger has a separate
isolation/mocking boundary; it does not make arbitrary ordinary workflow code
safe. A typed result does not certify the safety or correctness of its contents.

There is no published list of supported stable versions or guarantee that every
historical version receives fixes. See [community support](docs/legal/SUPPORT-AND-LIFECYCLE.md).
These security guidelines do not constitute an audit or certification.
