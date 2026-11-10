# Security reporting

Draft for owner review, prepared 5 November 2026. A private reporting route and
the first supported release must be confirmed before public release. No private
mailbox or GitHub advisory setting is claimed to be active by this draft.

## Report safely

Do not publish credentials, private source/data or a working exploit in a public
issue. Prepare a minimal report describing the affected version, impact, required
access, safe reproduction steps and any suggested mitigation. Redact supporting
diagnostics. Do not test against other people's installations, accounts or data
without their permission.

Once the owner confirms a private security contact or enables GitHub private
vulnerability reporting, use that route for confidential details. Until then,
contact the repository owner without disclosing the sensitive details publicly
and ask for a private channel. There is no response-time or bounty promise.

## Current Local limits

Local is a development server, not an internet-facing multi-user hosting service.
Keep it bound to loopback; do not expose it through a public tunnel or reverse
proxy without a separately reviewed security design. Protect the OS account and
files. Provider keys entered in Local currently use plaintext mode-0600 files,
not an encrypted production vault. Native CLIs and telemetry use different
credential paths; see [Privacy](docs/legal/PRIVACY-NOTICE.md).

Normal workflows can execute real tools, effects and provider requests. Review
them before invocation. The approved Docker mock debugger has a separate
isolation/mocking boundary; it does not make arbitrary ordinary workflow code
safe. A typed result does not certify the safety or correctness of its contents.

This source candidate has no announced supported stable-release matrix. The
owner must set that matrix before release. This file does not claim an audit,
certification, bug-bounty program or commitment to maintain every historical
version. See the proposed [support policy](docs/legal/SUPPORT-AND-LIFECYCLE.md).
