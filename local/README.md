# ArkiMux Local

First configure the project’s `.env` as described in its README. From the
project root (the directory containing `.arkimux/project.json`), start Local:

```sh
npm run dev
```

Open the Connections URL printed by the command. The launcher sets up the
workflow developer role automatically; you do not need to create a platform
administrator. A project can register several workflows. Its Run data and
configuration stay under `.arkimux/local/`. Use `npm run dev:stop` to stop
only this project's server.

## Migrate an older project

If Local reports legacy storage or the project uses V1 combined authentication
providers, stop its server and run the pinned CLI from the project root:

```sh
npm run dev:stop
./node_modules/.bin/arkimux local migrate
npm run dev
```

When Local migrates legacy state directories, it keeps a recoverable backup in
`.arkimux/local/legacy-backup/`.

## Provider connections

Workflow repositories should pin every supported CLI execution runtime in
their own development dependencies. Provider preflight resolves an explicit
configured command first, then the repository's `node_modules/.bin`, then the
server process `PATH`. The workflow page reports the selected configuration's
runtime readiness before it allows a run to start, so a missing executable or
CLI-owned authentication session does not reserve a failed run.

Workflow-local runtime composition should use the local authentication registry
so API-key providers created in the portal become available without a server
restart:

```ts
import { createLocalAgentAuthProviderRegistry } from "@com-pyvue/agent-execution-local"
import { createAgentExecutionProviderRegistry } from "@com-pyvue/agent-execution-core"

const authProviders = await createLocalAgentAuthProviderRegistry({
  repositoryRoot,
  providerConfig,
})
const executionProviders = createAgentExecutionProviderRegistry(
  providerConfig,
  authProviders,
)
```

The Authentication page writes local API keys through a dedicated REST API.
Credential definitions are stored under
`.arkimux/local/credentials/definitions` and plaintext values under
`.arkimux/local/credentials/values`. Reusable non-secret runtime bindings are
stored under `.arkimux/local/configuration/agent-auth-providers`. No read-secret
route exists, and Agent Templates and workflow Run Configurations persist only
the selected authentication-configuration ID. Keep `.arkimux/local/` ignored
by Git.

The Authentication Configuration table is a merged catalog. It includes
platform-owned, read-only native sessions together with user-created API-key
bindings. Native-session rows explain the required runtime login, such as
`codex login` or Claude Code `/login`; they are not copied into the local
definition store and cannot be archived by the user.

Automatic workflow readiness remains a non-billable static preflight. The
explicit **Test connection** action goes further: it runs one isolated,
tool-free, short-timeout inference through the selected runtime and auth
binding. That action may consume provider quota. The portal stores and displays
only the latest safe status, timestamp, latency, probe model, and summary. It
does not retain the probe prompt, raw provider stream, temporary artifacts, or
credential value. A successful probe proves connectivity for that binding at
that moment, not access to every model in a workflow configuration.

Local execution hosts resolve repository-pinned `codex`, `pi`, and
`claude` commands from `node_modules/.bin` before falling back to PATH. When a
provider runtime declares an exact required version, preflight rejects a
mismatched binary before a run is created.

Kimi is experimental and is not offered as a Local Connection. See the
[provider compatibility guide](../docs/agent-provider-compatibility.md) for tested configurations.

## Workflow environment

Local requires Node.js 24.0.0 or newer, matching the CLI.
`loadLocalWorkflowEnvironment(projectRoot, declaration)` reads only that
project's `.env` and returns a frozen map containing only declared names.
It does not change `process.env` or fall back to parent files or shell values.
`resolveWorkflowEnvironment(declaration, values)` supports a host that already
has an explicit value map. Declarations contain names, required/secret flags,
and `string` or `url` types; values and defaults are rejected.

Required variables fail before the caller can invoke a workflow. URL variables
must be absolute HTTP(S) URLs without user information. Errors name the variable
but never print its value. Reloading requires another explicit load; no file
watcher is installed. The `secret` flag is metadata, not secure storage.

The server exposes its runtime profile through `/api/v1/ui-configuration`, so
the same compiled frontend can be reused by different hosts. Set
`AGENT_EXECUTION_UI_PROFILE=platform` only when intentionally running the full
local Platform host. A UI profile changes route composition and presentation;
it is not an authorization mechanism.
