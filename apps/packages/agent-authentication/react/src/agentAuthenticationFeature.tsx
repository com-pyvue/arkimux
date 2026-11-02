import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentAuthenticationApiClient,
  type AgentAuthProviderDefinitionDto,
  type AgentAuthConfigurationCatalogItemDto,
  type AgentCredentialDefinitionDto,
  type AgentCredentialDto,
  type AgentAuthenticationMetadataResponseDto,
} from "@com-pyvue/agent-execution-agent-authentication-contract";
import { Field, FormValidation, Select, fieldError, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, notify, type ToastVariant } from "@com-pyvue/agent-execution-ui";

interface ProbeNotification {
  title: string;
  description: string;
  variant: ToastVariant;
}

export function AgentAuthenticationFeature({ client, connectionsFirst = false }: { client: AgentAuthenticationApiClient; connectionsFirst?: boolean }) {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [creatingCredential, setCreatingCredential] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [rotating, setRotating] = useState<string>();
  const [pendingProbe, setPendingProbe] = useState<Pick<AgentAuthConfigurationCatalogItemDto, "authProviderId" | "displayName">>();
  const probeTitleId = useId();
  const probeWarningId = useId();
  const providers = useQuery({ queryKey: ["agent-auth-providers", showArchived], queryFn: () => client.list({ pageSize: 500, lifecycleStatus: showArchived ? "all" : "active" }) });
  const credentials = useQuery({ queryKey: ["agent-credentials", showArchived], queryFn: () => client.listCredentials({ pageSize: 500, lifecycleStatus: showArchived ? "all" : "active" }) });
  const metadata = useQuery({ queryKey: ["agent-auth-provider-metadata"], queryFn: () => client.metadata() });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agent-auth-providers"] }),
      queryClient.invalidateQueries({ queryKey: ["agent-credentials"] }),
      queryClient.invalidateQueries({ queryKey: ["agent-template-metadata"] }),
      queryClient.invalidateQueries({ queryKey: ["run-configuration-metadata"] }),
    ]);
  };
  const archiveProvider = useMutation({ mutationFn: (id: string) => client.archive(id), onSuccess: refresh });
  const restoreProvider = useMutation({ mutationFn: (id: string) => client.restore(id), onSuccess: refresh });
  const archiveCredential = useMutation({ mutationFn: (id: string) => client.archiveCredential(id), onSuccess: refresh });
  const restoreCredential = useMutation({ mutationFn: (id: string) => client.restoreCredential(id), onSuccess: refresh });
  const probe = useMutation({
    mutationFn: (id: string) => client.probe(id),
    onSuccess: async ({ probe: result }) => {
      notify(probeResultNotification(result.status, result.message));
      await refresh();
    },
    onError: (probeError) => notify({
      title: "Connection test failed",
      description: probeError instanceof Error ? probeError.message : String(probeError),
      variant: "error",
    }),
  });
  const error = archiveProvider.error ?? restoreProvider.error ?? archiveCredential.error ?? restoreCredential.error;
  const credentialWarning = <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"><strong>Local development only.</strong> API keys are stored as plaintext mode-0600 files under <code>.arkimux/local/credentials/values</code>. Values are never returned by the API or copied into run artifacts.</p>;
  const credentialCard = <Card><CardHeader className="flex-row items-start justify-between"><div><CardTitle>Credentials</CardTitle><CardDescription>User-owned secret values. Values can be replaced, never read.</CardDescription></div>{metadata.data?.credentialPresets.length ? <Button onClick={() => setCreatingCredential(true)}>Add credential</Button> : null}</CardHeader><CardContent className="space-y-4">
      {connectionsFirst ? credentialWarning : null}
      {creatingCredential && metadata.data ? <CreateCredentialForm client={client} presets={metadata.data.credentialPresets} onDone={async () => { setCreatingCredential(false); await refresh(); }} onCancel={() => setCreatingCredential(false)} /> : null}
      {rotating ? <RotateCredentialForm client={client} credentialId={rotating} onDone={async () => { setRotating(undefined); await refresh(); }} onCancel={() => setRotating(undefined)} /> : null}
      {credentials.isPending ? <p>Loading credentials…</p> : credentials.error ? <ErrorText error={credentials.error} /> : <CredentialTable items={credentials.data?.items ?? []} onRotate={setRotating} onArchive={(id) => archiveCredential.mutate(id)} onRestore={(id) => restoreCredential.mutate(id)} />}
    </CardContent></Card>;
  const connectionCard = <Card><CardHeader className="flex-row items-start justify-between"><div><CardTitle>{connectionsFirst ? "Connections" : "Authentication configurations"}</CardTitle><CardDescription>Non-secret runtime bindings referenced by Agent Templates and workflow Run Configurations.</CardDescription></div><Button onClick={() => setCreatingProvider(true)}>{connectionsFirst ? "Add connection" : "Add configuration"}</Button></CardHeader><CardContent className="space-y-4">
      {connectionsFirst ? <p className="text-sm text-muted-foreground">For a native session, follow the provider’s login instructions below. You do not need to copy native login credentials into ArkiMux. For Pi with an Anthropic API key, add a Credential below first, then select it in Add connection. API usage is billed separately from Claude Pro. Test the connection to check whether it is ready.</p> : null}
      {creatingProvider && metadata.data ? <CreateProviderForm client={client} connectionsFirst={connectionsFirst} presets={metadata.data.authProviderPresets} nativePresets={metadata.data.nativeSessionPresets} credentials={(credentials.data?.items ?? []).filter((item) => item.lifecycleStatus === "active" && item.valueAvailable)} onDone={async () => { setCreatingProvider(false); await refresh(); }} onCancel={() => setCreatingProvider(false)} /> : null}
      {providers.isPending ? <p>{connectionsFirst ? "Loading connections…" : "Loading authentication configurations…"}</p> : providers.error ? <ErrorText error={providers.error} /> : <ProviderTable items={providers.data?.items ?? []} connectionsFirst={connectionsFirst} probingId={probe.isPending ? probe.variables : undefined} onProbe={({ authProviderId, displayName }) => setPendingProbe({ authProviderId, displayName })} onArchive={(id) => archiveProvider.mutate(id)} onRestore={(id) => restoreProvider.mutate(id)} />}
    </CardContent></Card>;

  return <main className="mx-auto max-w-[100rem] space-y-6 p-4 md:p-8">
    <header><h1 className="text-2xl font-semibold">{connectionsFirst ? "Connections" : "Authentication"}</h1><p className="text-muted-foreground">{connectionsFirst ? "Set up a provider connection before configuring and running a workflow. Connections contain no secrets; API keys stay in separate Credentials." : "Store secret credentials separately from reusable runtime authentication configurations."}</p></header>
    {!connectionsFirst ? credentialWarning : null}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Show archived</label>
    {connectionsFirst ? <>{connectionCard}{credentialCard}</> : <>{credentialCard}{connectionCard}</>}
    <Dialog open={pendingProbe !== undefined} onOpenChange={(open) => { if (!open) setPendingProbe(undefined); }} aria-labelledby={probeTitleId} aria-describedby={probeWarningId}>
      <DialogHeader><DialogTitle id={probeTitleId}>Test connection?</DialogTitle></DialogHeader>
      <DialogContent className="space-y-4">
        <p>Test <strong>{pendingProbe?.displayName}</strong>?</p>
        <p id={probeWarningId}>This test may send a small model request, consume your provider quota, or incur charges. Continue only if you approve this request.</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setPendingProbe(undefined)}>Cancel</Button><Button disabled={probe.isPending || !pendingProbe} onClick={() => {
          if (!pendingProbe || probe.isPending) return;
          probe.mutate(pendingProbe.authProviderId);
          setPendingProbe(undefined);
        }}>Confirm connection test</Button></div>
      </DialogContent>
    </Dialog>
    {error ? <ErrorText error={error} /> : null}
  </main>;
}

function probeResultNotification(status: "connected" | "failed" | "action-required" | "indeterminate", message: string): ProbeNotification {
  if (status === "connected") return { title: "Connection succeeded", description: message, variant: "success" };
  if (status === "action-required") return { title: "Action required", description: message, variant: "warning" };
  if (status === "indeterminate") return { title: "Connection inconclusive", description: message, variant: "warning" };
  return { title: "Connection failed", description: message, variant: "error" };
}

type CredentialPreset = { presetId: string; label: string; modelProvider: string };
type AuthPreset = { presetId: string; label: string; executionProviderId: AgentAuthProviderDefinitionDto["executionProviderId"]; modelProvider?: string; targetVariable: string };

function CreateCredentialForm(props: { client: AgentAuthenticationApiClient; presets: CredentialPreset[]; onDone(): void | Promise<void>; onCancel(): void }) {
  const [presetId, setPresetId] = useState(props.presets[0]?.presetId ?? "");
  const [credentialId, setCredentialId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [credential, setCredential] = useState("");
  const mutation = useMutation({ mutationFn: async () => {
    const preset = props.presets.find((candidate) => candidate.presetId === presetId);
    if (!preset) throw fieldError("presetId", "Choose a credential type.");
    const definition: AgentCredentialDefinitionDto = { schemaVersion: 1, credentialId, displayName, kind: "api-key", modelProvider: preset.modelProvider };
    return props.client.createCredential({ definition, credential });
  }, onSuccess: props.onDone });
  return <FormValidation error={mutation.error}><form noValidate className="grid gap-4 rounded-md border p-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <Field name="presetId">Credential type<Select className="h-10 rounded-md border bg-background px-3" value={presetId} onChange={(event) => setPresetId(event.target.value)}>{props.presets.map((preset) => <option key={preset.presetId} value={preset.presetId}>{preset.label}</option>)}</Select></Field>
    <Field name="definition.credentialId">Credential ID<Input placeholder="my-anthropic-key" value={credentialId} onChange={(event) => setCredentialId(event.target.value)} /></Field>
    <Field name="definition.displayName">Display name<Input placeholder="My Anthropic key" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
    <Field name="credential">API key<Input type="password" autoComplete="new-password" value={credential} onChange={(event) => setCredential(event.target.value)} /></Field>
    <FormActions pending={mutation.isPending} submit="Save credential" onCancel={props.onCancel} />
  </form></FormValidation>;
}

function CreateProviderForm(props: { client: AgentAuthenticationApiClient; connectionsFirst: boolean; presets: AuthPreset[]; nativePresets: AgentAuthenticationMetadataResponseDto["nativeSessionPresets"]; credentials: AgentCredentialDto[]; onDone(): void | Promise<void>; onCancel(): void }) {
  const [presetId, setPresetId] = useState(props.nativePresets[0]?.presetId ?? props.presets[0]?.presetId ?? "");
  const [authProviderId, setAuthProviderId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const preset = props.presets.find((candidate) => candidate.presetId === presetId);
  const nativePreset = props.nativePresets.find((candidate) => candidate.presetId === presetId);
  const compatible = props.credentials.filter((item) => !preset?.modelProvider || item.definition.modelProvider === preset.modelProvider);
  const [credentialId, setCredentialId] = useState("");
  const selectedCredentialId = compatible.some((item) => item.definition.credentialId === credentialId) ? credentialId : compatible[0]?.definition.credentialId ?? "";
  const mutation = useMutation({ mutationFn: async () => {
    if (nativePreset) return props.client.create({ definition: {
      schemaVersion: 2, authProviderId, displayName, kind: "runtime-native",
      executionProviderId: nativePreset.executionProviderId, modelProvider: nativePreset.modelProvider,
    } });
    if (!preset) throw fieldError("presetId", "Choose a Connection type.");
    if (!selectedCredentialId) throw fieldError("definition.credentialId", "Create a compatible credential first.");
    const definition: AgentAuthProviderDefinitionDto = {
      schemaVersion: 2, authProviderId, displayName, kind: "stored-credential",
      executionProviderId: preset.executionProviderId,
      ...(preset.modelProvider ? { modelProvider: preset.modelProvider } : {}),
      credentialId: selectedCredentialId, targetVariable: preset.targetVariable,
    };
    return props.client.create({ definition });
  }, onSuccess: props.onDone });
  return <FormValidation error={mutation.error}><form noValidate className="grid gap-4 rounded-md border p-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <Field name="presetId">{props.connectionsFirst ? "Connection type" : "Configuration type"}<Select className="h-10 rounded-md border bg-background px-3" value={presetId} onChange={(event) => { setPresetId(event.target.value); setCredentialId(""); }}>{[...props.nativePresets, ...props.presets].map((candidate) => <option key={candidate.presetId} value={candidate.presetId}>{candidate.label}</option>)}</Select></Field>
    <Field name="definition.authProviderId">{props.connectionsFirst ? "Connection ID" : "Authentication configuration ID"}<Input placeholder="claude-with-my-key" value={authProviderId} onChange={(event) => setAuthProviderId(event.target.value)} /></Field>
    <Field name="definition.displayName">Display name<Input placeholder="Claude with my key" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
    {nativePreset ? <div className="rounded-md border p-3 text-sm" role="note"><p>{nativePreset.loginInstruction}</p><p>Required CLI version: {nativePreset.requiredVersion}. No credential is stored in ArkiMux. Saving does not test the connection or use provider quota.</p></div> : <Field name="definition.credentialId">Credential<Select className="h-10 rounded-md border bg-background px-3" value={selectedCredentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">Choose a compatible credential…</option>{compatible.map((item) => <option key={item.definition.credentialId} value={item.definition.credentialId}>{item.definition.displayName}</option>)}</Select></Field>}
    <FormActions pending={mutation.isPending} submit={props.connectionsFirst ? "Save connection" : "Save configuration"} onCancel={props.onCancel} />
  </form></FormValidation>;
}

function RotateCredentialForm(props: { client: AgentAuthenticationApiClient; credentialId: string; onDone(): void | Promise<void>; onCancel(): void }) {
  const [credential, setCredential] = useState("");
  const mutation = useMutation({ mutationFn: () => props.client.replaceCredential(props.credentialId, { credential }), onSuccess: props.onDone });
  return <FormValidation error={mutation.error}><form noValidate className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><Field name="credential">Replacement API key<Input aria-label="Replacement API key" type="password" autoComplete="new-password" value={credential} onChange={(event) => setCredential(event.target.value)} /></Field><Button type="submit">Replace</Button><Button type="button" variant="outline" onClick={props.onCancel}>Cancel</Button></form></FormValidation>;
}

function FormActions(props: { pending: boolean; submit: string; onCancel(): void }) {
  return <div className="flex gap-2 md:col-span-2"><Button type="submit" disabled={props.pending}>{props.pending ? "Saving…" : props.submit}</Button><Button type="button" variant="outline" onClick={props.onCancel}>Cancel</Button></div>;
}

function CredentialTable(props: { items: AgentCredentialDto[]; onRotate(id: string): void; onArchive(id: string): void; onRestore(id: string): void }) {
  if (!props.items.length) return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No credentials configured.</p>;
  return <div className="overflow-x-auto rounded-md border"><Table aria-label="Credentials"><TableHeader><TableRow><TableHead>Credential</TableHead><TableHead>Model provider</TableHead><TableHead>Value</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{props.items.map((item) => <TableRow key={item.definition.credentialId}><TableCell><p className="font-medium">{item.definition.displayName}</p><p className="text-xs text-muted-foreground">{item.definition.credentialId}</p></TableCell><TableCell>{item.definition.modelProvider}</TableCell><TableCell><Badge variant={item.valueAvailable ? "success" : "error"}>{item.valueAvailable ? "configured" : "missing"}</Badge></TableCell><TableCell><Lifecycle value={item.lifecycleStatus} /></TableCell><TableCell><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => props.onRotate(item.definition.credentialId)}>Replace key</Button>{item.lifecycleStatus === "active" ? <Button size="sm" variant="outline" onClick={() => props.onArchive(item.definition.credentialId)}>Archive</Button> : <Button size="sm" variant="outline" onClick={() => props.onRestore(item.definition.credentialId)}>Restore</Button>}</div></TableCell></TableRow>)}</TableBody></Table></div>;
}

function ProviderTable(props: { items: AgentAuthConfigurationCatalogItemDto[]; connectionsFirst: boolean; probingId?: string; onProbe(item: AgentAuthConfigurationCatalogItemDto): void; onArchive(id: string): void; onRestore(id: string): void }) {
  if (!props.items.length) return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{props.connectionsFirst ? "No connections are available." : "No authentication configurations are available."}</p>;
  return <div className="overflow-x-auto rounded-md border"><Table aria-label={props.connectionsFirst ? "Connections" : "Authentication configurations"}><TableHeader><TableRow><TableHead>{props.connectionsFirst ? "Connection" : "Configuration"}</TableHead><TableHead>Type</TableHead><TableHead>Runtime</TableHead><TableHead>Model provider</TableHead><TableHead>Credential or requirement</TableHead><TableHead>Lifecycle</TableHead><TableHead>{props.connectionsFirst ? "Readiness" : "Connection"}</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{props.items.map((item) => <TableRow key={item.authProviderId}><TableCell><p className="font-medium">{item.displayName}</p><p className="text-xs text-muted-foreground">{item.authProviderId}</p></TableCell><TableCell><Badge variant={item.origin === "platform" ? "primary" : "secondary"}>{item.kind === "runtime-native" ? "Native session" : "API key"}</Badge></TableCell><TableCell>{item.executionProviderId}</TableCell><TableCell>{item.modelProvider ?? "—"}</TableCell><TableCell>{item.loginRequirement ? <><p>{item.loginRequirement.application}</p><p className="max-w-72 text-xs text-muted-foreground">{item.loginRequirement.instruction}</p></> : item.credentialId}</TableCell><TableCell><Lifecycle value={item.lifecycleStatus} /></TableCell><TableCell><ProbeStatus item={item} /></TableCell><TableCell><div className="flex gap-2"><Button size="sm" variant="outline" disabled={props.probingId !== undefined} onClick={() => props.onProbe(item)}>{props.probingId === item.authProviderId ? "Testing…" : "Test connection"}</Button>{item.origin === "user" ? item.lifecycleStatus === "active" ? <Button size="sm" variant="outline" onClick={() => props.onArchive(item.authProviderId)}>Archive</Button> : <Button size="sm" variant="outline" onClick={() => props.onRestore(item.authProviderId)}>Restore</Button> : null}</div></TableCell></TableRow>)}</TableBody></Table></div>;
}

function ProbeStatus({ item }: { item: AgentAuthConfigurationCatalogItemDto }) {
  const probe = item.latestProbe;
  if (!probe) return <span className="text-sm text-muted-foreground">Never tested</span>;
  const variant = probe.status === "connected" ? "success" : probe.status === "action-required" ? "warning" : probe.status === "indeterminate" ? "secondary" : "error";
  const label = probe.status === "connected" ? "Connected" : probe.status === "action-required" ? "Action required" : probe.status === "indeterminate" ? "Connection inconclusive" : "Failed";
  const diagnosticDetails = [
    probe.externalDiagnostic?.code ? `Provider code: ${probe.externalDiagnostic.code}` : undefined,
    probe.externalDiagnostic?.httpStatus === undefined ? undefined : `HTTP ${probe.externalDiagnostic.httpStatus}`,
  ].filter(Boolean).join(" · ");
  return <div className="space-y-1"><Badge variant={variant}>{label}</Badge><p className="max-w-72 whitespace-pre-wrap break-words text-xs">{probe.message}</p>{diagnosticDetails ? <p className="max-w-72 whitespace-pre-wrap break-words text-xs text-muted-foreground">{diagnosticDetails}</p> : null}<p className="text-xs text-muted-foreground">{new Date(probe.checkedAt).toLocaleString()}</p>{probe.probeModel ? <p className="text-xs text-muted-foreground">{probe.probeModel}</p> : null}</div>;
}

function Lifecycle({ value }: { value: "active" | "archived" }) { return <Badge variant={value === "active" ? "success" : "warning"}>{value}</Badge>; }
function ErrorText({ error }: { error: unknown }) { return <ErrorNotification description={error instanceof Error ? error.message : String(error)} />; }
