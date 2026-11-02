import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useMemo, useState, type ReactNode } from "react";
import { runStatusLabel } from "./runStatus.ts";
import type {
  JsonValue,
  ResolvedConfigurationResponseDto,
  RunApiClient,
  RunArtifactsResponseDto,
  RunDetailResponseDto,
  RunPerformanceResponseDto,
} from "@com-pyvue/agent-execution-run-contract";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@com-pyvue/agent-execution-ui";
import { useRunArtifactContent } from "./queries.ts";

export function PlatformJsonView({ value }: { value: unknown }) {
  return <pre className="max-h-[36rem] overflow-auto rounded-md bg-muted p-4 text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

export function PlatformRenderedOrJson({ rendered, value }: { rendered: ReactNode; value: unknown }) {
  const [json, setJson] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setJson((current) => !current)}>
          {json ? "View rendered" : "View JSON"}
        </Button>
      </div>
      {json ? <PlatformJsonView value={value} /> : rendered}
    </div>
  );
}

export function RunOverviewView({ response }: { response: RunDetailResponseDto }) {
  const { run } = response;
  const rows = [
    ["Status", runStatusLabel(run.status?.status ?? "Unknown")],
    ["Workflow", `${run.workflow.kind}@${run.workflow.version}`],
    ["User", run.actor.userId],
    ["Role", run.actor.roleId],
    ["Created", formatTimestamp(run.createdAt)],
    ["Last update", run.status ? formatTimestamp(run.status.updatedAt) : "—"],
    ["Current stage", run.heartbeat?.stageId ?? (run.status && "stageId" in run.status ? run.status.stageId : undefined) ?? "—"],
    ["Provider", run.heartbeat?.providerId ?? "—"],
    ["Configuration", run.runConfiguration?.configurationId ?? "—"],
  ];
  return <PlatformRenderedOrJson value={{ ...run, heartbeat: run.heartbeat ?? null }} rendered={
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map(([label, value]) => <Metric key={label} label={label} value={value} />)}
      {run.status?.status === "failed" ? <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 sm:col-span-2 xl:col-span-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Failure</p><p className="mt-1 whitespace-pre-wrap break-words text-sm text-destructive">{run.status.message}</p></div> : null}
    </div>
  } />;
}

export function RunArtifactsView({
  client,
  executionId,
  response,
}: {
  client: RunApiClient;
  executionId: string;
  response: RunArtifactsResponseDto;
}) {
  const [selectedKey, setSelectedKey] = useState<string>();
  const selected = selectedKey;
  const content = useRunArtifactContent(client, executionId, selected, selected !== undefined);
  return <PlatformRenderedOrJson value={response} rendered={
    <div className="grid gap-4 xl:grid-cols-[minmax(24rem,0.9fr)_minmax(0,1.1fr)]">
      <div className="overflow-x-auto rounded-lg border">
        <Table aria-label="Run artifacts">
          <TableHeader><TableRow><TableHead>Artifact</TableHead><TableHead>Type</TableHead><TableHead>Size</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {response.items.map((artifact) => <TableRow key={artifact.key} data-selected={selected === artifact.key || undefined}>
              <TableCell className="max-w-[24rem] break-all font-mono text-xs">{artifact.key}</TableCell>
              <TableCell>{artifact.mediaType}</TableCell>
              <TableCell>{formatBytes(artifact.sizeBytes)}</TableCell>
              <TableCell><Button size="sm" variant={selected === artifact.key ? "default" : "outline"} onClick={() => setSelectedKey(artifact.key)}>Preview</Button></TableCell>
            </TableRow>)}
            {response.items.length === 0 ? <TableRow><TableCell colSpan={4}>This run has no artifacts.</TableCell></TableRow> : null}
          </TableBody>
        </Table>
      </div>
      <Card className="min-w-0 shadow-none">
        <CardHeader><CardTitle>Artifact preview</CardTitle></CardHeader>
        <CardContent>
          {!selected ? <p className="text-sm text-muted-foreground">Select an artifact.</p>
            : content.isPending ? <p>Loading artifact…</p>
              : content.error ? <ErrorMessage error={content.error} />
                : content.data ? <ArtifactContentView response={content.data} /> : null}
        </CardContent>
      </Card>
    </div>
  } />;
}

function ArtifactContentView({ response }: { response: Awaited<ReturnType<RunApiClient["getArtifactContent"]>> }) {
  const href = response.encoding === "base64"
    ? `data:${response.artifact.mediaType};base64,${response.content}`
    : `data:${response.artifact.mediaType};charset=utf-8,${encodeURIComponent(response.content)}`;
  const parsed = useMemo(() => {
    if (response.encoding !== "utf8" || response.artifact.mediaType !== "application/json") return undefined;
    try { return JSON.parse(response.content) as JsonValue; } catch { return undefined; }
  }, [response]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="break-all font-mono text-xs">{response.artifact.key}</p><p className="text-xs text-muted-foreground">{response.artifact.mediaType} · {formatBytes(response.artifact.sizeBytes)}</p></div>
        <Button asChild size="sm" variant="outline"><a href={href} download={fileName(response.artifact.key)}>Download</a></Button>
      </div>
      {response.encoding === "base64"
        ? <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">Binary artifact. Download it to inspect its contents.</p>
        : parsed !== undefined
          ? <PlatformJsonView value={parsed} />
          : <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-xs">{response.content}</pre>}
    </div>
  );
}

export function RunPerformanceView({ response }: { response: RunPerformanceResponseDto }) {
  const performance = response.performance;
  if (!performance) return <PlatformRenderedOrJson value={response} rendered={<p className="text-muted-foreground">No performance record was published for this run.</p>} />;
  const usage = performance.usage;
  const costs = usage?.costs?.map(({ amount, currency }) => `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency}`).join(" + ") ?? "—";
  return <PlatformRenderedOrJson value={response} rendered={
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Total time" value={formatDuration(performance.totalElapsedMs)} />
        <Metric label="Input tokens" value={formatNumber(usage?.inputTokens)} />
        <Metric label="Cached input" value={formatNumber(usage?.cachedInputTokens)} />
        <Metric label="Output tokens" value={formatNumber(usage?.outputTokens)} />
        <Metric label="Reasoning tokens" value={formatNumber(usage?.reasoningOutputTokens)} />
        <Metric label="Cost" value={costs} />
        <Metric label="Started" value={formatTimestamp(performance.startedAt)} />
        <Metric label="Completed" value={formatTimestamp(performance.completedAt)} />
      </div>
      <section className="space-y-2"><h3 className="font-semibold">Stages</h3><div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Stage</TableHead><TableHead>Status</TableHead><TableHead>Time</TableHead></TableRow></TableHeader><TableBody>{performance.stages.map((stage) => <TableRow key={stage.stageId}><TableCell>{stage.stageId}</TableCell><TableCell><Badge>{stage.status}</Badge></TableCell><TableCell>{formatDuration(stage.elapsedMs)}</TableCell></TableRow>)}</TableBody></Table></div></section>
      <section className="space-y-2">
        <h3 className="font-semibold">Agent attempts</h3>
        <p className="text-sm text-muted-foreground">Attempt numbers identify retries. — means the runtime did not report a value, not zero.</p>
        <div className="overflow-x-auto rounded-lg border"><Table aria-label="Agent attempt performance">
          <TableHeader><TableRow>{["Agent", "Stage", "Attempt", "Provider", "Model", "Status", "Time", "Input tokens", "Cached input", "Output tokens", "Reasoning tokens", "Tool calls", "Searches"].map((label) => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{performance.agentAttempts.map((attempt, index) => <TableRow key={`${attempt.stageId}-${attempt.logicalAgentId}-${index}`}>
            <TableCell>{attempt.logicalAgentId}</TableCell><TableCell>{attempt.stageId}</TableCell>
            <TableCell>{attempt.metrics.attempt ?? "—"}</TableCell>
            <TableCell>{attempt.metrics.providerId}</TableCell><TableCell>{attempt.metrics.model ?? "—"}</TableCell>
            <TableCell><Badge variant={attempt.metrics.status === "complete" ? "success" : "error"}>{attempt.metrics.status}</Badge></TableCell>
            <TableCell>{formatDuration(attempt.metrics.elapsedMs)}</TableCell>
            <TableCell>{formatNumber(attempt.metrics.usage?.inputTokens)}</TableCell>
            <TableCell>{formatNumber(attempt.metrics.usage?.cachedInputTokens)}</TableCell>
            <TableCell>{formatNumber(attempt.metrics.usage?.outputTokens)}</TableCell>
            <TableCell>{formatNumber(attempt.metrics.usage?.reasoningOutputTokens)}</TableCell>
            <TableCell>{attempt.metrics.nativeToolCalls.toLocaleString()}</TableCell><TableCell>{formatNumber(attempt.metrics.repositorySearchCalls)}</TableCell>
          </TableRow>)}</TableBody>
        </Table></div>
      </section>
    </div>
  } />;
}

export function RunConfigurationView({ response }: { response: ResolvedConfigurationResponseDto }) {
  const configuration = response.resolvedConfiguration;
  if (configuration === null) return <PlatformRenderedOrJson value={response} rendered={<p className="text-muted-foreground">No resolved configuration was stored for this run.</p>} />;
  const record = asRecord(configuration);
  const agents = asRecord(record?.agents);
  const stores = asRecord(record?.stores);
  return <PlatformRenderedOrJson value={response} rendered={
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Configuration" value={stringValue(record?.configurationId)} />
        <Metric label="Workflow" value={identity(record?.workflow)} />
        <Metric label="Agents" value={String(Object.keys(agents ?? {}).length)} />
        <Metric label="Store bindings" value={String(Object.keys(stores ?? {}).length)} />
      </div>
      {Object.entries(record ?? {}).filter(([key]) => !["configurationId", "workflow"].includes(key)).map(([key, value]) => <section key={key} className="space-y-2"><h3 className="font-semibold">{humanize(key)}</h3><PlatformJsonView value={value} /></section>)}
    </div>
  } />;
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div className="rounded-lg border p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p><div className="mt-1 break-words text-sm font-medium">{value}</div></div>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function identity(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.kind === "string" && typeof record.version === "number" ? `${record.kind}@${record.version}` : "—";
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : "—"; }
function humanize(value: string): string { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase()); }
function fileName(key: string): string { return key.split("/").at(-1) ?? "artifact"; }
function formatTimestamp(value: string): string { return new Date(value).toLocaleString(); }
function formatNumber(value: number | undefined): string { return value === undefined ? "—" : value.toLocaleString(); }
function formatDuration(value: number): string { return value < 1_000 ? `${value} ms` : `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`; }
function formatBytes(value: number): string { return value < 1_024 ? `${value} B` : `${(value / 1_024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`; }
function ErrorMessage({ error }: { error: unknown }) { return <ErrorNotification description={error instanceof Error ? error.message : String(error)} />; }
