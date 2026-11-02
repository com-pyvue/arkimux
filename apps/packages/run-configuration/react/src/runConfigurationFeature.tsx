import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { Fragment, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentTemplateApiClient, AgentTemplateDefinitionDto } from "@com-pyvue/agent-execution-agent-template-contract";
import type { WorkflowDto } from "@com-pyvue/agent-execution-run-contract";
import type { JsonObject, JsonValue, RunConfigurationApiClient } from "@com-pyvue/agent-execution-run-configuration-contract";
import { Field, FormValidation, fieldError, validationIssues, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogHeader, DialogTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@com-pyvue/agent-execution-ui";
import {
  useArchiveRunConfiguration,
  usePublishRunConfiguration,
  useRestoreRunConfiguration,
  useRunConfigurationList,
  useValidateRunConfiguration,
} from "./queries.ts";
import { StructuredRunConfigurationEditor, withAuthenticationProvider } from "./structuredRunConfigurationEditor.tsx";
import { newestRunConfigurationsFirst } from "./sortRunConfigurations.ts";

export interface RunConfigurationFeatureProps {
  client: RunConfigurationApiClient;
  agentTemplateClient: AgentTemplateApiClient;
  workflow: WorkflowDto;
}

export function RunConfigurationFeature({ client, agentTemplateClient, workflow }: RunConfigurationFeatureProps) {
  const identity = workflow.workflow;
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<JsonObject>();
  const [draftText, setDraftText] = useState("");
  const [selectedTemplates, setSelectedTemplates] = useState<Record<string, string>>({});
  const [comparisonConfigurationId, setComparisonConfigurationId] = useState("");
  const [editingJson, setEditingJson] = useState(false);
  const [error, setError] = useState<unknown>();
  const configurations = useRunConfigurationList(client, identity, {
    pageSize: 500,
    lifecycleStatus: "all",
  });
  const templates = useQuery({
    queryKey: ["agent-templates", "workflow-configuration"],
    queryFn: () => agentTemplateClient.list({ pageSize: 500, lifecycleStatus: "active" }),
  });
  const metadata = useQuery({
    queryKey: ["agent-template-metadata"],
    queryFn: () => agentTemplateClient.metadata(),
  });
  const validation = useValidateRunConfiguration(client, identity);
  const publication = usePublishRunConfiguration(client, identity);
  const archive = useArchiveRunConfiguration(client, identity);
  const restore = useRestoreRunConfiguration(client, identity);
  const orderedConfigurations = newestRunConfigurationsFirst(configurations.data?.items ?? []);

  function beginDraft(source?: JsonObject) {
    setEditingJson(false); validation.reset(); publication.reset();
    let next = source ? nextVersion(source) : newDefinition(workflow);
    const selection = source
      ? selectedTemplateIds(source, workflow, templates.data?.items ?? [])
      : defaultTemplateIds(workflow, templates.data?.items ?? []);
    if (!source) {
      for (const [slotId, templateId] of Object.entries(selection)) {
        const template = templates.data?.items.find((item) => item.templateId === templateId);
        if (template) {
          next = withTemplate(next, slotId, template);
          const policy = object(object(next.agents)[slotId]);
          const execution = object(policy.execution);
          const descriptor = metadata.data?.executionProviders.find((provider) => provider.providerId === execution.provider);
          if (descriptor?.connectionDriven) {
            const connection = descriptor.authProviderOptions?.find((option) => option.value === execution.authProvider) ?? descriptor.authProviderOptions?.[0];
            if (connection) next = { ...next, agents: { ...object(next.agents), [slotId]: withAuthenticationProvider(policy, descriptor, connection.value) } };
          }
        }
      }
    }
    setDraft(next);
    setDraftText(JSON.stringify(next, null, 2));
    setSelectedTemplates(selection);
    setComparisonConfigurationId("");
    setError(undefined);
  }

  function updateDraft(next: JsonObject) {
    setEditingJson(false); setError(undefined);
    setDraft(next);
    setDraftText(JSON.stringify(next, null, 2));
  }

  function closeDraft() {
    setDraft(undefined);
    setDraftText("");
    setComparisonConfigurationId("");
    setError(undefined);
  }

  function selectTemplate(slotId: string, templateId: string) {
    setSelectedTemplates((current) => ({ ...current, [slotId]: templateId }));
    const template = templates.data?.items.find((item) => item.templateId === templateId);
    if (!template || !draft) return;
    const copied = withTemplate(draft, slotId, template);
    const execution = object(object(object(draft.agents)[slotId]).execution);
    const descriptor = metadata.data?.executionProviders.find((provider) => provider.providerId === execution.provider);
    if (descriptor?.connectionDriven && typeof execution.authProvider === "string") {
      const policy = object(object(copied.agents)[slotId]);
      // Templates supply defaults, but never replace the slot's chosen Connection.
      updateDraft({ ...copied, agents: { ...object(copied.agents), [slotId]: withAuthenticationProvider(policy, descriptor, execution.authProvider) } });
    } else updateDraft(copied);
  }

  function submit(event: FormEvent, action: "validate" | "publish") {
    event.preventDefault(); validation.reset(); publication.reset();
    try {
      const parsed = JSON.parse(draftText) as unknown;
      if (!isObject(parsed)) throw new Error("Run configuration must be a JSON object.");
      const missing = workflow.agentSlots.filter(({ slotId }) => !isObject(object(parsed.agents)[slotId]));
      if (missing.length > 0) throw { issues: missing.flatMap(({ slotId, title }) => fieldError(`definition.agentTemplateProvenance.${slotId}`, `Choose an Agent Template for ${title}.`).issues) };
      setError(undefined);
      setDraft(parsed);
      if (action === "validate") validation.mutate({ definition: parsed });
      else publication.mutate({ definition: parsed }, { onSuccess: () => { setDraft(undefined); setDraftText(""); setComparisonConfigurationId(""); } });
    } catch (caught) {
      setError(validationIssues(caught).length ? caught : fieldError("definition", caught instanceof SyntaxError ? "Enter valid JSON." : message(caught)));
    }
  }

  async function archiveConfigurations(configurationIds: string[]) {
    await Promise.all(configurationIds.map((configurationId) => archive.mutateAsync(configurationId)));
  }

  return <section className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Run configurations</h2><p className="text-sm text-muted-foreground">Complete immutable execution policies owned by this workflow.</p></div>
      <Button disabled={templates.isPending || metadata.isPending} onClick={() => beginDraft()}>Create configuration</Button>
    </div>
    <Dialog open={draft !== undefined} onOpenChange={(open) => { if (!open) closeDraft(); }} className="w-[min(96rem,calc(100%-2rem))]">
      <DialogHeader><DialogTitle>Create workflow configuration</DialogTitle><p className="text-sm text-muted-foreground">{metadata.data?.executionProviders.some((provider) => provider.connectionDriven) ? "Choose a Connection for each slot. Optionally copy template defaults, then tune this workflow's values." : "Choose a reusable Agent Template for every slot, then tune the copied values for this workflow."}</p></DialogHeader>
      <DialogContent className="space-y-5">
      {draft ? <FormValidation targetField={editingJson ? "definition" : undefined} fallbackField="definition" error={error ?? validation.error ?? publication.error}>
      {templates.isPending || metadata.isPending ? <p>Loading Agent Templates…</p> : templates.error || metadata.error ? <ErrorNotification description={message(templates.error ?? metadata.error)} /> : <>
        <StructuredRunConfigurationEditor
          definition={draft}
          agentSlots={workflow.agentSlots}
          providers={metadata.data?.executionProviders ?? []}
          templates={templates.data?.items ?? []}
          selectedTemplates={selectedTemplates}
          comparisonConfigurationId={comparisonConfigurationId}
          comparisonDefinitions={orderedConfigurations.map((item) => ({
            configurationId: item.configurationId,
            definition: item.redactedDefinition,
          }))}
          onComparisonConfigurationChange={setComparisonConfigurationId}
          onTemplateChange={selectTemplate}
          onChange={updateDraft}
        />
      </>}
      <form noValidate className="space-y-3" onSubmit={(event) => submit(event, "publish")}>
        <details className="rounded-md border p-4"><summary className="cursor-pointer font-medium">Advanced JSON</summary><Field name="definition"><Textarea aria-label="Run configuration JSON" className="mt-3 min-h-80 font-mono text-xs" value={draftText} onChange={(event) => { setEditingJson(true); setDraftText(event.target.value); setError(undefined); }} /></Field></details>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={(event) => submit(event, "validate")}>Validate</Button><Button type="submit">Publish immutable configuration</Button><Button type="button" variant="outline" onClick={closeDraft}>Cancel</Button></div>
      </form>

      {validation.data ? <p role="status">Configuration is valid with hash {validation.data.definition.contentHash}.</p> : null}
      </FormValidation> : null}
      </DialogContent>
    </Dialog>
    <Card><CardHeader><CardTitle>Published configurations</CardTitle><CardDescription>Select any active configuration when invoking this workflow.</CardDescription></CardHeader><CardContent className="space-y-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Show archived configurations</label>
      {configurations.isPending ? <p>Loading configurations…</p> : configurations.error ? <ErrorNotification description={message(configurations.error)} /> : <ConfigurationTree agentSlots={workflow.agentSlots} items={orderedConfigurations.filter((item) => showArchived || item.lifecycleStatus === "active")} archivePending={archive.isPending} onClone={(value) => beginDraft(value)} onArchive={(ids) => void archiveConfigurations(ids)} onRestore={(id) => restore.mutate(id)} />}
    </CardContent></Card>
  </section>;
}

function ConfigurationTree(props: {
  agentSlots: WorkflowDto["agentSlots"];
  items: Array<{ configurationId: string; contentHash: string; createdAt?: string; lifecycleStatus: "active" | "archived"; redactedDefinition: JsonObject }>;
  archivePending: boolean;
  onClone(value: JsonObject): void;
  onArchive(configurationIds: string[]): void;
  onRestore(configurationId: string): void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  if (props.items.length === 0) return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No configurations.</p>;
  const activeIds = props.items.filter(({ lifecycleStatus }) => lifecycleStatus === "active").map(({ configurationId }) => configurationId);
  const selectedActiveIds = activeIds.filter((configurationId) => selected.has(configurationId));
  const detailIds = props.items.flatMap((item) => configurationDetailIds(item.configurationId, props.agentSlots));
  const allExpanded = props.items.every(({ configurationId }) => expanded.has(configurationId)) && detailIds.every((id) => expandedDetails.has(id));
  return <section aria-label="Workflow run configurations" className="space-y-3">
    <div className="flex flex-wrap justify-between gap-2">
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={allExpanded} onClick={() => { setExpanded(new Set(props.items.map(({ configurationId }) => configurationId))); setExpandedDetails(new Set(detailIds)); }}>Expand all</Button>
      <Button size="sm" variant="outline" disabled={expanded.size === 0 && expandedDetails.size === 0} onClick={() => { setExpanded(new Set()); setExpandedDetails(new Set()); }}>Collapse all</Button></div>
      <Button size="sm" variant="outline" disabled={selectedActiveIds.length === 0 || props.archivePending} onClick={() => { props.onArchive(selectedActiveIds); setSelected(new Set()); }}>Archive selected ({selectedActiveIds.length})</Button>
    </div>
    <div className="overflow-x-auto rounded-lg border"><Table aria-label="Published run configurations">
      <TableHeader><TableRow>
        <TableHead className="w-10"><input aria-label="Select all active configurations" type="checkbox" checked={activeIds.length > 0 && selectedActiveIds.length === activeIds.length} onChange={(event) => setSelected(event.target.checked ? new Set(activeIds) : new Set())} /></TableHead>
        <TableHead>Configuration</TableHead>
        <TableHead>Content hash</TableHead>
        <TableHead>Status</TableHead>
        <TableHead className="text-right">Actions</TableHead>
      </TableRow></TableHeader>
      <TableBody>{props.items.map((item) => {
      const open = expanded.has(item.configurationId);
      const agents = object(item.redactedDefinition.agents);
      return <Fragment key={item.configurationId}>
        <TableRow data-selected={selected.has(item.configurationId) || undefined}>
          <TableCell><input aria-label={`Select configuration ${item.configurationId}`} type="checkbox" disabled={item.lifecycleStatus !== "active"} checked={selected.has(item.configurationId)} onChange={(event) => setSelected((current) => present(current, item.configurationId, event.target.checked))} /></TableCell>
          <TableCell><button type="button" className="flex min-w-0 items-center gap-3 text-left" aria-expanded={open} onClick={() => setExpanded((current) => toggled(current, item.configurationId))}>
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className="font-medium">{item.configurationId}</span>
          </button></TableCell>
          <TableCell><span className="font-mono text-xs text-muted-foreground">{item.contentHash.slice(0, 12)}…</span></TableCell>
          <TableCell><Badge variant={item.lifecycleStatus === "active" ? "success" : "warning"}>{item.lifecycleStatus}</Badge></TableCell>
          <TableCell><div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => props.onClone(item.redactedDefinition)}>Clone</Button>{item.lifecycleStatus === "active" ? <Button size="sm" variant="outline" onClick={() => props.onArchive([item.configurationId])}>Archive</Button> : <Button size="sm" variant="outline" onClick={() => props.onRestore(item.configurationId)}>Restore</Button>}</div></TableCell>
        </TableRow>
        {open ? <TableRow><TableCell colSpan={5} className="bg-muted/10 p-0"><div className="space-y-2 p-3 pl-12">
          {props.agentSlots.map((slot) => { const id = configurationDetailId(item.configurationId, slot.slotId); return <details key={slot.slotId} open={expandedDetails.has(id)} onToggle={(event) => { const open = event.currentTarget.open; setExpandedDetails((current) => present(current, id, open)); }} className="rounded-md border-l-4 bg-muted/20 p-3"><summary className="cursor-pointer font-medium">{slot.title} <span className="font-mono text-xs text-muted-foreground">{slot.slotId}</span></summary><pre className="mt-3 max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(agents[slot.slotId] ?? null, null, 2)}</pre></details>; })}
          <details open={expandedDetails.has(configurationDetailId(item.configurationId, "complete"))} onToggle={(event) => { const open = event.currentTarget.open; setExpandedDetails((current) => present(current, configurationDetailId(item.configurationId, "complete"), open)); }} className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Complete configuration JSON</summary><pre className="mt-3 max-h-96 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(item.redactedDefinition, null, 2)}</pre></details>
        </div></TableCell></TableRow> : null}
      </Fragment>;
    })}</TableBody></Table></div>
  </section>;
}

function configurationDetailIds(configurationId: string, agentSlots: WorkflowDto["agentSlots"]): string[] {
  return [...agentSlots.map(({ slotId }) => configurationDetailId(configurationId, slotId)), configurationDetailId(configurationId, "complete")];
}

function configurationDetailId(configurationId: string, detailId: string): string {
  return `${configurationId}\0${detailId}`;
}

function present(current: Set<string>, value: string, shouldBePresent: boolean): Set<string> {
  const next = new Set(current);
  if (shouldBePresent) next.add(value); else next.delete(value);
  return next;
}

function toggled(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

function newDefinition(workflow: WorkflowDto): JsonObject {
  const base = structuredClone(workflow.runConfigurationBase ?? {});
  return {
    schemaVersion: 1,
    ...base,
    configurationId: `${safeStem(workflow.workflow.kind)}-v1`,
    workflow: workflow.workflow,
    agents: {},
    ...(hasOwn(base, "agentTemplateProvenance") ? { agentTemplateProvenance: {} } : {}),
  };
}

function withTemplate(definition: JsonObject, slotId: string, template: AgentTemplateDefinitionDto): JsonObject {
  return {
    ...definition,
    agents: { ...object(definition.agents), [slotId]: structuredClone(template.redactedDefinition.policy) },
    ...(hasOwn(definition, "agentTemplateProvenance") ? {
      agentTemplateProvenance: {
        ...object(definition.agentTemplateProvenance),
        [slotId]: { templateId: template.templateId, templateContentHash: template.contentHash },
      },
    } : {}),
  };
}

function defaultTemplateIds(
  workflow: WorkflowDto,
  templates: readonly AgentTemplateDefinitionDto[],
): Record<string, string> {
  const preferred = templates.find((template) => template.templateId === "codex-cli-default-v1")
    ?? templates.find((template) => template.redactedDefinition.providerSchema.executionProvider === "codex-cli")
    ?? templates[0];
  if (!preferred) return {};
  return Object.fromEntries(workflow.agentSlots.map((slot) => [slot.slotId, preferred.templateId]));
}

function selectedTemplateIds(
  definition: JsonObject,
  workflow: WorkflowDto,
  templates: readonly AgentTemplateDefinitionDto[],
): Record<string, string> {
  const provenance = object(definition.agentTemplateProvenance);
  const agents = object(definition.agents);
  return Object.fromEntries(workflow.agentSlots.flatMap((slot) => {
    const recorded = object(provenance[slot.slotId]).templateId;
    if (typeof recorded === "string" && templates.some((template) => template.templateId === recorded)) {
      return [[slot.slotId, recorded]];
    }
    const providerId = object(object(agents[slot.slotId]).execution).provider;
    const matching = templates.find((template) => template.redactedDefinition.providerSchema.executionProvider === providerId);
    return matching ? [[slot.slotId, matching.templateId]] : [];
  }));
}

function nextVersion(definition: JsonObject): JsonObject {
  const next = structuredClone(definition);
  const current = typeof next.configurationId === "string" ? next.configurationId : "workflow-v1";
  const match = /^(.*)-v([1-9][0-9]*)$/.exec(current);
  next.configurationId = match ? `${match[1]}-v${Number(match[2]) + 1}` : "workflow-v1";
  return next;
}

function safeStem(value: string): string {
  const stem = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(stem) ? stem : `workflow-${stem}`;
}
function object(value: JsonValue | undefined): JsonObject { return isObject(value) ? value : {}; }
function isObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasOwn(value: JsonObject, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
