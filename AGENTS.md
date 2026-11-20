# ArkiMux Local source instructions

Use Node.js 24 or newer. Preserve workflow SDK and Local runtime behavior.
Shared contracts live in this public repository. Do not add dependencies on
private Managed code, private registries, roadmap records or acceptance evidence.
Use synthetic fixtures for tests. Never commit credentials or local runtime state.
Do not publish packages or change remotes without explicit owner approval.

## Recording a contributor's DCO sign-off

For commits to `com-pyvue/arkimux`, use only the opt-ins on the current upstream
`main` (fetch main from the verified upstream, then read
`git show FETCH_HEAD:.github/dco-opt-ins.yml`). Do not use the working tree,
the PR head, CODEOWNERS, or Git author settings as proof of permission.

When an enrolled contributor explicitly asks you to commit as them, use
`git commit -s` if the requester is known to be that contributor and both the
author and sign-off name/email match their entry. A configured Git identity
alone does not identify the requester. If identity, rights, or enrollment is
unclear, stop and ask. Without an active entry, obtain certification for the
specific changes. Never add a co-author's sign-off on their behalf.
Before pushing, run the [existing PR-range DCO check](CONTRIBUTING.md#pull-request-check).
A commit request is not permission to push.
