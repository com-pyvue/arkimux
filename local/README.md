# ArkiMux Local

First configure the project’s `.env` as described in its README. From the
project root (the directory containing `.arkimux/project.json`), start Local:

```sh
npm run dev
```

Open the Connections URL printed by the command. The launcher sets up the
workflow developer role automatically; you do not need an administrator account. A project can register several workflows. Its Run data and
configuration stay under `.arkimux/local/`. Use `npm run dev:stop` to stop
only this project's server.

## Migrate an older project

If Local tells you to run `arkimux local migrate`, stop the project's server
and run its pinned CLI from the project root:

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
CLI-owned authentication session does not reserve a failed run. If a runtime
requires an exact CLI version, a version mismatch also stops Local from
creating the Run.

Workflow-local runtime composition should use the local authentication registry
so API-key providers created in **Connections** become available without a server
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

To use an API key, open **Connections**. Under **Credentials**, choose
**Add credential** and save the key. Then choose **Add connection** and select
that credential.
Credential definitions are stored under
`.arkimux/local/credentials/definitions` and plaintext values under
`.arkimux/local/credentials/values`. Reusable non-secret runtime bindings are
stored under `.arkimux/local/configuration/agent-auth-providers`. No read-secret
route exists, and Agent Templates and workflow Run Configurations persist only
the selected authentication-configuration ID. Keep `.arkimux/local/` ignored
by Git.

In **Connections**, built-in connections are read-only. You can archive and
restore connections you add, including ones that use a native CLI session.
For those connections, ArkiMux stores the connection definition locally;
the provider CLI keeps its own login credentials.

Automatic readiness checks do not send an inference request. If setup checks
pass, **Test connection** tries a minimal, tool-free inference request that may
use provider quota. A missing Codex login, for example, stops the test before
inference. Success confirms the tested connection and model, not every model
in a workflow configuration.

Local keeps the latest test result for each connection. On failure, it may
save and display the provider's redacted message, error code, and HTTP status.
Review those details before sharing them. Local does not keep the test prompt
or raw provider stream in the result.

Kimi is experimental and is not offered as a Local Connection. See the
[provider compatibility guide](https://github.com/com-pyvue/arkimux/blob/main/docs/agent-provider-compatibility.md) for tested configurations.

## Workflow environment

Local requires Node.js 24.0.0 or newer, matching the CLI.
`loadLocalWorkflowEnvironment(projectRoot, declaration)` reads only that
project's `.env` and returns a frozen map containing only declared names.
It does not change `process.env` or fall back to parent files or shell values.
`resolveWorkflowEnvironment(declaration, values)` supports a host that already
has an explicit value map. Declarations contain names, required/secret flags,
and `string` or `url` types; values and defaults are rejected.

Local handles the two kinds of settings differently for portable workflows:

- **Non-secret settings:** Local reads and validates them when it registers the
  workflow. A missing required value prevents registration. URL settings must
  be absolute HTTP(S) URLs without user information. Local saves the values
  with each Run so it can resume with the same settings.
- **Effect secrets:** Local saves only their declared names with the Run. When
  preparing each execution attempt, it reads the values from the project's
  current `.env` for the effect adapters. A missing secret fails the attempt,
  not registration. Marking a value as secret does not encrypt the `.env` file.

The Local UI reads its profile from `/api/v1/ui-configuration`. The profile
controls which screens appear; it does not grant permissions.
