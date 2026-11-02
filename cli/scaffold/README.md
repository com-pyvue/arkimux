# ArkiMux Local examples

This self-contained ArkiMux project includes two workflows:

- **Weather Advisor** reads current weather, asks one agent to recommend
  clothing, and asks a second agent to critique that recommendation.
- **Graph Invocation** is a deterministic, no-provider fixture for trying
  supplied or deferred input at Step 1, Step 2, and one ordered-map item. It
  also demonstrates branch/join, loop, ordered map, and accumulator reduce.

The workflows are yours to edit. No Platform checkout is needed.

Requires Node.js >=24.0.0 and npm 10.9.3. All dependencies are pinned.
This is a private candidate, not a public release.

## Configure and start

```bash
cp .env.example .env
```

Set `WEATHER_API_URL=https://wttr.in` in `.env`, then:

```bash
npm run validate
npm run dev
```

The URL is required; there is no built-in default URL. Startup reads one snapshot
of `.env` and passes only declared variables to the weather effect. The URL is
not passed to agent processes, prompts, results, or run artifacts. Keep `.env`
out of Git. Restart after changing it.

Open the printed Connections URL. The default Run Configuration uses your
existing Codex Native Session. Log in with `codex login` if needed; provider
readiness is checked before a run, not when opening the UI. Connection tests and
workflow agent calls may consume provider quota. No login credential is copied
into the project. Edit runtime/model choices in the Run Configuration, not in
the portable workflow source.

## Run and inspect

```bash
npm run weather:run -- --city Istanbul
npm run weather:result -- --run <execution-id>
```

Weather Advisor is a declared graph: Read weather → Recommend clothing →
Critique clothing → Assemble result. Open its **Workflow diagram** to inspect
the same nodes and dependencies used by execution. The final node only assembles
the result; there are still one weather request and two agent operations.
`weather:run` supplies the city to the default graph entry. The Local UI also
offers supplied or deferred input and starting at later steps with their complete
required inputs. Prompts and the weather environment are pinned in the retained
build by `workflows/weather-advisor/src/construction.ts`.

The reader waits for completion and validates the typed Weather Advisor result.
Use the Local UI Results tab for the project-owned React view or the original
JSON. A missing, broken, or incompatible renderer does not remove the JSON.
A `needs-review` critique remains visible; it does not silently replace the
recommendation or turn a valid result into a failed run.

### Try graph entry modes without provider quota

Each entry accepts input immediately or waits on the same Run for input later:

```bash
npm run graph:run -- --entry step1
npm run graph:run -- --entry step1 --deferred
npm run graph:run -- --entry step2
npm run graph:run -- --entry step2 --deferred
npm run graph:run -- --entry map-item-1
npm run graph:run -- --entry map-item-1 --deferred
```

The command prints the Run ID and exact next command. For deferred input, use:

```bash
npm run graph:answer -- --run <execution-id>
npm run graph:result -- --run <execution-id>
```

You may stop and restart Local before `graph:answer`; the answer resumes the
same Run. Step 2 direct entry uses the supplied Step 1 input and output without
executing Step 1. The map-item fixture explicitly targets item index 1 and
supplies its required scoped control state. See
`workflows/graph-invocation/fixtures/` for the exact non-sensitive values.

Weather reads normally use one bounded GET. Only this demo's weather effect
may retry once over HTTP when the HTTPS request to `wttr.in` fails with
`CERT_HAS_EXPIRED`. Other hosts, custom ports, credential-bearing URLs, other
errors, and redirects do not trigger a retry. Both requests share the same
10-second deadline and cancellation; the response limit stays 256 KiB.
The Results view displays an explicit insecure-connection alert when fallback
was used, and the JSON preserves it in `weather.transportWarning`. HTTP weather
can be intercepted or altered; this is a demo exception, not a production
transport policy. No agent provider or other effect inherits this retry.
New results use payload version `2`; the result reader still accepts old
version `1` results, which remain available as original JSON.

Invalid weather stops before either agent; invalid recommendation stops before
critique. Three named steps preserve completed outputs for recovery.

## Debug and stop

```bash
npm run dev:stop
```

Select **ArkiMux Local Debug** in your IDE and click **Debug**. Use Node 24
or newer. VS Code/Cursor use `.vscode/launch.json`; WebStorm uses the saved `.run`
configuration (enable **Attach to subprocesses automatically** in its Node.js
debugger settings). The launcher stays alive and prints the API and UI address.
Set breakpoints in workflow TypeScript, then submit Runs normally in the UI/API.
Breakpoints, variables and stepping appear in the IDE, not in the Local UI.

Debugging automatically uses a free local port; open the address printed by the
launcher. `arkimux local debug --port 8788` requests that exact port and fails if
it is occupied. Normal `local start` still defaults to port 8787.

The command behind this configuration is `arkimux local debug` (`npm run
dev:debug` inside an IDE debug session). It requires the IDE's child-process
debugger. Stop the IDE session to stop its server and attempt workers. Normal
`npm run dev` still starts a background server. For manual server-only attachment,
`arkimux local start --inspect-port 9229` remains available; it is not the
automatic retained-worker debug mode.

Normal and debug start use the same registry and `.env` loader. Restart after
source or environment changes. Retained Runs execute their original build;
if a source file has changed, the debugger opens the retained source instead of
binding it to the edited file. Run deadlines still apply while paused. Debugger
settings are not passed to native agent processes.

```bash
npm run dev:stop
```

ArkiMux owns server startup, recovery and shutdown. The project contains workflow
declarations and source, not server integration code.

This stops only this project's server. Run data stays under ignored
`.arkimux/local/`.

## Edit the project

- `src/arkimux.workflows.ts`: workflow registry and Local registration.
- `workflows/weather-advisor/src/`: portable steps, effect, and typed contracts.
- `workflows/graph-invocation/src/`: graph, callable steps, controls, and result contract.
- `workflows/weather-advisor/prompts/`: repository-owned agent instructions.
- `workflows/weather-advisor/run-configurations/`: runtime/model bindings.
- `src/arkimux.renderers.tsx`: optional project-owned result views.

Run `npm run validate` after edits. It typechecks, checks the project package and
registry structure, and runs deterministic tests without provider calls.
Broader public extension validation and release checks are tracked separately.
