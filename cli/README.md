# ArkiMux CLI

The CLI creates a project with Weather Advisor and Graph Invocation. Each project
pins its own CLI. Use Node.js 24 or newer. From the directory where you created `my-agent-app`, run:

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

If the certificate for `https://wttr.in` has expired, the Weather Advisor effect
can retry over HTTP. New results use payload version `2` and show an
insecure-connection warning only when this fallback is used. Configuring an
HTTP URL directly does not trigger the warning.

If Local reports that your project needs migration, stop its server before migrating:

```bash
npm run dev:stop
./node_modules/.bin/arkimux local migrate
```

Project creation and Local UI
startup do not require provider login. Open the printed **Connections** URL to
set up and explicitly test a Connection; testing may use provider quota.
`npm run weather:run` uses the bundled Codex Run Configuration and requires
an authenticated Codex session. In the Local UI, you can invoke Weather Advisor
with a Run Configuration that uses another supported connection. The server
checks the selected connection before reserving a run and again before agent
execution. It does not copy native login credentials into project storage.

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
Restart Local after editing workflow source or `.env`.

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
If you use `guardProjectSourceEdits` in your own tooling, pass SHA-256 file
hashes from before and after the edits. Without a baseline it returns
`boundary-not-verified`. You do not need this helper to run `npm run validate`.

`create-arkimux@0.1.0-alpha.2` calls `runCreateArkiMuxCli` from
`@com-pyvue/arkimux/create`. It does not contain another generator.

## Debug a workflow

- **Mock debugging with breakpoints:** From a generated project, start `./node_modules/.bin/arkimux debug stdio --project "$PWD"` and use protocol **2**. It runs workflow code in Docker with declared mocks instead of real effects or provider calls. You can set breakpoints, inspect variables, and step into, over, or out. See the [debugger guide](scaffold/.agents/skills/arkimux-workflow-debugger/SKILL.md) and [protocol reference](scaffold/.agents/skills/arkimux-workflow-debugger/references/protocol-v2.md) for requirements, permissions and commands.
- **Running a diagnostic case:** The same command with protocol **1** runs a case and reads saved results; it does not provide interactive stepping or the Docker mock guarantee. Real calls can spend provider quota or cause external effects. See the [V1 session implementation for this revision](https://github.com/com-pyvue/arkimux/blob/1dbbde2158404a3bd0902b0bd53e3c722cc9f920/local/src/headlessDebugger.ts) for the supported requests. Start a new process to switch protocols.
- **Attaching an IDE:** Stop the background server, then launch **ArkiMux Local Debug** in your IDE. Open the address the launcher prints and invoke a Run normally. This executes the real workflow, not a mock session. See the [IDE setup instructions](scaffold/README.md#debug-and-stop).
