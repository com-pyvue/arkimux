import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AgentTemplateApiClient } from "@com-pyvue/agent-execution-agent-template-contract";
import type { ResultRendererRegistry } from "@com-pyvue/agent-execution-result-presentation";
import type { GraphDescriptionDto, JsonValue, RunApiClient, WorkflowDto, WorkflowInvocationEntryDto } from "@com-pyvue/agent-execution-run-contract";
import type { RunConfigurationApiClient, RunConfigurationDefinitionDto } from "@com-pyvue/agent-execution-run-configuration-contract";
import {
  RunConfigurationFeature,
  newestRunConfigurationsFirst,
  useRunConfigurationList,
} from "@com-pyvue/agent-execution-run-configuration-react";
import { Field, FormValidation, Select, fieldError, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogHeader, DialogTitle, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "@com-pyvue/agent-execution-ui";
import { RunFeature } from "./runFeature.tsx";
import type { ConfigurableRunColumnId } from "./runColumns.ts";
import { GraphRequirementField } from "./graphRequirementField.tsx";
import { WorkflowDiagram } from "./workflowDiagram.tsx";

export function WorkflowCatalogFeature(props: {
  runClient: RunApiClient;
  onOpenWorkflow(workflow: WorkflowDto): void;
}) {
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: () => props.runClient.listWorkflows() });
  return <main className="mx-auto max-w-[100rem] space-y-6 p-4 md:p-8">
    <header><h1 className="text-2xl font-semibold">Workflows</h1><p className="text-muted-foreground">Configure and invoke locally registered workflows.</p></header>
    {workflows.isPending ? <p>Loading local workflows…</p> : workflows.error ? <ErrorNotification description={message(workflows.error)} /> : <section className="grid gap-4 lg:grid-cols-2">
      {workflows.data?.items.map((workflow) => <Card key={workflowKey(workflow)}><CardHeader><CardTitle>{workflow.title}</CardTitle><CardDescription>{workflowKey(workflow)}</CardDescription></CardHeader><CardContent className="space-y-3">{workflow.description ? <p>{workflow.description}</p> : null}<p className="text-sm text-muted-foreground">{workflow.agentSlots.length} Agent Slot{workflow.agentSlots.length === 1 ? "" : "s"}</p><Button onClick={() => props.onOpenWorkflow(workflow)}>Open workflow</Button></CardContent></Card>)}
    </section>}
    {!workflows.isPending && (workflows.data?.items.length ?? 0) === 0 ? <Card><CardContent className="p-6">No workflows are registered with this local server.</CardContent></Card> : null}
  </main>;
}

export function WorkflowDetailFeature(props: {
  runClient: RunApiClient;
  runConfigurationClient: RunConfigurationApiClient;
  agentTemplateClient: AgentTemplateApiClient;
  workflowKind: string;
  workflowVersion: number;
  resultRenderers: ResultRendererRegistry;
  backLink?: ReactNode;
  renderRunLink?(executionId: string, label: ReactNode): ReactNode;
  defaultRunColumns?: readonly ConfigurableRunColumnId[];
  tab?: "configurations" | "runs";
  onTabChange?(tab: "configurations" | "runs"): void;
  onRunSubmitted(executionId: string): void;
}) {
  const [invokeOpen, setInvokeOpen] = useState(false);
  const [uncontrolledTab, setUncontrolledTab] = useState<"configurations" | "runs">("configurations");
  const tab = props.tab ?? uncontrolledTab;
  const selectTab = (value: string) => {
    const next = value === "runs" ? "runs" : "configurations";
    if (props.tab === undefined) setUncontrolledTab(next);
    props.onTabChange?.(next);
  };
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: () => props.runClient.listWorkflows() });
  const workflow = workflows.data?.items.find(({ workflow }) => workflow.kind === props.workflowKind && workflow.version === props.workflowVersion);
  const configurations = useRunConfigurationList(
    props.runConfigurationClient,
    { kind: props.workflowKind, version: props.workflowVersion },
    { pageSize: 500, lifecycleStatus: "active" },
  );
  const orderedConfigurations = newestRunConfigurationsFirst(configurations.data?.items ?? []);
  if (workflows.isPending) return <main className="p-8">Loading workflow…</main>;
  if (workflows.error) return <main className="p-8"><ErrorNotification description={message(workflows.error)} /></main>;
  if (!workflow) return <main className="p-8"><ErrorNotification description={`Workflow ${props.workflowKind}@${props.workflowVersion} is not registered.`} /></main>;
  return <main className="mx-auto max-w-[100rem] space-y-8 p-4 md:p-8">
    {props.backLink}
    <header className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card p-5">
      <div className="min-w-0 space-y-2"><div className="flex flex-wrap items-center gap-3"><h1 className="text-2xl font-semibold">{workflow.title}</h1><Badge>v{workflow.workflow.version}</Badge></div><p className="font-mono text-sm text-muted-foreground">{workflow.workflow.kind}</p>{workflow.description ? <p>{workflow.description}</p> : null}</div>
      <div className="text-right"><Button onClick={() => setInvokeOpen(true)} disabled={configurations.isPending || (configurations.data?.items.length ?? 0) === 0}>Invoke Workflow</Button>{!configurations.isPending && (configurations.data?.items.length ?? 0) === 0 ? <p className="mt-2 max-w-xs text-sm text-muted-foreground">Create a Run Configuration before invoking this workflow.</p> : null}</div>
    </header>
    {workflow.invocationModel === "graph-entry" ? <WorkflowGraphOverview workflow={workflow} configurations={orderedConfigurations} runClient={props.runClient} /> : null}
    <Dialog open={invokeOpen} onOpenChange={setInvokeOpen}><DialogHeader><DialogTitle>Invoke {workflow.title}</DialogTitle></DialogHeader><DialogContent>{configurations.error ? <ErrorNotification description={message(configurations.error)} /> : <InvocationForm workflow={workflow} configurations={orderedConfigurations} runClient={props.runClient} onCancel={() => setInvokeOpen(false)} onSubmitted={executionId => { setInvokeOpen(false); props.onRunSubmitted(executionId); }} />}</DialogContent></Dialog>
    <Tabs value={tab} onValueChange={selectTab}>
      <TabsList className="mb-6"><TabsTrigger value="configurations">Run Configurations</TabsTrigger><TabsTrigger value="runs">Runs</TabsTrigger></TabsList>
      <TabsContent value="configurations"><RunConfigurationFeature client={props.runConfigurationClient} agentTemplateClient={props.agentTemplateClient} workflow={workflow} /></TabsContent>
      <TabsContent value="runs"><RunFeature key={workflowKey(workflow)} client={props.runClient} resultRenderers={props.resultRenderers} fixedWorkflow={workflow.workflow} embedded columnPreferenceKey={`workflow:${workflowKey(workflow)}`} defaultColumns={props.defaultRunColumns} renderRunLink={props.renderRunLink} /></TabsContent>
    </Tabs>
  </main>;
}

function WorkflowGraphOverview(props: { workflow: WorkflowDto; configurations: RunConfigurationDefinitionDto[]; runClient: RunApiClient }) {
  const [selectedId, setSelectedId] = useState("");
  const configurationId = props.configurations.find(item => item.configurationId === selectedId)?.configurationId ?? props.configurations[0]?.configurationId;
  const roleId = props.workflow.allowedRoleIds.length === 1 ? props.workflow.allowedRoleIds[0]! : "";
  const description = useQuery({ queryKey: ["workflow-invocation-options", workflowKey(props.workflow), roleId, configurationId],
    queryFn: () => props.runClient.getWorkflowInvocationOptions({ workflow: props.workflow.workflow, roleId, runConfigurationId: configurationId! }),
    enabled: Boolean(configurationId && roleId), retry: false });
  if (!configurationId || !roleId) return <p className="text-sm text-muted-foreground">Create a Run Configuration with an authorized role to view the workflow diagram.</p>;
  return <section className="space-y-3">
    {props.configurations.length > 1 ? <label className="block text-sm">Diagram run configuration<Select value={configurationId} onChange={event => setSelectedId(event.target.value)}>
      {props.configurations.map(item => <option key={item.configurationId} value={item.configurationId}>{item.configurationId}</option>)}
    </Select></label> : null}
    {description.isPending ? <p>Loading workflow diagram…</p> : description.error ? <ErrorNotification description={`Could not load the workflow diagram: ${message(description.error)}`} />
      : description.data?.model === "graph-entry" && description.data.graph ? <WorkflowDiagram graph={description.data.graph} /> : <p className="text-sm text-muted-foreground">This workflow does not provide a graph description.</p>}
  </section>;
}

function InvocationForm(props: { workflow: WorkflowDto; configurations: RunConfigurationDefinitionDto[]; runClient: RunApiClient; onCancel(): void; onSubmitted(executionId: string): void }) {
  const [configurationId, setConfigurationId] = useState(props.configurations[0]?.configurationId ?? "");
  const roleId = props.workflow.allowedRoleIds.length === 1 ? props.workflow.allowedRoleIds[0]! : "";
  const [inputText, setInputText] = useState(() => JSON.stringify(props.workflow.inputExample, null, 2));
  const [inputError, setInputError] = useState<unknown>();
  const [entryId, setEntryId] = useState("");
  const [acquisition, setAcquisition] = useState<"supplied" | "deferred">("supplied");
  const [waitDuration, setWaitDuration] = useState("24h");
  const [graphValues, setGraphValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!props.configurations.some((configuration) => configuration.configurationId === configurationId)) {
      setConfigurationId(props.configurations[0]?.configurationId ?? "");
    }
  }, [configurationId, props.configurations]);
  const readiness = useQuery({
    queryKey: ["workflow-runtime-readiness", workflowKey(props.workflow), roleId, configurationId],
    queryFn: () => props.runClient.preflightWorkflow({
      workflow: props.workflow.workflow,
      roleId,
      runConfigurationId: configurationId,
    }),
    enabled: Boolean(configurationId && roleId),
    retry: false,
  });
  const invocation = useQuery({
    queryKey: ["workflow-invocation-options", workflowKey(props.workflow), roleId, configurationId],
    queryFn: () => props.runClient.getWorkflowInvocationOptions({ workflow: props.workflow.workflow, roleId, runConfigurationId: configurationId }),
    enabled: props.workflow.invocationModel === "graph-entry" && Boolean(configurationId && roleId),
    retry: false,
  });
  useEffect(() => {
    if (invocation.data?.model !== "graph-entry") return;
    const selected = invocation.data.entries.find(entry => entry.id === entryId) ?? invocation.data.entries[0];
    if (!selected) return;
    if (selected.id !== entryId) setEntryId(selected.id);
    setGraphValues(current => Object.fromEntries(selected.requirements.map(requirement => [requirement.id, current[requirement.id] ?? ""])));
  }, [entryId, invocation.data]);
  const submit = useMutation({ mutationFn: (input: JsonValue) => props.runClient.submitRun({ workflow: props.workflow.workflow, roleId, runConfigurationId: configurationId, input }), onSuccess: ({ runRef }) => props.onSubmitted(runRef.executionId) });
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      setInputError(undefined);
      if (invocation.data?.model === "graph-entry") {
        const selected = invocation.data.entries.find(entry => entry.id === entryId);
        if (!selected) throw new Error("Choose a starting step.");
        if (acquisition === "deferred") {
          submit.mutate({ schemaVersion: 1, acquisition, entry: selected.entry, wait: { duration: waitDuration } } as JsonValue);
          return;
        }
        const values: Record<string, JsonValue> = {};
        for (const requirement of selected.requirements) {
          const raw = graphValues[requirement.id] ?? "";
          if (!raw.trim()) throw fieldError(`values.${requirement.id}`, "This field is required.");
          try { values[requirement.id] = JSON.parse(raw) as JsonValue; }
          catch { throw fieldError(`values.${requirement.id}`, "Enter valid JSON."); }
        }
        submit.mutate({ schemaVersion: 1, acquisition, entry: selected.entry, values } as JsonValue);
        return;
      }
      try { submit.mutate(JSON.parse(inputText) as JsonValue); }
      catch { throw fieldError("input", "Enter valid JSON."); }
    } catch (error) { setInputError(error); }
  }
  if (props.configurations.length === 0) return <p className="text-sm text-muted-foreground">Create a Run Configuration below before invoking this workflow.</p>;
  if (!roleId) return <ErrorNotification description="Local workflow invocation requires exactly one authorized workflow role." />;
  const selectedConfiguration = props.configurations.find((configuration) => configuration.configurationId === configurationId);
  const selectedEntry = invocation.data?.model === "graph-entry" ? invocation.data.entries.find(entry => entry.id === entryId) : undefined;
  const validationError = inputError ?? submit.error;
  let invocationFields: ReactNode;
  if (props.workflow.invocationModel !== "graph-entry") invocationFields = <Field name="input">Workflow input<Textarea className="min-h-64 font-mono text-xs" value={inputText} onChange={(event) => { setInputText(event.target.value); setInputError(undefined); }} /></Field>;
  else if (invocation.isPending) invocationFields = <p className="text-sm text-muted-foreground">Loading workflow input contract…</p>;
  else if (invocation.error) invocationFields = <ErrorNotification description={`Input contract failed: ${message(invocation.error)}`} />;
  else if (invocation.data?.model === "graph-entry") invocationFields = <GraphInvocationFields graph={invocation.data.graph} entries={invocation.data.entries} selected={selectedEntry} entryId={entryId} acquisition={acquisition} waitDuration={waitDuration} values={graphValues}
    onEntry={value => { setEntryId(value); setInputError(undefined); }} onAcquisition={value => { setAcquisition(value); setInputError(undefined); }}
    onWaitDuration={value => { setWaitDuration(value); setInputError(undefined); }} onValue={(id, value) => { setGraphValues(current => ({ ...current, [id]: value })); setInputError(undefined); }} />;
  else invocationFields = <ErrorNotification description="The graph workflow returned no invocation contract." />;
  const invocationBlocked = props.workflow.invocationModel === "graph-entry" && (invocation.isPending || invocation.isError);
  return <FormValidation fallbackField="input" error={validationError}><form noValidate className="space-y-4" onSubmit={onSubmit}>
    <Field name="runConfigurationId">Run configuration<Select className="h-10 rounded-md border bg-background px-3" value={configurationId} onChange={(event) => setConfigurationId(event.target.value)}>{props.configurations.map((configuration) => <option key={configuration.configurationId} value={configuration.configurationId}>{configuration.configurationId}</option>)}</Select></Field>
    {selectedConfiguration ? <ConfigurationPreview workflow={props.workflow} configuration={selectedConfiguration} /> : null}
    <RuntimeReadiness readiness={readiness} />
    {invocationFields}

    <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={props.onCancel}>Cancel</Button><Button type="submit" disabled={!configurationId || submit.isPending || readiness.isPending || readiness.isError || readiness.data?.available !== true || invocationBlocked}>{submit.isPending ? "Invoking…" : "Invoke"}</Button></div>
  </form></FormValidation>;
}

function GraphInvocationFields(props: { graph?: GraphDescriptionDto; entries: WorkflowInvocationEntryDto[]; selected?: WorkflowInvocationEntryDto;
  entryId: string; acquisition: "supplied" | "deferred"; waitDuration: string; values: Record<string, string>;
  onEntry(value: string): void; onAcquisition(value: "supplied" | "deferred"): void; onWaitDuration(value: string): void;
  onValue(id: string, value: string): void }) {
  const [focusedRequirementId, setFocusedRequirementId] = useState("");
  useEffect(() => setFocusedRequirementId(""), [props.entryId]);
  return <section className="space-y-4">
    <Field name="entry">Starting step<Select className="h-10 rounded-md border bg-background px-3" value={props.entryId} onChange={event => props.onEntry(event.target.value)}>{props.entries.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</Select></Field>
    {props.graph ? <WorkflowDiagram graph={props.graph} entry={props.selected} focusedRequirementId={focusedRequirementId} onRequirement={setFocusedRequirementId} /> : null}
    <Field name="acquisition">Input mode<Select className="h-10 rounded-md border bg-background px-3" value={props.acquisition} onChange={event => props.onAcquisition(event.target.value as "supplied" | "deferred")}><option value="supplied">Provide input now</option><option value="deferred">Wait for input after starting</option></Select></Field>
    {props.acquisition === "deferred" ? <Field name="wait.duration">Input deadline<Textarea className="min-h-10 font-mono text-xs" value={props.waitDuration} onChange={event => props.onWaitDuration(event.target.value)} /><span className="text-xs font-normal text-muted-foreground">Positive integer plus s, m, h, or d. Maximum 366 days.</span></Field>
      : props.selected?.requirements.map(requirement => <GraphRequirementField key={requirement.id}
        requirement={requirement} name={`values.${requirement.id}`} value={props.values[requirement.id] ?? ""}
        onLocate={props.graph ? () => setFocusedRequirementId(requirement.id) : undefined}
        onChange={value => props.onValue(requirement.id, value)} />)}
  </section>;
}

function ConfigurationPreview(props: { workflow: WorkflowDto; configuration: RunConfigurationDefinitionDto }) {
  const definition = object(props.configuration.redactedDefinition);
  const agents = object(definition.agents);
  return <section className="space-y-2 rounded-md border p-3"><h3 className="text-sm font-semibold">Agent Slot configuration</h3>{props.workflow.agentSlots.map((slot) => <details key={slot.slotId} className="rounded border p-2"><summary className="cursor-pointer text-sm font-medium">{slot.title} <span className="text-muted-foreground">({slot.slotId})</span></summary><pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(agents[slot.slotId] ?? null, null, 2)}</pre></details>)}</section>;
}

function RuntimeReadiness(props: { readiness: ReturnType<typeof useQuery> }) {
  if (props.readiness.isPending) return <p className="text-sm text-muted-foreground">Checking agent runtimes…</p>;
  if (props.readiness.error) return <ErrorNotification description={`Runtime check failed: ${message(props.readiness.error)}`} />;
  const value = props.readiness.data as Awaited<ReturnType<RunApiClient["preflightWorkflow"]>> | undefined;
  if (!value) return null;
  if (value.agents.length === 0) return <p className="text-sm text-muted-foreground">This workflow has no agent runtime preflight.</p>;
  return <div className="rounded-md border p-3 text-sm">
    <p className="font-medium">Agent runtime readiness</p>
    <ul className="mt-2 space-y-1">
      {value.agents.map((agent) => {
        const status = agent.status ?? (agent.available ? "ready" : "unavailable");
        const state = status === "indeterminate" ? "Eligibility unconfirmed" : agent.available ? "Ready" : "Unavailable";
        const className = status === "indeterminate" ? "text-amber-700 dark:text-amber-400" : agent.available ? "text-muted-foreground" : "text-destructive";
        const identity = [
          agent.identity?.accountEmail,
          agent.identity?.reportedPlan ? `plan ${agent.identity.reportedPlan}` : undefined,
        ].filter(Boolean).join(", ");
        const remediation = agent.remediation?.map(({ label }) => label).join(" or ");
        return <li key={agent.slotId} className={className}>
          <span className="font-medium text-foreground">{agent.slotId}</span>: {state} via {agent.providerId}
          {agent.commandSource ? ` (${agent.commandSource})` : ""}
          {identity ? ` — ${identity}` : ""}
          {agent.message ? ` — ${agent.message}` : ""}
          {remediation ? ` Next: ${remediation}.` : ""}
        </li>;
      })}
    </ul>
  </div>;
}

function workflowKey(workflow: WorkflowDto): string { return `${workflow.workflow.kind}@${workflow.workflow.version}`; }
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
