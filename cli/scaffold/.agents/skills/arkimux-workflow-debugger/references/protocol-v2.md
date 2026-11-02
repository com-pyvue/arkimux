# ArkiMux Docker Mock Live Debugger protocol V2

Use this reference only through the project-local command:

```sh
./node_modules/.bin/arkimux debug stdio --project "$PWD"
```

Keep that process open. Standard input accepts one UTF-8 JSON request per line;
standard output returns one JSON response or event per line. Diagnostics use
standard error. The first valid request selects protocol V2 for the process.

## Envelope

Every request has exactly these fields:

```json
{"schemaVersion":2,"id":"unique-request-id","method":"session.inspect","params":{}}
```

Successful responses have `schemaVersion`, the same `id`, `ok: true`, and
`result`. Failures have `ok: false` and an `error` containing `code`, `message`,
and `retry`. A `session.changed` event may arrive between responses. Match
responses by `id`, not by line position.

Request IDs must be unique while outstanding. Reuse a control ID only when
retrying the identical control request. A changed request needs a new control
ID. Each line and response is limited to 1 MiB.

## Create manifest

`session.create` must be the first request. Its parameters have this shape:

```json
{
  "manifest": {
    "schemaVersion": 2,
    "sessionId": "debug-example-1",
    "workflowId": "example",
    "configurationId": "example-local-v1",
    "debug": { "stopOnEntry": true },
    "cases": [
      {
        "caseId": "reproduce",
        "input": { "schemaVersion": 1, "value": 10 },
        "mocks": {
          "read-source": { "kind": "result", "value": { "value": 10 } }
        },
        "expectations": [
          { "id": "result", "target": "result", "pointer": "/result", "operator": "equals", "value": 11 }
        ]
      }
    ]
  },
  "authorization": {
    "executeProjectCode": true,
    "discloseWorkflowData": true,
    "discloseLiveState": true,
    "allowSimulatedEvaluation": true
  }
}
```

Use registered workflow and configuration IDs. Identifiers such as session,
case, request, breakpoint, evaluation, and control IDs use lowercase letters,
digits, and hyphens, begin with a letter or digit, and are at most 64 characters.

A mock key is a stable declared operation ID. A fixture is either:

```json
{"kind":"result","value":{"json":"value"},"delayMs":0}
```

or:

```json
{"kind":"error","error":{"code":"mock-error","message":"Declared simulated failure"},"delayMs":0}
```

`delayMs` is optional and cannot exceed 60000. A case supports at most 100 mock
operations. Mock fixtures are JSON only.

Expectations support:

- `{"id":"status","target":"run-status","operator":"equals","value":"complete"}`
- `{"id":"value","target":"result","pointer":"/path","operator":"equals","value":...}`
- `{"id":"present","target":"result","pointer":"/path","operator":"exists"}`

The pointer is a JSON Pointer. A passing expectation proves only the simulated
case against its supplied mocks.

## Methods

The method headings below are checked against the canonical protocol schemas.
All parameter objects reject unknown fields.

### `session.create`

Parameters: `manifest` and `authorization` as above. Repeating the exact request
identity is safe; changing immutable settings under the same session ID fails.

### `session.open`

Parameters: `sessionId`. Opens only the session owned by this still-running
process; it cannot recover a container after the process exits.

### `session.inspect`

Parameters: none. Returns cases, revisions, states, terminal summaries, and
evidence descriptors.

### `case.run`

Parameters: `caseId`. Starts one not-started case. Only one case is active at a
time in the session.

### `case.respond`

Parameters: `caseId`, `requestId`, `submissionId`, positive
`expectedRevision`, and `response`. The response is
`{"schemaVersion":1,"fields":{...},"files":{...}}`. Use only a pending request
returned by this case and never invent human input.

### `case.cancel`

Parameters: `caseId`. Cancels the selected case and retains bounded simulated
terminal evidence.

### `evidence.read`

Parameters: `caseId`, `evidenceId`, non-negative `offset`, and `limit` from 1 to
262144. Decode the returned base64 `data` and follow `nextOffset` until null.

### `session.close`

Parameters: none. Closes the active case and destroys the disposable container.
The protocol process exits after its response.

### `debug.sources`

Parameters: non-negative `offset` and `limit` from 1 to 100. Use the returned
retained `sourceId`; never substitute a current host path.

### `debug.source.read`

Parameters: `sourceId`, non-negative `offset`, and `limit` from 1 to 262144.

### `debug.breakpoints.set`

Parameters: `expectedDebuggerRevision` from `debug.inspect` and `breakpoints`,
an array of at most 100 entries. Each entry requires `breakpointId`, `sourceId`,
positive `line`, and positive `column`; `condition` and `logExpression` are
optional bounded expressions. Sending an empty array clears all breakpoints.

### `debug.inspect`

Parameters: `caseId`. Refreshes the selected case. A paused result supplies the
current `pauseId`, source position, reason, and debugger revision.

### `debug.pause`

Parameters: `caseId`, the running `attemptId`, and `controlId`.

### `debug.continue`

Parameters: `caseId`, current `pauseId`, and `controlId`. Continuing expires all
handles from that pause.

### `debug.step`

Parameters: `caseId`, current `pauseId`, `controlId`, and `kind`, which is
`into`, `over`, or `out`. Stepping expires all handles from the old pause.

### `debug.stack`

Parameters: `caseId`, current `pauseId`, non-negative `offset`, and `limit` from
1 to 100. Inspect workflow frames only; framework-frame scopes are unavailable.

### `debug.scopes`

Parameters: `caseId`, current `pauseId`, and a workflow `frameId` returned by
`debug.stack`.

### `debug.properties`

Parameters: `caseId`, current `pauseId`, an `objectId` returned by a current
scope or property preview, non-negative `offset`, and `limit` from 1 to 100.

### `debug.evaluate`

Parameters: `caseId`, current `pauseId`, current workflow `frameId`, unique
`evaluationId`, and a non-empty expression of at most 4096 characters.
Evaluation may run workflow getters or functions, but only inside the container.

### `debug.variable.set`

Parameters: `caseId`, current `pauseId`, current workflow `frameId`, `controlId`,
JavaScript local variable `name`, and a non-empty expression of at most 4096
characters. This is a temporary simulated-state experiment, not a code change.

## Handle and failure rules

- Inspect again after continue or step; old pause, frame, scope, and object
  handles are stale.
- On `stale_debugger_revision`, inspect and replace breakpoints against the new
  revision.
- On `unsupported_mock_dependency`, add only a developer-confirmed declarative
  mock for that stable operation ID.
- On `debugger_unavailable`, `source_mapping_unavailable`, or an isolation
  failure, stop. Never attach to a host process or weaken the sandbox.
- Always send `session.close`. If the process disconnects first, report that
  cleanup acknowledgement was unavailable.
