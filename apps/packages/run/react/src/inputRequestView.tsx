import { useState, type ChangeEvent, type FormEvent } from "react";
import type { InputRequestsResponseDto, JsonValue, RunApiClient, RunDetailResponseDto } from "@com-pyvue/agent-execution-run-contract";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, FormValidation, Input, Select, fieldError } from "@com-pyvue/agent-execution-ui";
import { useSubmitRunInput } from "./queries.ts";
import { GraphRequirementField, graphRequirementTitle } from "./graphRequirementField.tsx";

type InputItem = InputRequestsResponseDto["items"][number];
type ScalarItem = Extract<InputItem, { definition: unknown }>;
type GraphItem = Extract<InputItem, { kind: "graph-entry" }>;
type ScalarField = ScalarItem["definition"]["form"]["fields"][number];
type FileRef = NonNullable<ScalarItem["response"]>["files"][string][number];

export function RunInputRequestsView(props: {
  client: RunApiClient;
  executionId: string;
  response: InputRequestsResponseDto;
  runStatus?: RunDetailResponseDto["run"]["status"];
}) {
  if (props.response.items.length === 0) {
    return <p className="text-sm text-muted-foreground">This Run has no input requests.</p>;
  }
  return <div className="space-y-4">
    {props.runStatus?.status === "waiting_for_input" ? <section className="grid gap-3 rounded-md border bg-muted/30 p-4 sm:grid-cols-2">
      <Metric label="Active compute" value={duration(props.runStatus.activeComputeMs)} />
      <Metric label="Current input wait" value={duration(Math.max(0, Date.now() - Date.parse(props.runStatus.updatedAt)))} />
      <p className="col-span-full text-xs text-muted-foreground">Waiting for a person does not consume active workflow compute.</p>
    </section> : null}
    {props.response.items.map(item => "kind" in item
      ? <GraphInputRequest key={item.requestId} client={props.client} executionId={props.executionId} item={item} />
      : <ScalarInputRequest key={item.definition.requestId} client={props.client} executionId={props.executionId} item={item} />)}
  </div>;
}

function GraphInputRequest(props: { client: RunApiClient; executionId: string; item: GraphItem }) {
  const submit = useSubmitRunInput(props.client, props.executionId);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(props.item.requirements.map(requirement => [requirement.id, ""] )));
  const [localError, setLocalError] = useState<unknown>();
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const parsed: Record<string, JsonValue> = {};
      for (const requirement of props.item.requirements) {
        const raw = values[requirement.id] ?? "";
        if (!raw.trim()) throw fieldError(`values.${requirement.id}`, "This field is required.");
        try { parsed[requirement.id] = JSON.parse(raw) as JsonValue; }
        catch { throw fieldError(`values.${requirement.id}`, "Enter valid JSON."); }
      }
      setLocalError(undefined);
      submit.mutate({ requestId: props.item.requestId, submission: {
        submissionId: `answer-${crypto.randomUUID()}`,
        expectedRevision: props.item.revision,
        response: { schemaVersion: 1, planSha256: props.item.planSha256, values: parsed },
      } });
    } catch (error) { setLocalError(error); }
  };
  const primary = props.item.requirements[0];
  const title = primary ? `${graphRequirementTitle(primary)} required` : "Workflow input required";
  return <Card><CardHeader><RequestHeading title={title} status={props.item.status} /></CardHeader><CardContent className="space-y-4">
    <RequestMetadata requestId={props.item.requestId} status={props.item.status} createdAt={props.item.createdAt} expiresAt={props.item.expiresAt} updatedAt={props.item.updatedAt} />
    {props.item.status === "pending" ? <FormValidation error={localError ?? submit.error}><form noValidate className="space-y-4" onSubmit={onSubmit}>
      {props.item.requirements.map(requirement => <GraphRequirementField key={requirement.id}
        requirement={requirement} name={`values.${requirement.id}`} value={values[requirement.id] ?? ""}
        onChange={value => { setValues(current => ({ ...current, [requirement.id]: value })); setLocalError(undefined); }} />)}
      <Button type="submit" disabled={submit.isPending}>{submit.isPending ? "Submitting…" : "Submit input"}</Button>
    </form></FormValidation> : <TerminalInputState item={props.item} />}
  </CardContent></Card>;
}

function ScalarInputRequest(props: { client: RunApiClient; executionId: string; item: ScalarItem }) {
  const submit = useSubmitRunInput(props.client, props.executionId);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [files, setFiles] = useState<Record<string, FileRef[]>>({});
  const [uploading, setUploading] = useState<string>();
  const [localError, setLocalError] = useState<unknown>();
  const upload = async (field: Extract<ScalarField, { type: "files" }>, event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])];
    if (!selected.length) return;
    setUploading(field.id); setLocalError(undefined);
    try {
      const uploaded: FileRef[] = [];
      for (const file of selected) {
        const result = await props.client.uploadInputFile(props.executionId, props.item.definition.requestId, {
          fieldId: field.id, uploadId: `upload-${crypto.randomUUID()}`, file, filename: file.name,
        });
        uploaded.push(result.file);
      }
      setFiles(current => ({ ...current, [field.id]: [...(current[field.id] ?? []), ...uploaded] }));
    } catch (error) { setLocalError(error); }
    finally { setUploading(undefined); event.target.value = ""; }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    try {
      for (const field of props.item.definition.form.fields) {
        const answered = field.type === "files" ? (files[field.id]?.length ?? 0) > 0 : values[field.id] !== undefined && values[field.id] !== "";
        if (field.required && !answered) throw fieldError(field.type === "files" ? `files.${field.id}` : `fields.${field.id}`, "This field is required.");
      }
      setLocalError(undefined);
      submit.mutate({ requestId: props.item.definition.requestId, submission: {
        submissionId: `answer-${crypto.randomUUID()}`,
        expectedRevision: props.item.revision,
        response: { schemaVersion: 1, fields: values, files },
      } });
    } catch (error) { setLocalError(error); }
  };
  return <Card><CardHeader><RequestHeading title={props.item.definition.title} status={props.item.status} /></CardHeader><CardContent className="space-y-4">
    <RequestMetadata requestId={props.item.definition.requestId} status={props.item.status} createdAt={props.item.definition.createdAt} expiresAt={props.item.definition.expiresAt} updatedAt={props.item.updatedAt} />
    {props.item.status === "pending" ? <FormValidation error={localError ?? submit.error}><form noValidate className="space-y-4" onSubmit={onSubmit}>
      {props.item.definition.form.fields.map(field => <ScalarFieldControl key={field.id} field={field} value={values[field.id]}
        files={files[field.id] ?? []} uploading={uploading === field.id}
        onChange={value => { setValues(current => ({ ...current, [field.id]: value })); setLocalError(undefined); }}
        onFiles={field.type === "files" ? event => void upload(field, event) : undefined} />)}
      <Button type="submit" disabled={submit.isPending || Boolean(uploading)}>{submit.isPending ? "Submitting…" : "Submit input"}</Button>
    </form></FormValidation> : <TerminalInputState item={props.item} />}
  </CardContent></Card>;
}

function ScalarFieldControl(props: { field: ScalarField; value: string | number | boolean | undefined; files: FileRef[];
  uploading: boolean; onChange(value: string | number | boolean): void; onFiles?(event: ChangeEvent<HTMLInputElement>): void }) {
  const field = props.field;
  const name = field.type === "files" ? `files.${field.id}` : `fields.${field.id}`;
  if (field.type === "boolean") return <Field name={name}><span className="flex items-center gap-2"><Input type="checkbox" checked={props.value === true} onChange={event => props.onChange(event.target.checked)} />{field.label}</span></Field>;
  if (field.type === "choice") return <Field name={name}>{field.label}<Select className="h-10 rounded-md border bg-background px-3" value={String(props.value ?? "")} onChange={event => props.onChange(event.target.value)}><option value="">Choose…</option>{field.options.map(option => <option key={option}>{option}</option>)}</Select></Field>;
  if (field.type === "files") return <Field name={name}>{field.label}<Input type="file" multiple={field.maxFiles > 1} accept={field.mediaTypes.join(",")} onChange={props.onFiles} disabled={props.uploading} />
    <span className="text-xs font-normal text-muted-foreground">{props.uploading ? "Uploading…" : props.files.length ? `${props.files.length} file(s) uploaded.` : `Up to ${field.maxFiles} file(s), ${field.maxBytesPerFile} bytes each.`}</span></Field>;
  let inputType: "number" | "date" | "text" = "text";
  if (field.type === "number") inputType = "number";
  else if (field.type === "date") inputType = "date";
  return <Field name={name}>{field.label}<Input type={inputType}
    value={String(props.value ?? "")} {...(field.type === "text" ? { maxLength: field.maxLength } : {})}
    {...(field.type === "number" ? { min: field.min, max: field.max, step: field.integer ? 1 : "any" } : {})}
    onChange={event => props.onChange(field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} /></Field>;
}

function TerminalInputState({ item }: { item: InputItem }) {
  if (item.status === "submitted") return <section className="rounded-md border bg-muted/30 p-3 text-sm">
    <p className="font-medium">Input accepted</p>
    {"response" in item && item.response ? <pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(item.response, null, 2)}</pre> : null}
    {"accepted" in item && item.accepted ? <p className="mt-1 text-muted-foreground">Accepted {date(item.accepted.acceptedAt)}. Values remain protected; integrity hash: <code>{item.accepted.acceptedBodySha256}</code>.</p> : null}
  </section>;
  return <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">This input request is {item.status}. It can no longer be submitted.</p>;
}

function RequestHeading({ title, status }: { title: string; status: InputItem["status"] }) {
  return <div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>{title}</CardTitle><Badge variant={requestStatusVariant(status)}>{status}</Badge></div>;
}
function RequestMetadata(props: { requestId: string; status: InputItem["status"]; createdAt: string; expiresAt: string; updatedAt: string }) {
  const observedEnd = props.status === "pending" ? Date.now() : Date.parse(props.updatedAt);
  const waitEnd = Math.min(observedEnd, Date.parse(props.expiresAt));
  return <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
    <Meta label="Request" value={props.requestId} mono /><Meta label="Created" value={date(props.createdAt)} />
    <Meta label="Deadline" value={date(props.expiresAt)} /><Meta label="Input wait" value={duration(Math.max(0, waitEnd - Date.parse(props.createdAt)))} />
  </dl>;
}
function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt className="text-xs uppercase text-muted-foreground">{label}</dt><dd className={mono ? "break-all font-mono text-xs" : ""}>{value}</dd></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div><p className="text-xs uppercase text-muted-foreground">{label}</p><p className="font-medium">{value}</p></div>; }
function date(value: string): string { return new Date(value).toLocaleString(); }
function duration(ms: number): string { const seconds = Math.round(ms / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function requestStatusVariant(status: InputItem["status"]): "warning" | "success" | "secondary" {
  if (status === "pending") return "warning";
  if (status === "submitted") return "success";
  return "secondary";
}
