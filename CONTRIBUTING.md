# Contributing to ArkiMux Local

Contribution policy adopted 5 November 2026. New public contributions use DCO 1.1
sign-off, without an additional CLA. Other Local responsibility documents remain
under review. Existing history is not rewritten or retrospectively certified.

## Prepare a change

Open a focused issue or describe the problem in a pull request. Keep unrelated
changes separate. Follow [AGENTS.md](AGENTS.md), use Node.js 24 or newer, and run
the documented checks relevant to the change. Tests should use synthetic data;
do not add credentials, real customer data, local Run state or private Platform
source. Never run a paid provider test or change an external system without
separate authorization.

Use documented public package imports for workflow examples. Preserve existing
workflow/runtime contracts and explain any intentional compatibility change.
Contributions are reviewed; submission does not guarantee acceptance or a
maintenance commitment. Read [SECURITY.md](SECURITY.md) for safe reporting. Its
private reporting route still needs confirmation. Do not disclose vulnerabilities
in public issues.

## Licence and certification

Contributions intentionally submitted for inclusion are covered by the contribution
terms in [Apache-2.0](LICENSE), unless an applicable separate agreement says
otherwise. Only submit material you have the right to contribute, including
third-party code and employer-owned work. Keep required attribution and disclose
relevant external source material. AI assistance does not establish ownership
or the right to submit code.

Read the unmodified [Developer Certificate of Origin 1.1](https://developercertificate.org/).
If you can truthfully certify it, sign off each new contributed commit:

```sh
git commit -s -m "Describe your change"
```

Example footer:

```text
Signed-off-by: Jane Developer <jane@example.com>
```

Git uses the committer's configured identity for `-s`. Each commit needs a
sign-off matching its author. Every person named in a `Co-authored-by` trailer
also needs their own matching sign-off. Name/email comparison ignores letter
case and repeated spaces. A forwarding committer's sign-off alone does not
replace the author's certification. Put trailers in the final message block,
not in a quoted example or an embedded patch.

Do not sign for someone else or certify rights you do not have. Before correcting
your own unsigned commit, coordinate with anyone using that branch if the fix
rewrites shared history. No additional CLA is required.

A DCO sign-off is not an ownership assignment or a cryptographic signature.
The name/email becomes public, long-lived commit history. AI assistance does not
remove the contributor's responsibility to have the right to submit the work.
Using ArkiMux without contributing does not require signing anything.

## Pull request check

The `DCO` check inspects every PR-head commit not already in the target base
history. Missing/malformed sign-offs or missing author/co-author certifications
fail it. There is no blanket bot or merge-commit exemption. GitHub's temporary
test-merge commit is not the PR head and is not checked.

The check validates the recorded certification, not legal ownership or personal
identity. Maintainers still review contributions. The trusted base checker reads
Git objects without checking out or executing contributor code. It uses read-only
permissions and needs no extra app or account.

The workflow uses `pull_request` so its result belongs to the PR. Changes to the
workflow itself are part of the proposed contribution and must be reviewed by
maintainers; base-script checkout does not prevent a PR from editing workflow
YAML. Fork workflows may need GitHub's normal maintainer approval before running.

Local check:

```sh
node scripts/check-dco.mjs --base <full-base-commit-id> --head <full-head-commit-id>
```

The workflow becomes available after publication in the target branch. Repository
owners must then make the status check named `DCO` required in protected-branch
or ruleset settings. Source files alone do not activate that merge restriction.
Preserve sign-offs when merging or squashing, and review changes to the checker.
A future merge queue needs its own event wiring before using this PR-only check.
