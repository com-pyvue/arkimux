import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { SortingState } from "@tanstack/react-table";
import type { RunApiClient, RunListQueryDto, RunNumericField, RunSortField } from "@com-pyvue/agent-execution-run-contract";
import type { ResultRendererRegistry } from "@com-pyvue/agent-execution-result-presentation";
import { Field, FormValidation, Select, fieldError, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@com-pyvue/agent-execution-ui";
import { ComparisonTable } from "./comparisonTable.tsx";
import { useArchiveRun, useRestoreRun, useRunComparison, useRunFilterOptions, useRunList, useWorkflows } from "./queries.ts";
import { configurableRunColumns, summaryFieldsForColumns, useRunColumnPreferences, type ConfigurableRunColumnId } from "./runColumns.ts";
import { RunTable } from "./runTable.tsx";

export interface RunFeatureProps {
  client: RunApiClient;
  resultRenderers: ResultRendererRegistry;
  columnPreferenceKey?: string;
  defaultColumns?: readonly ConfigurableRunColumnId[];
  renderRunLink?(executionId: string, label: ReactNode): ReactNode;
  fixedWorkflow?: { kind: string; version: number };
  embedded?: boolean;
}

interface FilterDraft {
  workflow: string;
  status: string;
  showArchived: boolean;
  providers: string[];
  models: string[];
  fromDate: string;
  toDate: string;
  numericField: RunNumericField;
  numericMin: string;
  numericMax: string;
}

const initialFilters: FilterDraft = {
  workflow: "",
  status: "",
  showArchived: false,
  providers: [],
  models: [],
  fromDate: "",
  toDate: "",
  numericField: "totalElapsedMs",
  numericMin: "",
  numericMax: "",
};

export function RunFeature({ client, resultRenderers: _resultRenderers, columnPreferenceKey = "anonymous", defaultColumns, renderRunLink, fixedWorkflow, embedded = false }: RunFeatureProps) {
  const fixedWorkflowValue = fixedWorkflow ? `${fixedWorkflow.kind}@${fixedWorkflow.version}` : "";
  const freshFilters = (): FilterDraft => ({ ...initialFilters, workflow: fixedWorkflowValue });
  const [draft, setDraft] = useState<FilterDraft>(freshFilters);
  const [filterError, setFilterError] = useState<unknown>();
  const [query, setQuery] = useState<RunListQueryDto>({ pageSize: 20, lifecycleStatus: "active", sort: { field: "createdAt", direction: "desc" }, ...(fixedWorkflow ? { workflow: fixedWorkflow } : {}) });
  const [sorting, setSorting] = useState<SortingState>([{ id: "createdAt", desc: true }]);
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [selectedExecutionIds, setSelectedExecutionIds] = useState<string[]>([]);
  const [comparisonRequested, setComparisonRequested] = useState(false);
  const columnPreferences = useRunColumnPreferences(columnPreferenceKey, defaultColumns);
  const summaryFields = useMemo(() => summaryFieldsForColumns(columnPreferences.columns), [columnPreferences.columns]);
  const effectiveQuery = useMemo<RunListQueryDto>(() => ({ ...query, ...(summaryFields.length === 0 ? {} : { summaryFields }) }), [query, summaryFields]);
  const runs = useRunList(client, effectiveQuery);
  const workflows = useWorkflows(client);
  const filterOptions = useRunFilterOptions(client);
  const archive = useArchiveRun(client);
  const restore = useRestoreRun(client);
  const comparisonIds = useMemo(() => [...selectedExecutionIds].sort(), [selectedExecutionIds]);
  const comparison = useRunComparison(client, comparisonIds, comparisonRequested);
  const archivableExecutionIds = useMemo(() => {
    const selected = new Set(selectedExecutionIds);
    return (runs.data?.items ?? []).filter((run) => {
      const status = run.status?.status;
      return selected.has(run.runRef.executionId)
        && (run.lifecycleStatus ?? "active") === "active"
        && (status === "complete" || status === "failed" || status === "cancelled");
    }).map((run) => run.runRef.executionId);
  }, [runs.data?.items, selectedExecutionIds]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    try {
      const workflow = fixedWorkflow ?? (draft.workflow ? parseWorkflow(draft.workflow) : undefined);
      const min = optionalNumber(draft.numericMin, "numericRange.min");
      const max = optionalNumber(draft.numericMax, "numericRange.max");
      if (min !== undefined && max !== undefined && min > max) throw fieldError("numericRange.min", "Minimum must not exceed maximum.");
      setFilterError(undefined);
      setCursorHistory([]);
      setSelectedExecutionIds([]);
      setComparisonRequested(false);
      setQuery({
        pageSize: query.pageSize ?? 20,
        lifecycleStatus: draft.showArchived ? "all" : "active",
        sort: sortFromTable(sorting),
        ...(workflow ? { workflow } : {}),
        ...(draft.status ? { status: draft.status as RunListQueryDto["status"] } : {}),
        ...(draft.providers.length === 0 ? {} : { providers: draft.providers }),
        ...(draft.models.length === 0 ? {} : { models: draft.models }),
        ...(draft.fromDate ? { createdAtOrAfter: dateStart(draft.fromDate) } : {}),
        ...(draft.toDate ? { createdBefore: nextDateStart(draft.toDate) } : {}),
        ...(min === undefined && max === undefined ? {} : { numericRange: { field: draft.numericField, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) } }),
      });
    } catch (error) {
      setFilterError(error);
    }
  }

  function changeSorting(next: SortingState) {
    const normalized = next.length === 0 ? [{ id: "createdAt", desc: true }] : [next[0]!];
    setSorting(normalized);
    setCursorHistory([]);
    setQuery((current) => ({ ...withoutCursor(current), sort: sortFromTable(normalized) }));
  }

  function changePageSize(pageSize: 10 | 20 | 50 | 100) {
    setCursorHistory([]);
    setSelectedExecutionIds([]);
    setComparisonRequested(false);
    setQuery((current) => ({ ...withoutCursor(current), pageSize }));
  }

  async function archiveSelectedRuns() {
    await Promise.all(archivableExecutionIds.map((executionId) => archive.mutateAsync(executionId)));
    setSelectedExecutionIds([]);
    setComparisonRequested(false);
  }

  const content = <>
    {!embedded ? <header><h1 className="text-2xl font-semibold">Agent execution runs</h1><p className="text-muted-foreground">Filter, sort, inspect, archive, and compare authorized executions.</p></header> : null}
    <Card><CardHeader><CardTitle>Run catalog</CardTitle></CardHeader><CardContent className="space-y-4">
      <FormValidation error={filterError ?? runs.error}><form noValidate className="space-y-4" onChange={() => setFilterError(undefined)} onSubmit={applyFilters}>
        <div className={fixedWorkflow ? "grid gap-3 md:grid-cols-3" : "grid gap-3 md:grid-cols-2 xl:grid-cols-4"}>
          {!fixedWorkflow ? <Field name="workflow" className="grid gap-1 text-sm font-medium">Workflow<Select className="h-10 rounded-md border bg-background px-3" value={draft.workflow} onChange={(event) => setDraft((value) => ({ ...value, workflow: event.target.value }))}><option value="">All workflows</option>{workflows.data?.items.map(({ workflow, title }) => <option key={`${workflow.kind}@${workflow.version}`} value={`${workflow.kind}@${workflow.version}`}>{title} · {workflow.kind}@{workflow.version}</option>)}</Select></Field> : null}
          <Field name="status" className="grid gap-1 text-sm font-medium">Status<Select className="h-10 rounded-md border bg-background px-3" value={draft.status} onChange={(event) => setDraft((value) => ({ ...value, status: event.target.value }))}><option value="">All statuses</option><option value="running">Running</option><option value="waiting_for_input">Waiting for input</option><option value="resume_queued">Resume queued</option><option value="complete">Complete</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></Select></Field>
          <Field name="createdAtOrAfter" className="grid gap-1 text-sm font-medium">From date<Input type="date" value={draft.fromDate} onChange={(event) => setDraft((value) => ({ ...value, fromDate: event.target.value }))} /></Field>
          <Field name="createdBefore" className="grid gap-1 text-sm font-medium">To date<Input type="date" value={draft.toDate} onChange={(event) => setDraft((value) => ({ ...value, toDate: event.target.value }))} /></Field>
        </div>
        <div className="grid gap-3 lg:grid-cols-2"><MultiSelect label="Providers" values={filterOptions.data?.providers ?? []} selected={draft.providers} onChange={(providers) => setDraft((value) => ({ ...value, providers }))} /><MultiSelect label="Models" values={filterOptions.data?.models ?? []} selected={draft.models} onChange={(models) => setDraft((value) => ({ ...value, models }))} /></div>
        <fieldset className="grid gap-3 rounded-md border p-3 md:grid-cols-3"><legend className="px-1 text-sm font-medium">Numeric range</legend><Field name="numericRange.field" className="grid gap-1 text-sm">Field<Select className="h-10 rounded-md border bg-background px-3" value={draft.numericField} onChange={(event) => setDraft((value) => ({ ...value, numericField: event.target.value as RunNumericField }))}>{numericFields.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</Select></Field><Field name="numericRange.min" className="grid gap-1 text-sm">Minimum<Input type="number" min="0" placeholder="No minimum" value={draft.numericMin} onChange={(event) => setDraft((value) => ({ ...value, numericMin: event.target.value }))} /></Field><Field name="numericRange.max" className="grid gap-1 text-sm">Maximum<Input type="number" min="0" placeholder="No maximum" value={draft.numericMax} onChange={(event) => setDraft((value) => ({ ...value, numericMax: event.target.value }))} /></Field></fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.showArchived} onChange={(event) => setDraft((value) => ({ ...value, showArchived: event.target.checked }))} />Show archived</label>
        <div className="flex gap-2"><Button type="submit">Apply filters</Button><Button type="button" variant="outline" onClick={() => setDraft(freshFilters())}>Reset form</Button></div>
      </form></FormValidation>

      <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium">Choose table columns</summary><fieldset className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><legend className="sr-only">Optional run columns</legend>{configurableRunColumns.map((column) => <label key={column.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={columnPreferences.columns.includes(column.id)} onChange={(event) => columnPreferences.setColumns(event.target.checked ? [...columnPreferences.columns, column.id] : columnPreferences.columns.filter((id) => id !== column.id))} />{column.label}</label>)}</fieldset></details>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3"><Button disabled={selectedExecutionIds.length < 2 || selectedExecutionIds.length > 20} onClick={() => setComparisonRequested(true)}>Compare {selectedExecutionIds.length} runs</Button><label className="grid gap-1 text-sm font-medium">Rows per page<Select className="h-9 rounded-md border bg-background px-3" value={query.pageSize ?? 20} onChange={(event) => changePageSize(Number(event.target.value) as 10 | 20 | 50 | 100)}>{[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</Select></label><span className="pb-2 text-sm text-muted-foreground">Select 2–20 runs to compare.</span></div>
        <Button variant="outline" disabled={archivableExecutionIds.length === 0 || archive.isPending} onClick={() => void archiveSelectedRuns()}>Archive selected ({archivableExecutionIds.length})</Button>
      </div>
      {runs.isPending ? <p>Loading runs…</p> : runs.error ? null : <><RunTable runs={runs.data?.items ?? []} selectedExecutionIds={selectedExecutionIds} onSelectedExecutionIdsChange={(ids) => { setSelectedExecutionIds(ids); setComparisonRequested(false); }} renderRunLink={renderRunLink} visibleColumns={columnPreferences.columns} sorting={sorting} onSortingChange={changeSorting} onArchive={(id) => archive.mutate(id)} onRestore={(id) => restore.mutate(id)} /><div className="flex justify-end gap-2"><Button variant="outline" disabled={cursorHistory.length === 0} onClick={() => { const previous = cursorHistory.at(-1); setCursorHistory((history) => history.slice(0, -1)); setQuery((current) => withCursor(current, previous)); }}>Previous page</Button><Button variant="outline" disabled={!runs.data?.pagination.nextCursor} onClick={() => { const next = runs.data?.pagination.nextCursor; if (!next) return; setCursorHistory((history) => [...history, query.cursor]); setQuery((current) => withCursor(current, next)); }}>Next page</Button></div></>}
      {archive.error || restore.error ? <ErrorNotification description={message(archive.error ?? restore.error)} /> : null}
    </CardContent></Card>
    <Dialog open={comparisonRequested} onOpenChange={setComparisonRequested} className="w-[min(96rem,calc(100%-2rem))]"><DialogHeader><DialogTitle>Run comparison</DialogTitle></DialogHeader><DialogContent>{comparison.isPending ? <p>Loading comparison…</p> : comparison.error ? <ErrorNotification description={message(comparison.error)} /> : comparison.data ? <ComparisonTable rows={comparison.data.rows} /> : null}<div className="mt-4 flex justify-end"><Button variant="outline" onClick={() => setComparisonRequested(false)}>Close</Button></div></DialogContent></Dialog>
  </>;
  return embedded
    ? <section className="space-y-6">{content}</section>
    : <main className="mx-auto max-w-[100rem] space-y-6 p-4 md:p-8">{content}</main>;
}

function MultiSelect(props: { label: string; values: string[]; selected: string[]; onChange(values: string[]): void }) { return <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">{props.label}{props.selected.length > 0 ? ` (${props.selected.length})` : ""}</summary><div className="mt-3 flex max-h-40 flex-wrap gap-3 overflow-auto">{props.values.length === 0 ? <span className="text-sm text-muted-foreground">No values discovered.</span> : props.values.map((value) => <label key={value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={props.selected.includes(value)} onChange={(event) => props.onChange(event.target.checked ? [...props.selected, value] : props.selected.filter((item) => item !== value))} />{value}</label>)}</div></details>; }

const numericFields: Array<{ id: RunNumericField; label: string }> = [
  { id: "totalElapsedMs", label: "Total time (ms)" }, { id: "inputTokens", label: "Input tokens" }, { id: "cachedInputTokens", label: "Cached input tokens" }, { id: "outputTokens", label: "Output tokens" }, { id: "reasoningOutputTokens", label: "Reasoning tokens" }, { id: "toolCalls", label: "Tool calls" }, { id: "searchCalls", label: "Search calls" },
];
function parseWorkflow(value: string): { kind: string; version: number } { const match = /^(?<kind>[a-zA-Z0-9][a-zA-Z0-9:._-]*)@(?<version>[1-9][0-9]*)$/.exec(value); if (!match?.groups) throw fieldError("workflow", "Choose a workflow and version."); return { kind: match.groups.kind!, version: Number(match.groups.version) }; }
function optionalNumber(value: string, field: string): number | undefined { if (!value.trim()) return undefined; const number = Number(value); if (!Number.isFinite(number) || number < 0) throw fieldError(field, "Enter a non-negative number."); return number; }
function dateStart(value: string): string { const date = new Date(`${value}T00:00:00.000Z`); if (!Number.isFinite(date.getTime())) throw fieldError("createdAtOrAfter", "Enter a valid start date."); return date.toISOString(); }
function nextDateStart(value: string): string { const date = new Date(`${value}T00:00:00.000Z`); if (!Number.isFinite(date.getTime())) throw fieldError("createdBefore", "Enter a valid end date."); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString(); }
function sortFromTable(sorting: SortingState): { field: RunSortField; direction: "asc" | "desc" } { const first = sorting[0] ?? { id: "createdAt", desc: true }; return { field: sortField(first.id), direction: first.desc ? "desc" : "asc" }; }
function sortField(id: string): RunSortField { if (id === "user") return "userId"; if (id === "role") return "roleId"; return id as RunSortField; }
function withoutCursor(query: RunListQueryDto): RunListQueryDto { const { cursor: _discarded, ...rest } = query; return rest; }
function withCursor(query: RunListQueryDto, cursor: string | undefined): RunListQueryDto { const rest = withoutCursor(query); return cursor === undefined ? rest : { ...rest, cursor }; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
