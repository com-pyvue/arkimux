import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { JsonValue, RunApiClient, RunDetailResponseDto, WorkflowDto } from "@com-pyvue/agent-execution-run-contract";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Field, FormValidation, Textarea, fieldError } from "@com-pyvue/agent-execution-ui";
import { runQueryKeys, useRunInput, useWorkflows } from "./queries.ts";

type Action = "cancel" | "correct";

export function RunCorrectionActions(props: {
  client: RunApiClient;
  response: RunDetailResponseDto;
  renderRunLink?(executionId: string, label: ReactNode): ReactNode;
  onRunSubmitted?(executionId: string): void;
}) {
  const [action, setAction] = useState<Action>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [inputText, setInputText] = useState("");
  const [localError, setLocalError] = useState<unknown>();
  const queryClient = useQueryClient();
  const { run } = props.response;
  const active = activeRun(run.status?.status);
  const input = useRunInput(props.client, run.runRef.executionId, action === "correct");
  const workflowCatalog = useWorkflows(props.client, action === "correct" && input.data?.input === null);
  const workflow = workflowCatalog.data?.items.find((item) => item.workflow.kind === run.workflow.kind
    && item.workflow.version === run.workflow.version);
  useEffect(() => {
    if (action === "correct" && input.data) setInputText(input.data.input === null ? "" : JSON.stringify(input.data.input, null, 2));
  }, [action, input.data]);
  const refreshOriginal = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(run.runRef.executionId) }),
      queryClient.invalidateQueries({ queryKey: runQueryKeys.inputRequests(run.runRef.executionId) }),
      queryClient.invalidateQueries({ queryKey: runQueryKeys.root }),
    ]);
  };
  const cancel = useMutation({
    mutationFn: () => props.client.cancelRun(run.runRef.executionId, { acknowledgement: "external-effects-not-undone" }),
    onSuccess: async () => { close(); await refreshOriginal(); },
  });
  const correct = useMutation({
    mutationFn: async () => {
      if (!run.runConfiguration) throw fieldError("runConfigurationId", "The original Run has no reusable Run Configuration.");
      let nextInput: JsonValue;
      try { nextInput = JSON.parse(inputText) as JsonValue; }
      catch { throw fieldError("input", "Enter valid JSON."); }
      return props.client.submitRun({
        workflow: run.workflow,
        roleId: run.actor.roleId,
        runConfigurationId: run.runConfiguration.configurationId,
        input: nextInput,
        correction: {
          priorRunRef: run.runRef,
          activeOriginal: active ? "cancel" : "reject",
          acknowledgement: "new-run-from-start-effects-not-undone",
        },
      });
    },
    onSuccess: async ({ runRef }) => {
      close();
      await refreshOriginal();
      props.onRunSubmitted?.(runRef.executionId);
    },
  });
  const close = () => {
    setAction(undefined);
    setAcknowledged(false);
    setLocalError(undefined);
    cancel.reset();
    correct.reset();
  };
  const submitCorrection = (event: FormEvent) => {
    event.preventDefault();
    if (!acknowledged) { setLocalError(fieldError("acknowledgement", "Confirm the correction warning.")); return; }
    setLocalError(undefined);
    correct.mutate();
  };
  const link = (executionId: string) => props.renderRunLink?.(executionId, executionId) ?? <code>{executionId}</code>;
  const correctionLinks = props.response.correction || props.response.correctedRuns.length > 0
    ? <section className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm" aria-label="Run correction links">
      {props.response.correction ? <p>Corrects {link(props.response.correction.priorRunRef.executionId)}</p> : null}
      {props.response.correctedRuns.map(item => <p key={item.correctedRunRef.executionId}>Corrected by {link(item.correctedRunRef.executionId)}</p>)}
    </section>
    : null;
  return <div className="mb-4 space-y-3">
    {correctionLinks}
    <div className="flex flex-wrap gap-2">
      {active ? <Button variant="outline" onClick={() => open("cancel")}>Cancel run</Button> : null}
      <Button variant="outline" disabled={!run.runConfiguration} onClick={() => open("correct")}>Start corrected run</Button>
    </div>
    {!run.runConfiguration ? <p className="text-sm text-muted-foreground">A corrected Run needs the original Run Configuration reference.</p> : null}
    {action === "cancel" ? <Dialog open onOpenChange={open => { if (!open && !cancel.isPending) close(); }} aria-labelledby="cancel-run-title">
      <DialogHeader><DialogTitle id="cancel-run-title">Cancel this Run?</DialogTitle></DialogHeader>
      <DialogContent className="space-y-4">
        <Warning active>Cancellation stops future work and closes pending input requests. It does not undo provider calls, messages, files, or other external effects already produced.</Warning>
        <Acknowledgement checked={acknowledged} onChange={setAcknowledged}>I understand that earlier external effects are not undone.</Acknowledgement>
        {cancel.error ? <ErrorNotification description={message(cancel.error)} /> : null}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={cancel.isPending} onClick={close}>Keep running</Button><Button disabled={!acknowledged || cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending ? "Cancelling…" : "Cancel run"}</Button></div>
      </DialogContent>
    </Dialog> : null}
    {action === "correct" ? <Dialog open onOpenChange={open => { if (!open && !correct.isPending) close(); }} aria-labelledby="correct-run-title">
      <DialogHeader><DialogTitle id="correct-run-title">Start a corrected Run</DialogTitle></DialogHeader>
      <DialogContent className="space-y-4">
        <Warning active={active}>The original Run's accepted input and history stay unchanged. This creates a linked new Run from the beginning, may repeat provider calls, and does not undo earlier external effects.{active ? " The active original Run will be cancelled first." : " The original Run stays available."}</Warning>
        {input.isPending ? <p>Loading original input…</p> : input.error ? <ErrorNotification description={message(input.error)} /> : <FormValidation fallbackField="input" error={localError ?? correct.error}><form noValidate className="space-y-4" onSubmit={submitCorrection}>
          <Field name="input">New starting input<Textarea className="min-h-64 font-mono text-xs" value={inputText} onChange={event => { setInputText(event.target.value); setLocalError(undefined); }} /></Field>
          {input.data?.input === null ? <section className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm" aria-label="Workflow example">
            <p>This Run has no accepted starting input. Use the workflow example or enter a new input. Either becomes the new Run's input; the original Run remains unchanged.</p>
            {workflowCatalog.isPending ? <p className="text-muted-foreground">Loading workflow example…</p> : null}
            {workflowCatalog.error ? <ErrorNotification description="The workflow example could not be loaded. Enter a new input manually." /> : null}
            {!workflowCatalog.isPending && !workflowCatalog.error && !workflow ? <p className="text-muted-foreground">No workflow example is available. Enter a new input manually.</p> : null}
            {workflow ? <Button type="button" variant="outline" onClick={() => {
              setInputText(JSON.stringify(workflowExampleInput(workflow), null, 2));
              setLocalError(undefined);
            }}>Use workflow example</Button> : null}
          </section> : null}
          <p className="text-xs text-muted-foreground">Run Configuration: <code>{run.runConfiguration?.configurationId}</code>. Edit this copy; the original input is never changed.</p>
          <Field name="acknowledgement"><Acknowledgement checked={acknowledged} onChange={value => { setAcknowledged(value); setLocalError(undefined); }}>I understand this is a new Run from the beginning and earlier external effects are not undone.{active ? " Cancel the active original Run first." : ""}</Acknowledgement></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={correct.isPending} onClick={close}>Cancel</Button><Button type="submit" disabled={!acknowledged || correct.isPending}>{correct.isPending ? "Starting…" : "Start corrected run"}</Button></div>
        </form></FormValidation>}
      </DialogContent>
    </Dialog> : null}
  </div>;

  function open(next: Action) {
    setAcknowledged(false);
    setLocalError(undefined);
    setAction(next);
  }
}

function workflowExampleInput(workflow: WorkflowDto): JsonValue {
  if (workflow.invocationModel !== "graph-entry") return workflow.inputExample;
  return {
    schemaVersion: 1,
    acquisition: "supplied",
    entry: { kind: "default" },
    values: { entry: workflow.inputExample },
  };
}

function Warning({ active, children }: { active: boolean; children: ReactNode }) {
  return <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"><strong>{active ? "Active Run warning." : "Correction warning."}</strong> {children}</p>;
}

function Acknowledgement(props: { checked: boolean; onChange(value: boolean): void; children: ReactNode }) {
  return <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={props.checked} onChange={event => props.onChange(event.target.checked)} /><span>{props.children}</span></label>;
}

function activeRun(status: string | undefined): boolean {
  return status !== undefined && !["complete", "failed", "cancelled"].includes(status);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "The Run action failed.");
}
