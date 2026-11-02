import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useState, type ReactNode } from "react";
import { runStatusLabel, runStatusVariant } from "./runStatus.ts";
import type { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import type { ResultRendererRegistry } from "@com-pyvue/agent-execution-result-presentation";
import { Badge, Card, CardContent, CardHeader, CardTitle, Tabs, TabsContent, TabsList, TabsTrigger } from "@com-pyvue/agent-execution-ui";
import {
  useResolvedConfiguration,
  useRunArtifacts,
  useRunDetail,
  useRunInputRequests,
  useRunPerformance,
} from "./queries.ts";
import { RunResultsView } from "./resultView.tsx";
import { RunInputRequestsView } from "./inputRequestView.tsx";
import { RunCorrectionActions } from "./runCorrectionActions.tsx";
import {
  RunArtifactsView,
  RunConfigurationView,
  RunOverviewView,
  RunPerformanceView,
} from "./platformViews.tsx";

export interface RunDetailProps {
  client: RunApiClient;
  executionId: string;
  registry: ResultRendererRegistry;
  renderRunLink?(executionId: string, label: ReactNode): ReactNode;
  onRunSubmitted?(executionId: string): void;
}

export function RunDetail({ client, executionId, registry, renderRunLink, onRunSubmitted }: RunDetailProps) {
  const [tab, setTab] = useState("overview");
  const detail = useRunDetail(client, executionId, true);
  const artifacts = useRunArtifacts(client, executionId, tab === "artifacts");
  const inputRequests = useRunInputRequests(client, executionId, tab === "input");
  const performance = useRunPerformance(client, executionId, tab === "performance");
  const configuration = useResolvedConfiguration(client, executionId, tab === "configuration");
  if (detail.isPending) return <p>Loading run…</p>;
  if (detail.error || !detail.data) return <ErrorNotification description={message(detail.error)} />;
  const run = detail.data.run;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{run.runRef.executionId}</CardTitle>
          <Badge variant={runStatusVariant(run.status?.status ?? "unknown")}>{runStatusLabel(run.status?.status ?? "unknown")}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{run.workflow.kind}@{run.workflow.version} · {run.actor.userId}</p>
      </CardHeader>
      <CardContent>
        <RunCorrectionActions client={client} response={detail.data} renderRunLink={renderRunLink} onRunSubmitted={onRunSubmitted} />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4 flex h-auto flex-wrap">
            {['overview', 'input', 'results', 'artifacts', 'performance', 'configuration'].map((value) => (
              <TabsTrigger key={value} value={value}>{title(value)}</TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview"><RunOverviewView response={detail.data} /></TabsContent>
          <TabsContent value="input"><QueryBoundary query={inputRequests}>{(data) => <RunInputRequestsView client={client} executionId={executionId} response={data} runStatus={run.status} />}</QueryBoundary></TabsContent>
          <TabsContent value="results"><RunResultsView client={client} executionId={executionId} registry={registry} /></TabsContent>
          <TabsContent value="artifacts"><QueryBoundary query={artifacts}>{(data) => <RunArtifactsView client={client} executionId={executionId} response={data} />}</QueryBoundary></TabsContent>
          <TabsContent value="performance"><QueryBoundary query={performance}>{(data) => <RunPerformanceView response={data} />}</QueryBoundary></TabsContent>
          <TabsContent value="configuration"><QueryBoundary query={configuration}>{(data) => <RunConfigurationView response={data} />}</QueryBoundary></TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export interface RunDetailPageProps extends RunDetailProps {
  backLink?: ReactNode;
}

export function RunDetailPage({ backLink, ...detail }: RunDetailPageProps) {
  return (
    <main className="mx-auto max-w-[100rem] space-y-4 p-4 md:p-8">
      {backLink ? <nav aria-label="Run detail navigation">{backLink}</nav> : null}
      <header>
        <h1 className="text-2xl font-semibold">Run details</h1>
        <p className="text-muted-foreground">Inspect one authorized execution and its workflow-owned results.</p>
      </header>
      <RunDetail {...detail} />
    </main>
  );
}

function QueryBoundary<T>({ query, children }: { query: { isPending: boolean; error: unknown; data?: T }; children(data: T): ReactNode }) {
  if (query.isPending) return <p>Loading…</p>;
  if (query.error) return <ErrorNotification description={message(query.error)} />;
  return query.data === undefined ? null : children(query.data);
}

function title(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Run could not be loaded.");
}
