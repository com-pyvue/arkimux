# ArkiMux CLI foundation candidate

This unpublished Local V2 candidate generates Weather Advisor. The old
Decision Brief starter remains a separate Local V1 regression fixture.
One ArkiMux project can contain several workflows.
It now pins a project-local CLI and exposes npm lifecycle commands. After the
bootstrap creates the project, use:

```bash
cd my-agent-app
cp .env.example .env
# Set WEATHER_API_URL=https://wttr.in in .env.
npm run dev
npm run weather:run -- --city Istanbul
npm run weather:result -- --run <execution-id>
npm run validate
npm run dev:stop
```

`.arkimux/project.json` is the committed project manifest. Machine-local runs,
configuration, credentials, and process files live under the Git-ignored
`.arkimux/local/` directory.

The Weather Advisor effect alone has a narrowly scoped expired-certificate
fallback for `https://wttr.in`. New results use payload version `2` and display
an insecure-connection warning if HTTP was used. See the
[accepted weather-only amendment](../docs/journeys/local-journey@2/specifications/weather-advisor-expired-certificate-amendment.md).
Shared HTTP, agent-provider, and runtime retry behavior is unchanged.

Projects created by an earlier candidate must migrate before starting:

```bash
arkimux local stop
arkimux local migrate
```

The candidate requires Node.js 24 or newer. Project creation and Local UI
startup do not require provider login. Open the printed **Connections** URL to
set up and explicitly test a Connection; testing may use provider quota.
Running the included Weather Advisor workflow requires an authenticated
Codex session. The server checks it before reserving a run and again before
agent execution. It does not copy the Codex credential into project storage.

`npm run validate` runs TypeScript, the offline and read-only
`arkimux project validate` source check, and project tests. The CLI checks the
project manifest, exact dependency pins and lockfile, lifecycle scripts, literal
`workflowDeclarations` and optional `rendererDeclarations`, workflow manifests,
and supported imports. It prints each workflow's mode, contract version and
manifest digest. It never executes project source, reads `.env` values, starts
the server or contacts a provider. TypeScript and project tests are separate
commands in `npm run validate`; they are not part of that read-only guarantee.

Each workflow keeps its manifest, validators, effects and names-only environment
declaration under `workflows/`. The two registries name those files and exports.
Use the public manifest constructors from `@com-pyvue/agent-execution-core`.
Local startup checks that loaded registrations match the declared manifests,
validators, result identities and agent slots. Native registrations use
`withLocalWorkflowDeclaration`; this does not add a native framework runner.
That helper installs the declared input validator as the registration's actual
`validateInput` function; the old validator is not called. Its binding includes
the names-only environment declaration and its source file.
For a manifest-backed portable workflow, pass `environmentFile` from the static
declaration. Local compares it with `environment` before reading `.env` or calling
the factory. Publication also checks the payload's `schemaVersion` against
`resultSchemaVersion` (default 1); mismatches fail without rewriting the result.
Startup validates workflows first, then validates and loads optional renderers
separately. A broken renderer leaves original JSON results available;
`arkimux project validate` still reports its error.

While Local runs, `createProjectResultViewSource` uses pinned Vite 7.3.6 to
watch and reload the renderer registry, imported components and CSS. It retains
the existing `LocalResultView.render(payload)` HTML contract. Vite runs in
middleware mode without another listening port and does not load project Vite
configuration, PostCSS configuration, or `.env`. The Local UI checks a renderer
revision once per second and refreshes changed views in the existing sandboxed
iframe. It does not reset navigation or restart the API. Invalid saves remove
the optional view, keep JSON available, and recover automatically after a valid
save. Runtime render exceptions show JSON; no raw module error is sent to the UI.
Workflow registry hot reload is a separate task; workflow and `.env` edits still
require restart.

CSS-module bindings are treated as style data, not TypeScript source. Nested
stylesheets (`@import`, module `composes`/`@value`, and ICSS `:import`) must use
literal relative `.css` paths under `src/` or `workflows/`. The same real-path,
1 MiB per-file and 512-file project checks apply before Vite processes them.
Escaped paths, resolver aliases and external stylesheet imports are rejected.

The source checker is conservative, not a JavaScript sandbox. Unsupported or
computed imports fail validation. Portable workflow orchestration uses typed
effects for network work and Run Configurations for runtime/model choices.
Native SDK imports and JSON configuration bindings must be declared explicitly.
Static step-constructor aliases and re-exports retain their capability checks.
Declared effects retain their effect policy when imported from workflow code.
Schema fields such as `z.object({ model: z.string() })` and data passed to the
schema's `parse` are allowed. Unclassified fixed bindings, including shorthand
and computed fields, are rejected rather than assumed portable.
The public `guardProjectSourceEdits` compares caller-supplied SHA-256 inventories;
the customization harness must capture the complete baseline and final inventory.
A missing baseline reports `boundary-not-verified`, never success.

`create-arkimux@0.1.0-alpha.2` delegates to this CLI's public
`runArkiMuxCli` function. It does not contain another generator.

Neither package is published. Use the Local V2 bootstrap smoke runner to test
their exact versions through a temporary local registry. The generated project
installs the exact CLI version; it does not link back to the bootstrap or this
checkout. The accepted Local V1 alpha.7 artifact is unchanged.

From this repository, run `npm run journey:local-v2:bootstrap` under Node.js
22.19 or newer. It builds and packs both candidates, uses empty npm credentials
and separate caches, creates a project, checks a fresh `npm ci`, and verifies
the project-local CLI, offline validation, and owned start/stop lifecycle. It
makes no provider calls. Logs and its partial proof go to
`.codex-temp/local-v2-bootstrap/`.

Run `npm run journey:local-v2:bootstrap:v1-regression` to repeat the complete
Decision Brief start, run, included-reader, independent-reader, inspect,
and stop path through the same packed artifacts. It adds the preserved V1 source
fixture to a disposable generated project; Weather Advisor remains the default.
This command uses the existing
Codex Native Session and may consume provider quota; it never publishes a
package.

Run `npm run journey:local-v2:connections` to add packed Local startup and
blocked-run checks. In its disposable generated project it holds the Codex
binary link and substitutes missing or fake logged-out executables. It starts
and stops only its own Local servers and makes no real provider calls. Proof
and logs go to `.codex-temp/local-v2-connections/`.

Run `npm run journey:local-v2:weather` for a clean packed-project Weather proof:
install/validate, required environment, actual fixture weather URL, two fake
agent calls, normal/debug parity, restart-only environment changes, result HTML,
and renderer registry/component/CSS hot updates, invalid-save JSON fallback,
repair, and unchanged server PID/address. No live model calls are made. This
HTTP smoke is not a browser visual check.

Use `npm run dev:debug` in the project to attach a Node debugger at
`127.0.0.1:9229`. Stop/start after workflow or `.env` edits.

This is not a Local V2 release. Release-filtered Connection catalogs, all-four
provider conformance, broader public extension/reload checks, and public-source
distribution proof are still required.

## Diagnostic case runner (current implementation)

This command runs cases and reads saved evidence. It does not yet support
breakpoints, stepping or live variables. Those are proposed in the
[live debugger contract](../docs/journeys/local-journey@2/headless-execution/debugger-contract.md)
and must not be inferred from the current command's name.

`arkimux debug stdio --project /absolute/project/path` opens the JSON-lines
diagnostic interface. It does not start the Local HTTP server or attach an IDE.
The client creates a finite session, runs cases, reads saved evidence and closes
the process. A session requires explicit execution and data-disclosure consent;
real workflows can consume provider quota and produce external effects.

The default per-case active budget comes from the workflow manifest. A session
may select `executionBudgetMs`; increases require separate
`increaseExecutionBudget: true` authorization. Waiting for human input does not
spend active time. Reopening preserves the Run, budget and completed history.

See the [V1 protocol contract](../docs/journeys/local-journey@2/headless-execution/diagnostic-runner-contract-v1.md)
and [no-provider walkthrough](../scripts/fixtures/headless-debugger/README.md).
Diagnostic Runs are isolated from normal Local UI Runs. The proposed human
Debug button is not part of this interface.
