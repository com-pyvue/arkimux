---
name: arkimux-workflow-debugger
description: Diagnose and verify ArkiMux workflow logic with the Docker Mock Live Debugger when a developer asks to debug, investigate, step through, or explain unexpected workflow behavior.
---

# ArkiMux workflow debugger

Use the Docker Mock Live Debugger for workflow-code diagnosis. It executes a
retained workflow build only inside an isolated container with declared mocks.
It does not create a normal Run or prove a real provider integration.

Read [the V2 protocol reference](references/protocol-v2.md) before controlling a
session. Use the project-local `arkimux` binary so the protocol matches this
project's pinned version.

## Confirm the case

Before starting:

1. Read the workflow declaration, input and result schemas, graph, effect and
   agent-slot operation IDs, fixtures, and relevant tests.
2. Identify one bounded input, the developer-supplied expected result, and a
   declarative mock result or error for every dependency the case will reach.
3. If the expected business result or a required mock response is missing or
   ambiguous, ask the developer. Do not invent either one.
4. Obtain explicit authorization for project-code execution, workflow-data
   disclosure, live-state disclosure, and simulated evaluation unless the
   current request already grants all four.

Never place credentials, provider sessions, environment secrets, executable
mock code, real file paths, or real network targets in the manifest.

## Diagnose

1. Run `npm run validate` before editing so existing failures are visible.
2. Start a persistent process from the project root:

   ```sh
   ./node_modules/.bin/arkimux debug stdio --project "$PWD"
   ```

3. Send one protocol-V2 `session.create` request first. Use a unique session ID,
   the registered workflow and Run Configuration IDs, `stopOnEntry: true`, the
   confirmed case, declared mocks, expectations, and all four authorization
   acknowledgements.
4. Run the case. At the entry pause, inspect the input and retained source before
   choosing breakpoints. Form a specific hypothesis from the observed state.
5. Set source breakpoints against the current debugger revision. Continue,
   inspect the workflow stack and scopes, and use step `into`, `over`, or `out`
   to narrow the cause.
6. Use bounded evaluation or temporary variable mutation only to test a
   hypothesis. A mutation changes simulated state; it is not a code fix and its
   resulting output is not final verification.
7. Continue the unmodified case to terminal evidence when useful. Compare the
   simulated output with the developer-supplied expectations.
8. Close the session. If code changes are authorized, edit public project files,
   increment affected definition versions when behavior changes, and start a
   fresh session. A retained session never picks up later source edits.
9. Verify the fix without temporary mutation, then rerun `npm run validate`.

Use only the handles and revisions returned by the current pause. A continue or
step expires its pause, frame, scope, and object handles. Inspect again instead
of retrying stale identifiers.

## Stop safely

- If Docker or an isolation check fails, stop and report `debugger_unavailable`.
  Never fall back to executing workflow code on the host.
- If an undeclared dependency returns `unsupported_mock_dependency`, identify
  its stable operation ID and ask for the missing mock when its value is not
  already specified.
- If workflow code directly accesses network, credentials, host files, child
  processes, workers, native addons, FFI, or WASI, report the blocked dependency.
  Do not weaken the sandbox.
- Close the session on success, failure, cancellation, or abandonment. Report
  cleanup as unconfirmed if the close acknowledgement is unavailable.

## Report

Give the developer a short diagnosis containing:

- workflow, configuration, case, retained source, and image identities;
- supplied input, expectations, and mock operation IDs without secrets;
- observed breakpoint locations and relevant changing values;
- root cause and the exact project-code change, if authorized;
- simulated actual versus expected result before and after the fix;
- `npm run validate` result;
- session/container cleanup result; and
- explicit limits: no real provider, integration, external-effect, billing, or
  business-correctness proof.
