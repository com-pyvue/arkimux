import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useState } from "react";
import type { PublishedResultDto, RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import {
  ResultRendererErrorBoundary,
  ResultRendererRegistry,
  ResultRendererAlert,
  payloadSchemaVersion,
} from "@com-pyvue/agent-execution-result-presentation";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@com-pyvue/agent-execution-ui";
import { useRunInput, useRunResult, useRunResults } from "./queries.ts";
import { PlatformJsonView } from "./platformViews.tsx";

export interface RunResultsViewProps {
  client: RunApiClient;
  executionId: string;
  registry: ResultRendererRegistry;
}

export function RunResultsView({ client, executionId, registry }: RunResultsViewProps) {
  const results = useRunResults(client, executionId, true);
  const input = useRunInput(client, executionId, true);
  const [selectedResultId, setSelectedResultId] = useState<string>();
  const selected = selectedResultId ?? results.data?.items[0]?.resultId;
  const result = useRunResult(client, executionId, selected, selected !== undefined);
  if (results.isPending) return <p>Loading results…</p>;
  if (results.error) return <ErrorMessage error={results.error} />;
  if (!results.data) return null;
  return (
    <div className="space-y-4">
      <section className="space-y-4">
        <h3 className="font-semibold">Output</h3>
        {results.data.items.length === 0 ? <p className="text-muted-foreground">This run has no published results.</p> : <>
          <div className="flex flex-wrap gap-2">
            {results.data.items.map((item) => (
              <Button
                key={item.resultId}
                variant={selected === item.resultId ? "default" : "outline"}
                onClick={() => setSelectedResultId(item.resultId)}
              >
                {item.resultKind} <Badge>{item.payloadSchemaVersion ?? "unversioned"}</Badge>
              </Button>
            ))}
          </div>
          {result.isPending ? <p>Loading selected result…</p> : result.error ? <ErrorMessage error={result.error} /> : result.data ? (
            <ResultContent result={result.data} registry={registry} />
          ) : null}
        </>}
      </section>
      <section className="space-y-3 border-t pt-4">
        <h3 className="font-semibold">Input</h3>
        {input.isPending ? <p>Loading input…</p> : input.error ? <ErrorMessage error={input.error} /> : <PlatformJsonView value={input.data?.input ?? null} />}
      </section>
    </div>
  );
}

function ResultContent({ result, registry }: { result: PublishedResultDto; registry: ResultRendererRegistry }) {
  const [showJson, setShowJson] = useState(false);
  const version = payloadSchemaVersion(result.payload);
  const plugin = version === undefined ? undefined : registry.resolve(result.resultKind, version);
  if (!plugin) return <GenericJsonResult result={result} reason={registry.unavailableReason ?? "No compatible result renderer is installed."} alert={Boolean(registry.unavailableReason)} tone={registry.unavailableTone} />;
  let payload;
  try {
    payload = plugin.validatePayload(result.payload);
  } catch (error) {
    return <GenericJsonResult result={result} reason={`Result validation failed: ${message(error)}`} />;
  }
  const Component = plugin.Component;
  const validated = { ...result, payload };
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => setShowJson((current) => !current)}>{showJson ? "View rendered" : "View original JSON"}</Button></div>
      {showJson ? <PlatformJsonView value={result} /> : <ResultRendererErrorBoundary fallback={(error) => <GenericJsonResult result={result} reason={`Renderer failed: ${error.message}`} />}>
        <Component result={validated} />
      </ResultRendererErrorBoundary>}
    </div>
  );
}

function GenericJsonResult({ result, reason, alert = false, tone }: { result: PublishedResultDto; reason: string; alert?: boolean; tone?: "error" | "warning" }) {
  const serialized = JSON.stringify(result, null, 2);
  const href = `data:application/json;charset=utf-8,${encodeURIComponent(serialized)}`;
  return (
    <div className="space-y-3">
    {alert ? <ResultRendererAlert message={reason} tone={tone} /> : null}
    <Card>
      <CardHeader><CardTitle>Generic JSON result</CardTitle>{!alert ? <p className="text-sm text-muted-foreground">{reason}</p> : null}</CardHeader>
      <CardContent className="space-y-3">
        <a className="text-sm underline" href={href} download={result.resultId}>Download JSON</a>
        <pre className="max-h-[36rem] overflow-auto rounded-md bg-muted p-4 text-xs">{serialized}</pre>
      </CardContent>
    </Card>
    </div>
  );
}

function ErrorMessage({ error }: { error: unknown }) {
  return <ErrorNotification description={message(error)} />;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
