# Agent Execution local portal

This restricted package runs the local filesystem API and focused workflow
development portal from one Node.js process and one HTTP origin. Its default UI
profile exposes Runs, immutable run configurations, and locally registered
workflows; unrelated platform administration is not mounted.

The directory containing `.arkimux/project.json` is one ArkiMux Project and may
register several workflows. Its raw Local state is isolated beneath
`.arkimux/local/`; a surrounding parent directory has no ArkiMux meaning.

If a repository still has any legacy `.agent-execution-*` state roots, migrate
them explicitly before bootstrap or serve:

```bash
agent-execution-local migrate --repository-root /path/to/workflow-repository
```

The verified file-backed state then lives under `.arkimux/local/` in the
ArkiMux Project. The command retains a recoverable backup under
`.arkimux/local/legacy-backup/`.

Authenticate npm for the `@com-pyvue` scope, then bootstrap a local operator:

```bash
npm exec --package=@com-pyvue/agent-execution-local@next -- \
  agent-execution-local bootstrap \
  --repository-root /path/to/workflow-repository \
  --subject-id local-operator \
  --user-id local-operator \
  --role-family agent-execution-platform-admin \
  --role-preset local-platform-admin
```

Role presets own generic portal permissions while workflow repositories add
only their workflow-specific permissions. Bootstrap keeps role definitions
immutable: when a preset changes, the role family receives a new version and
the local operator is moved from the superseded assignment automatically.

Start the portal:

```bash
npm exec --package=@com-pyvue/agent-execution-local@next -- \
  agent-execution-local serve \
  --repository-root /path/to/workflow-repository \
  --subject-id local-operator
```

Open <http://127.0.0.1:8787>. The server binds to loopback by default. Use
`--hostname` and `--port` to override the listener explicitly.

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
by Git. Run `npm run local:migrate` once when upgrading V1 combined providers.

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

Released Local V2 execution hosts resolve repository-pinned `codex`, `pi`, and
`claude` commands from `node_modules/.bin` before falling back to PATH. When a
provider runtime declares an exact required version, preflight rejects a
mismatched binary before a run is created.

Kimi adapter code is hidden experimental groundwork. Released catalogs,
templates, session rows, and execution-host profiles do not expose it. Kimi is
only a future prospect, not a known journey, public compatibility surface, or
portability promise.

## Local V2 environment foundation

The new Local candidate requires Node.js 24.0.0 or newer, matching the CLI.
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

This helper is tested in isolation. Weather Advisor, start/debug integration,
and agent-process isolation must still pass the Local V2 journey tests.

The server exposes its runtime profile through `/api/v1/ui-configuration`, so
the same compiled frontend can be reused by different hosts. Set
`AGENT_EXECUTION_UI_PROFILE=platform` only when intentionally running the full
local Platform host. A UI profile changes route composition and presentation;
it is not an authorization mechanism.
