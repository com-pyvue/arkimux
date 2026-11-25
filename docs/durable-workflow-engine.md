# Durable workflow execution in Local

Local runs a workflow attempt in one host process. It saves Run state,
checkpoints, and results in the project’s Local storage. Restarting the host
does not make an external call safe to repeat.

## Available in Local

A portable workflow defines named steps and calls external systems through
declared effects. A completed step returns its validated output plus execution
metadata. Pass the output (or just the fields needed) to the next step.
See the [Weather Advisor workflow](../cli/scaffold/workflows/weather-advisor/src/workflow.ts)
and its [weather effect](../cli/scaffold/workflows/weather-advisor/src/weather-effect.ts)
for the imports and signatures used by the starter.

There are two different ways to provide input:

- **When invoking a graph**, select an allowed entry step and supply or defer
  its complete input. Starting at a later step does not run the skipped steps.
  See the [Graph Invocation example and commands](../cli/scaffold/README.md) and
  [invocation validation tests](../test/core/graph-invocation.test.ts).
- **When an executing workflow needs an answer**, a named
  `context.steps.waitForInput` step can suspend the Run. The worker does not
  stay alive waiting for the user. An accepted response resumes the same Run;
  completed steps are not repeated. See the
  [input-step type example](../test/core/input-wait-public-types.ts) and
  [suspend, restart, and resume tests](../test/core/durable-input-workflow.test.ts).

Each input request has a fixed deadline. Uploading an attachment does not
submit the response or resume the Run. When Local accepts a response it records
it against the request; retries cannot replace the accepted answer. Cancellation
or expiry stops further work, and does not turn a partial Run into a success.

A corrected Run is different from a resumed Run: it starts again with new
input and does not undo effects of the original.

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

The [completed step type](../core/src/application/durableWorkflow.ts) includes the
validated input and output, execution timing, performance counters, and artifact
references. It is distinct from the final result returned by the workflow.

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

See the [durable engine tests](../test/core/durable-workflow-engine.test.ts) for
checkpoint replay, stale attempts, and unknown outcomes.

## Design only: replacing the host or storage

The engine separates execution from storage so other hosts and storage
implementations can be built. This is an architecture boundary, not a Local
configuration option: workflow authors cannot select a different engine,
swap the checkpoint store, or migrate a running workflow between hosts.
