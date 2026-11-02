# Durable Workflow Engine

Status: historical engine architecture reference, not a current feature or release checklist. The source and tests define the implementation in this review branch.

## Problem

An ArkiMux workflow can already call several agents and tools, but the current
workflow-specific runtime does not yet preserve each completed step as a reusable
checkpoint, so a stopped process can repeat completed work or an external write
without a clear safety decision.

## Boundary

One execution host starts one complete workflow attempt. The durable workflow
engine runs every step inside that host:

```text
Local process, Lambda, or Fargate
  -> Durable Workflow Engine
       -> Execution Storage
       -> Agent Provider Adapters
       -> Effect/Tool SDK
       -> Connection Resolver
  -> typed workflow result
```

The engine does not send individual steps to Lambda, Fargate, CodeBuild, or
another compute service. A workflow Release selects one execution profile before
deployment and keeps that profile for every attempt. A running workflow never
moves between compute profiles.

`lambda-bounded@1` may be selected only when the declared whole-run compute
maximum is below 600 seconds and every other declared requirement fits the
profile. `fargate-workspace@1` is selected when that compute maximum is 600
seconds or longer, or when any accepted resource or architecture requirement
cannot fit the Lambda profile. Time awaiting a person is excluded from compute
duration. If neither profile fits, publication fails before build or provider
spend. A durable input wait releases the current host; its response schedules
another complete workflow attempt under the same Release and profile. This is
whole-attempt suspension and resumption, not per-step compute dispatch.

## Public workflow contract

Portable workflow source uses the public Workflow SDK
(`local-runtime-sdk`). When it calls an external system, it also uses the public
Effect/Tool SDK (`effect-tool-sdk`). It defines named steps and receives
`WorkflowExecutionContextV1`; it never receives the engine, storage adapter,
compute adapter, or a provider implementation.

```ts
const readWeather = defineStep({
  id: "read-weather",
  input: WeatherInput,
  output: WeatherOutput,
  execute: async (context, input) => {
    return context.effects.call("weather.current", input)
  },
})

const weather = await context.steps.run(readWeather, input)

const advice = await context.steps.run(recommendClothing, {
  weather: weather.output,
  weatherStep: weather,
})
```

The step implementation returns its business output. The engine validates that
output, commits the checkpoint, and returns this versioned envelope to workflow
code:

```ts
interface CompletedStepV1<Input, Output> {
  schemaVersion: 1
  ref: { runId: string; stepId: string }
  input: Readonly<Input>
  output: Readonly<Output>
  execution: {
    status: "completed"
    attemptCount: number
    startedAt: string
    completedAt: string
    elapsedMs: number
  }
  performance: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
  }
  artifacts: readonly ArtifactRefV1[]
  detailsRef?: StepDetailsRefV1
}
```

A later step may receive only `weather.output`, selected execution or performance
fields, or the complete immutable `CompletedStepV1`. Large provider streams, raw
logs, local paths, and other unbounded data stay behind artifact or details
references. A final workflow result remains a separate typed Result contract;
the engine does not copy step diagnostics into the business result.

Local V2 requires named sequential execution and user-input steps. Pure
calculation between step calls remains ordinary deterministic TypeScript.
Bounded parallel branches, bounded dynamic fan-out, general signals, and direct
second-engine adapters require later journeys. The named input contract below
is required Local V2 work; it does not imply that general signals are supported.

## Durable user input and uploads

**2026-09-17 amendment:** new Local V2 invocation work follows
[selected-step invocation](journeys/local-journey@2/input-wait-contract/selected-step-invocation.md):
choose a starting step independently of supplying or deferring its complete
input. This supersedes the requirement for special input steps in that flow.
The earlier API and lifecycle description below remains historical context;
retention, immutable responses, no-compute waiting and safe resume still apply.
The amendment is approved behavior, not implementation acceptance.

A workflow already knows which later agent needs an answer or a file, but an
invocation-only input contract cannot collect that material during the Run, so
the workflow cannot continue through a human decision or upload at that point.

The accepted target API is a dedicated named step, available before any agent
slot, including the first slot or between later slots:

```ts
const supplied = await context.steps.waitForInput({
  id: "review-supplier-evidence",
  title: "Add the supplier evidence",
  form: SupplierEvidenceForm,
  expiresAfter: "24h",
})

const assessment = await context.steps.run(assessSupplier, {
  ...input,
  evidence: supplied.output,
})
```

This is an architecture contract, not a claim that the API is implemented.
`form` carries a stable version, JSON-safe field and file rules, and a typed
output validator. The accepted answer is the output of a
`CompletedStepV1<InputRequestV1, InputResponseV1>`; its input contains the fixed
request definition. Files are immutable references containing an object ID,
media type, byte length, and checksum, never a temporary upload URL or scratch
path. Later steps receive selected answers/references or the complete envelope
using the ordinary step contract. Original invocation input, existing completed
steps, and prior agent inputs never change.

Each request has one stable identity derived from its Run and step ID. Creation
stores its definition/schema version and hash, current revision, title, form,
creation time, and absolute `expiresAt`. The workflow chooses `expiresAfter`,
which must be positive and no longer than 366 days. The deadline is fixed when
the request is first created; replay, draft edits, uploads, and submission
retries do not extend it. An existing Run calendar-expiry policy may impose an
earlier bound and is recorded with the request.

With no accepted response, the engine records the pending request and waiting
Run state, then suspends the whole attempt and releases compute. No agent call
has started for the gated slot. It does not keep a native provider session,
Lambda invocation, Fargate task, or Local worker alive while the person answers.
Pausing a provider in the middle of a call is outside this contract.

Local UI renders the form and upload controls through the Local Run API.
Managed customer backends use the Managed Run API with its existing machine
identity and exact workspace/workflow/environment/Run authorization. They own
their end-user forms and human authorization. The Managed Platform UI remains
an operational projection; it does not become a canonical input/result viewer
or receive a machine client secret.

The target Local Run API routes are below. Managed Run API uses the same payload
semantics under its existing workspace/workflow/environment route and machine
identity; its customer backend supplies the human-facing form.

| Target Local route | Behavior |
|---|---|
| `GET /api/v1/runs/{executionId}/input-requests` | Return authorized pending and accepted/closed requests, their versioned forms and fixed deadlines, and safe read-only submitted response/file-reference history. |
| `POST /api/v1/runs/{executionId}/input-requests/{requestId}/uploads` | Accept bounded multipart data and return a retained immutable attachment reference. Uploading does not submit an answer or resume the Run. |
| `POST /api/v1/runs/{executionId}/input-requests/{requestId}/response` | Validate `submissionId`, fields, and attachment references; atomically accept the response and durable resume work. An identical retry returns the receipt; different content is rejected. |
| `POST /api/v1/runs` | A correction uses normal Run creation with an explicit prior-Run link. It creates a new Run without reusing the previous Run's checkpoints. |

These routes extend the accepted contract; their detailed internal adapter APIs
remain implementation work.

The request and response storage contract is:

- Draft answers and draft uploads may be replaced before submission. Submitted
  bytes are retained and checked against the form's file count, type, size,
  ownership, and checksum constraints before acceptance; accepted references
  cannot later point to different bytes.
- One conditional state transition accepts one immutable validated response
  with its receipt, responder identity, and file references. Submission,
  cancellation, and expiry compare the current request/Run state and revision;
  only one conflicting transition wins. Server time rejects an expired response
  even if the expiry worker has not run. A response retry with the same identity
  and content returns the same receipt; changed content or a different winning
  response is a conflict. A completed response checkpoint stays immutable if a
  later Run cancellation prevents further work.
- Acceptance records durable resume work atomically with the response, or uses
  an equivalent recoverable protocol. A response that arrives while the old
  attempt is still releasing its lease cannot start a concurrent owner or lose
  its wake-up. The scheduler retries the same resume command; fencing allows
  only one live whole-workflow attempt. Restart recovery distinguishes waiting
  for an answer from ready-to-resume work.
- A resumed attempt retains the same Run, workflow/Release version, immutable
  configuration, and execution profile. It replays the workflow from the start,
  reads existing completed checkpoints, completes the answered input step, and
  reaches the next incomplete step. Neither polling nor replay dispatches a
  provider for an unanswered request.
- Cancellation and response expiry are terminal for the pending request and
  stop later workflow work. They do not publish a partial success. Cancellation
  after acceptance still stops a queued or active attempt through the Run's
  normal fenced cancellation path; it does not erase the accepted response.
- A correction after acceptance cancels the active original Run, if any, and
  creates a new Run linked to it. The original request, response, results, and
  effects remain recorded, and the new Run does not reuse old checkpoints.
  Cancellation does not undo external effects, and a new Run must not assume
  those effects are safe to repeat. Branching from a
  previous checkpoint with corrected input is a future prospect, not Local V2
  or Managed V1 behavior.

Request schemas, uploaded files, workflow/Release code, configuration versions,
and their required execution artifacts remain available while the Run can
resume, through completion, cancellation, or expiry and the applicable
retention period afterward. Local source reload and Managed deployment/image
cleanup cannot remove a version still needed by a waiting Run. Draft upload
cleanup is separate and cannot delete accepted or otherwise live references.
Every resumed attempt reconstructs file access from retained objects; scratch
remains disposable.

Suspension is a distinct nonterminal host outcome and a visible waiting Run
status. Engine, host, observability, and result-publication wrappers must not
convert it to failure or success. If implementation uses a control signal to
unwind the workflow, catches must preserve it and `finally` must perform cleanup
only; workflow external effects remain inside durable operations. No success
may be published while an input request remains unresolved.

## Durable checkpoint contract

A step checkpoint is keyed by immutable Run identity and stable `stepId`. It
records the workflow and step definition versions, input hash, state, current
attempt, output or output reference, execution facts, performance, artifacts,
and failure or unknown-outcome information.

The minimum states are:

```text
PENDING -> RUNNING -> COMPLETED
                   -> WAITING_FOR_INPUT -> COMPLETED
                                        -> CANCELLED
                                        -> EXPIRED
                   -> FAILED
                   -> CANCELLED
                   -> OUTCOME_UNKNOWN
```

`OUTCOME_UNKNOWN` is the internal checkpoint state. The public typed reason is
`outcome_unknown`.

The engine follows these rules:

- Claiming a step attempt and completing it use conditional writes. A stale
  attempt cannot overwrite the current attempt.
- `COMPLETED` is immutable. Replay with the same definition and input hash
  returns its stored `CompletedStepV1` without calling the step again.
- A different definition or input under the same Run and step ID fails closed.
- A stopped host may replay the workflow function from the beginning. Completed
  steps return checkpoints; only incomplete work is considered for execution.
- Cancellation prevents later steps from starting and cannot publish a partial
  workflow success.
- Scratch storage is never a checkpoint authority.

The internal Execution Storage port keeps separate logical roles for run state,
step checkpoints, input requests/responses, effect operations, artifacts,
performance, durable resume work, and final results.
The Local composition uses project-local filesystem adapters. Managed
compositions use DynamoDB for conditional state and S3 for retained or large
objects. A later Aurora adapter may implement structured state without requiring
workflow source changes; it does not imply that Aurora replaces object storage
for large artifacts.

## External effects

Exactly one committed step checkpoint does not prove that an external system
performed a write exactly once. A process can stop after the external system acts
but before ArkiMux records completion. Every effect therefore declares one safety
class:

| Class | Required behavior | Automatic recovery |
|---|---|---|
| `read` | Does not change the external system | Retry is allowed within policy |
| `idempotent-write` | The target honors the stable ArkiMux operation ID | Retry may reuse the same ID after adapter conformance passes |
| `reconcilable-write` | The adapter can query the result by stable operation ID | Reconcile first; retry only when the query proves it safe |
| `unsafe-write` | Neither idempotency nor reliable reconciliation exists | Never retry automatically after dispatch may have occurred |

Every effect call receives a stable operation ID derived from the Run and the
workflow-defined operation ID. If an `unsafe-write`, or an unproved write, loses
its outcome after dispatch, the step becomes `OUTCOME_UNKNOWN` and needs an
explicit decision. ArkiMux never converts an unknown outcome to success or
silently repeats it.

The engine may claim:

- one immutable committed completion for a step;
- no re-execution of an accepted completed checkpoint;
- a stable operation ID for every effect;
- no silent retry of an unknown unsafe write.

It may claim an exactly-once business effect only for a separately certified
adapter and external protocol that supplies the required idempotency,
reconciliation, or shared transaction.

An agent call remains a specialized durable operation. Managed execution keeps
the existing `BrokerOperation` schema and `AgentInvocationRef` for provider-call
fencing and ambiguous paid-call recovery. The containing step checkpoint refers
to that operation; it does not replace it. Provider-level retry and provider
idempotency remain Agent Provider capabilities and are not implied by workflow
replay.

## Execution host contract

The internal Execution Host supplies one attempt with:

- immutable Run, Release, configuration, and attempt identity;
- one absolute attempt deadline and finalization reserve, bounded by the
  remaining cumulative Run compute budget;
- the separately recorded request/calendar expiry policy;
- cancellation and termination signals;
- host-controlled bounded scratch paths;
- heartbeat and current-fence access; and
- typed resource-limit and host-failure reporting.

Per-attempt compute limits and the bounded cumulative Run compute budget are
separate from response/calendar expiry. A wait consumes no compute time, and
resuming does not reset accumulated compute use. Lease claims reserve against
the remaining budget and completion, suspension, or recovery settles that
reservation, so retries and crashes cannot grant an unbounded budget. Agent
deadlines preserve operation-persistence and attempt-finalization margins. A
response does not revive an exhausted or expired Run.

The host calls the engine once for the complete attempt. On suspension it
persists that outcome, releases its lease, and cleans scratch before another
attempt can own the Run. The engine does not know whether the host is a Local
process, Lambda, or Fargate. CodeBuild remains a prospect and cannot be selected
by a current workflow manifest.

## Source and extension boundary

All named Local components have readable Apache-2.0 source in
`com-pyvue/arkimux`, but public source and public replacement APIs are different
promises.

Public Local V2 extension contracts are:

- Workflow SDK (`local-runtime-sdk`), including named
  execution/input steps, typed forms and file references, and `CompletedStepV1`; and
- Effect/Tool SDK (`effect-tool-sdk`), including typed effect declarations,
  stable operation IDs, safety classes, and adapter conformance.

These are separate public component boundaries. Local V2 may ship them from one
npm package; a component boundary does not require a separate package.

Public-source Libraries with no customer extension contract in Local V2 are:

- Agent Provider Adapters and their conformance kit;

- the durable workflow engine implementation;
- the Execution Storage port and adapter composition;
- the Execution Host port and host composition; and
- the Connection resolver.

Portable workflow source cannot import these internal boundaries. Local V2 proves
one built-in engine, one Local host, and filesystem execution storage. It does not
promise customer-selectable engines, storage adapters, compute adapters, or
in-flight state migration.

## Conformance

Engine implementations need conditional-claim, immutable-completion, replay, mismatch, cancellation, failure and recovery tests. External-effect guarantees remain distinct from committing an ArkiMux step. Public interfaces do not imply customer-selectable engines or cloud execution hosts.
