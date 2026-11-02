import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentTemplateApiClient,
  type AgentTemplateDefinitionDto,
  type AgentTemplateDocumentDto,
  type ExecutionProviderEditorDescriptorDto,
  type JsonObject,
} from "@com-pyvue/agent-execution-agent-template-contract";
import { Field, FormValidation, Select, fieldError, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@com-pyvue/agent-execution-ui";

export interface AgentTemplateFeatureProps { client: AgentTemplateApiClient }

export function AgentTemplateFeature({ client }: AgentTemplateFeatureProps) {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<AgentTemplateDocumentDto>();
  const [json, setJson] = useState("");
  const [editingJson, setEditingJson] = useState(false);
  const [error, setError] = useState<unknown>();
  const templates = useQuery({ queryKey: ["agent-templates", showArchived], queryFn: () => client.list({ pageSize: 500, lifecycleStatus: showArchived ? "all" : "active" }) });
  const metadata = useQuery({ queryKey: ["agent-template-metadata"], queryFn: () => client.metadata() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agent-templates"] });
  const publish = useMutation({ mutationFn: (definition: AgentTemplateDocumentDto) => client.publish({ definition }), onSuccess: async () => { setDraft(undefined); setJson(""); await refresh(); } });
  const archive = useMutation({ mutationFn: (templateId: string) => client.archive(templateId), onSuccess: refresh });
  const restore = useMutation({ mutationFn: (templateId: string) => client.restore(templateId), onSuccess: refresh });

  function beginDraft(next: AgentTemplateDocumentDto) { setEditingJson(false); publish.reset(); setDraft(next); setJson(JSON.stringify(next, null, 2)); setError(undefined); globalThis.scrollTo?.({ top: 0, behavior: "smooth" }); }
  function updateDraft(next: AgentTemplateDocumentDto) { setEditingJson(false); setDraft(next); setJson(JSON.stringify(next, null, 2)); setError(undefined); }
  function submit(event: FormEvent) {
    event.preventDefault(); publish.reset();
    try { const parsed = JSON.parse(json) as AgentTemplateDocumentDto; setError(undefined); publish.mutate(parsed); }
    catch (caught) { setError(fieldError("definition", "Enter valid JSON.")); }
  }

  return <main className="mx-auto max-w-[100rem] space-y-6 p-4 md:p-8">
    <header><h1 className="text-2xl font-semibold">Agent Templates</h1><p className="text-muted-foreground">Reusable provider presets copied into workflow Agent Slots. Templates are never runtime inheritance.</p></header>
    {draft && metadata.data ? <Card><CardHeader><CardTitle>Create custom template</CardTitle><CardDescription>Adjust the copied defaults, then publish a reusable immutable preset.</CardDescription></CardHeader><CardContent className="space-y-4">
      <FormValidation targetField={editingJson ? "definition" : undefined} fallbackField="definition" error={error ?? publish.error}><AgentTemplateEditor definition={draft} providers={metadata.data.executionProviders} onChange={updateDraft} />
      <form noValidate className="space-y-3" onSubmit={submit}><details className="rounded-md border p-4"><summary className="cursor-pointer font-medium">Advanced JSON</summary><Field name="definition"><Textarea aria-label="Agent Template JSON" className="mt-3 min-h-72 font-mono text-xs" value={json} onChange={(event) => { setEditingJson(true); setJson(event.target.value); setError(undefined); }} /></Field></details><div className="flex gap-2"><Button type="submit" disabled={publish.isPending}>{publish.isPending ? "Publishing…" : "Publish template"}</Button><Button type="button" variant="outline" onClick={() => setDraft(undefined)}>Cancel</Button></div></form>
      </FormValidation>
    </CardContent></Card> : null}
    <Card><CardHeader><CardTitle>Template library</CardTitle><CardDescription>One platform starting point per installed execution-provider schema, plus custom presets you deliberately save.</CardDescription></CardHeader><CardContent className="space-y-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Show archived custom templates</label>
      {templates.isPending ? <p>Loading templates…</p> : templates.error ? <ErrorNotification description={message(templates.error)} /> : <TemplateTable templates={templates.data?.items ?? []} onClone={(template) => beginDraft(cloneTemplate(template))} onArchive={(id) => archive.mutate(id)} onRestore={(id) => restore.mutate(id)} />}
      {archive.error || restore.error ? <ErrorNotification description={message(archive.error ?? restore.error)} /> : null}
    </CardContent></Card>
  </main>;
}

function AgentTemplateEditor(props: { definition: AgentTemplateDocumentDto; providers: readonly ExecutionProviderEditorDescriptorDto[]; onChange(value: AgentTemplateDocumentDto): void }) {
  const provider = props.providers.find(({ providerId, schemaVersion }) => providerId === props.definition.providerSchema.executionProvider && schemaVersion === props.definition.providerSchema.schemaVersion) ?? props.providers[0];
  const policy = props.definition.policy;
  const execution = object(policy.execution);
  const parameters = object(execution.parameters);
  const requiredModelProvider = modelProviderForAuthentication(provider, string(execution.authProvider));
  const update = (partial: Partial<AgentTemplateDocumentDto>) => props.onChange({ ...props.definition, ...partial });
  const updatePolicy = (next: JsonObject) => update({ policy: next });
  return <section className="grid gap-4 md:grid-cols-2">
    <Field name="definition.templateId" className="grid gap-1 text-sm font-medium">Template ID<Input value={props.definition.templateId} onChange={(event) => update({ templateId: event.target.value })} /></Field>
    <Field name="definition.title" className="grid gap-1 text-sm font-medium">Title<Input value={props.definition.title} onChange={(event) => update({ title: event.target.value })} /></Field>
    <Field name="definition.description" className="grid gap-1 text-sm font-medium md:col-span-2">Description<Input value={props.definition.description ?? ""} onChange={(event) => update(event.target.value ? { description: event.target.value } : { description: undefined })} /></Field>
    <Field name="definition.providerSchema" className="grid gap-1 text-sm font-medium">Execution provider<Select className="h-10 rounded-md border bg-background px-3" value={`${provider?.providerId}@${provider?.schemaVersion}`} onChange={(event) => { const selected = props.providers.find((candidate) => `${candidate.providerId}@${candidate.schemaVersion}` === event.target.value); if (selected) props.onChange(withProvider(props.definition, selected)); }}>{props.providers.map((candidate) => <option key={`${candidate.providerId}@${candidate.schemaVersion}`} value={`${candidate.providerId}@${candidate.schemaVersion}`}>{candidate.displayName}</option>)}</Select></Field>
    <Field name="definition.policy.execution.authProvider" className="grid gap-1 text-sm font-medium">Authentication provider{provider?.allowsCustomAuthProvider === false
      ? <Select className="h-10 rounded-md border bg-background px-3" value={string(execution.authProvider)} onChange={(event) => updatePolicy(withAuthenticationProvider(policy, provider, event.target.value))}>
        {[provider.defaultAuthProviderId, ...(provider.authProviderOptions ?? []).map(({ value }) => value)].filter((value, index, values) => values.indexOf(value) === index).map((value) => <option key={value} value={value}>{value}</option>)}
      </Select>
      : <Input value={string(execution.authProvider)} onChange={(event) => updatePolicy({ ...policy, execution: { ...execution, authProvider: event.target.value } })} />}</Field>
    <Field name="definition.policy.timeoutMs" className="grid gap-1 text-sm font-medium">Timeout milliseconds<Input type="number" value={number(policy.timeoutMs, 300000)} onChange={(event) => updatePolicy({ ...policy, timeoutMs: Number(event.target.value) })} /></Field>
    {provider?.fields.map((field) => <Field name={`definition.policy.execution.parameters.${field.key}`} key={field.key}>{field.label}{field.kind === "enum" ? <Select className="h-10 rounded-md border bg-background px-3" value={string(parameters[field.key])} onChange={(event) => updatePolicy(withParameter(policy, field.key, event.target.value))}><option value="">Default</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select> : field.allowsCustomValue
      ? <Input placeholder={field.placeholder} value={string(parameters[field.key])} onChange={(event) => updatePolicy(withParameter(policy, field.key, event.target.value))} />
      : <Select className="h-10 rounded-md border bg-background px-3" value={string(parameters[field.key])} onChange={(event) => updatePolicy(withParameter(policy, field.key, event.target.value))}>
        {string(parameters[field.key]) ? null : <option value="">Choose…</option>}
        {closedFieldOptions(field, parameters, requiredModelProvider).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>}</Field>)}
    {provider?.allowsAdditionalParameters ? <p className="text-sm text-muted-foreground md:col-span-2">This provider also accepts additional native parameters through Advanced JSON.</p> : null}
  </section>;
}

function TemplateTable(props: { templates: AgentTemplateDefinitionDto[]; onClone(template: AgentTemplateDefinitionDto): void; onArchive(id: string): void; onRestore(id: string): void }) {
  if (props.templates.length === 0) return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No Agent Templates.</p>;
  return <div className="overflow-x-auto rounded-md border"><Table aria-label="Agent Templates"><TableHeader><TableRow><TableHead>Template</TableHead><TableHead>Provider</TableHead><TableHead>Model</TableHead><TableHead>Effort</TableHead><TableHead>Speed</TableHead><TableHead>Authentication</TableHead><TableHead>Timeout</TableHead><TableHead>Origin</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{props.templates.map((template) => { const policy = object(template.redactedDefinition.policy); const execution = object(policy.execution); const parameters = object(execution.parameters); return <TableRow key={template.templateId}><TableCell><p className="font-medium">{template.title}</p><p className="text-xs text-muted-foreground">{template.templateId}</p></TableCell><TableCell>{template.redactedDefinition.providerSchema.executionProvider}</TableCell><TableCell>{string(parameters.model) || "—"}</TableCell><TableCell>{string(parameters.model_reasoning_effort) || string(parameters.thinking) || "—"}</TableCell><TableCell>{string(parameters.speed) || string(parameters.service_tier) || "—"}</TableCell><TableCell>{string(execution.authProvider) || "—"}</TableCell><TableCell>{typeof policy.timeoutMs === "number" ? `${policy.timeoutMs.toLocaleString()} ms` : "—"}</TableCell><TableCell><Badge variant={template.origin === "platform" ? "primary" : "secondary"}>{template.origin}</Badge></TableCell><TableCell><Badge variant={template.lifecycleStatus === "active" ? "success" : "warning"}>{template.lifecycleStatus}</Badge></TableCell><TableCell><div className="flex gap-2"><Button size="sm" onClick={() => props.onClone(template)}>Use</Button>{template.origin === "custom" && template.lifecycleStatus === "active" ? <Button size="sm" variant="outline" onClick={() => props.onArchive(template.templateId)}>Delete</Button> : null}{template.origin === "custom" && template.lifecycleStatus === "archived" ? <Button size="sm" variant="outline" onClick={() => props.onRestore(template.templateId)}>Restore</Button> : null}</div></TableCell></TableRow>; })}</TableBody></Table></div>;
}
function cloneTemplate(template: AgentTemplateDefinitionDto): AgentTemplateDocumentDto { const clone = structuredClone(template.redactedDefinition); return { ...clone, templateId: nextId(clone.templateId), title: `${clone.title} copy`, origin: "custom" }; }
function nextId(id: string): string { const match = /^(.*)-v([1-9][0-9]*)$/.exec(id); return match ? `${match[1]}-custom-v1` : "custom-agent-template-v1"; }
function closedFieldOptions(field: Extract<ExecutionProviderEditorDescriptorDto["fields"][number], { kind: "string" }>, parameters: JsonObject, requiredModelProvider?: string) {
  if (field.key === "provider" && requiredModelProvider) return [{ value: requiredModelProvider, label: requiredModelProvider }];
  return [...(field.suggestions ?? []), ...(field.conditionalSuggestions ?? []).filter(({ parameterKey, parameterValue }) => parameters[parameterKey] === parameterValue).flatMap(({ options }) => options)];
}
function withProvider(definition: AgentTemplateDocumentDto, provider: ExecutionProviderEditorDescriptorDto): AgentTemplateDocumentDto { const parameters = Object.fromEntries(provider.fields.flatMap((field) => { const value = field.kind === "string" ? field.defaultValue ?? "" : field.required ? field.options[0]?.value ?? "" : ""; return value === "" ? [] : [[field.key, value]]; })); return { ...definition, providerSchema: { executionProvider: provider.providerId, schemaVersion: provider.schemaVersion }, policy: { timeoutMs: number(definition.policy.timeoutMs, 300000), execution: { provider: provider.providerId, authProvider: provider.defaultAuthProviderId, parameters } } }; }
function withParameter(policy: JsonObject, key: string, value: string): JsonObject { const execution = object(policy.execution); const parameters = { ...object(execution.parameters) }; if (value) parameters[key] = value; else delete parameters[key]; return { ...policy, execution: { ...execution, parameters } }; }
function withAuthenticationProvider(policy: JsonObject, provider: ExecutionProviderEditorDescriptorDto | undefined, authProvider: string): JsonObject {
  const execution = object(policy.execution);
  const parameters = { ...object(execution.parameters) };
  const modelProvider = modelProviderForAuthentication(provider, authProvider);
  if (modelProvider) {
    parameters.provider = modelProvider;
    const modelField = provider?.fields.find((field) => field.key === "model" && field.kind === "string");
    const models = modelField && modelField.kind === "string"
      ? (modelField.conditionalSuggestions ?? [])
        .filter(({ parameterKey, parameterValue }) => parameterKey === "provider" && parameterValue === modelProvider)
        .flatMap(({ options }) => options.map(({ value }) => value))
      : [];
    if (models.length > 0 && !models.includes(string(parameters.model))) parameters.model = models[0]!;
  }
  return { ...policy, execution: { ...execution, authProvider, parameters } };
}
function modelProviderForAuthentication(provider: ExecutionProviderEditorDescriptorDto | undefined, authProvider: string): string | undefined { return provider?.authProviderOptions?.find(({ value }) => value === authProvider)?.modelProvider; }
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
