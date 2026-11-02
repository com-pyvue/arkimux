# ArkiMux Local

Develop and run durable agent workflows locally. Includes workflow contracts, the execution engine, Local API and UI, CLI, provider adapters, typed result clients and isolated mock debugging.

Requires Node.js 24 or newer. Run `npm ci`, `npm run typecheck`, `npm run build`, and `npm test`. No ArkiMux account or private source is needed. Provider-backed tests are separate and require your own provider access.

Managed hosting and its cloud deployment services are separate. Original errors remain local; usage sharing is optional. See `docs/error-diagnostics.md`.

## Source review branch

This is the initial source migration on `codex/repository-split`, not a tagged or accepted product release. npm publication, final release checks and qualified legal review remain pending.

ArkiMux-authored source is licensed under [Apache-2.0](LICENSE), unless stated otherwise. Third-party components retain their own terms; see [notices](NOTICE), [dependency notices](THIRD_PARTY_NOTICES.md) and [generated project rights](GENERATED_PROJECTS.md).
