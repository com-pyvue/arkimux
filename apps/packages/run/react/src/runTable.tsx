import { useMemo, type ReactNode } from "react";
import { runStatusLabel, runStatusVariant } from "./runStatus.ts";
import {
  createColumnHelper,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import type { RunListResponseDto } from "@com-pyvue/agent-execution-run-contract";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@com-pyvue/agent-execution-ui";
import type { ConfigurableRunColumnId } from "./runColumns.ts";

type RunRow = RunListResponseDto["items"][number];

const features = tableFeatures({
  rowSelectionFeature,
  rowSortingFeature,
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
const columnHelper = createColumnHelper<typeof features, RunRow>();

export interface RunTableProps {
  runs: RunRow[];
  selectedExecutionIds: string[];
  onSelectedExecutionIdsChange(executionIds: string[]): void;
  renderRunLink?(executionId: string, label: ReactNode): ReactNode;
  visibleColumns: ConfigurableRunColumnId[];
  sorting: SortingState;
  onSortingChange(sorting: SortingState): void;
  onArchive?(executionId: string): void;
  onRestore?(executionId: string): void;
}

export function RunTable(props: RunTableProps) {
  const rowSelection = Object.fromEntries(props.selectedExecutionIds.map((executionId) => [executionId, true])) as RowSelectionState;
  const visible = new Set(props.visibleColumns);
  const columns = useMemo(() => columnHelper.columns([
    columnHelper.display({
      id: "selected",
      header: () => {
        const executionIds = props.runs.map((run) => run.runRef.executionId);
        const allSelected = executionIds.length > 0 && executionIds.every((id) => props.selectedExecutionIds.includes(id));
        return <input aria-label="Select all runs" type="checkbox" checked={allSelected} onChange={(event) => props.onSelectedExecutionIdsChange(event.target.checked ? executionIds : [])} />;
      },
      cell: ({ row }) => (
        <input
          aria-label={`Select ${row.original.runRef.executionId}`}
          type="checkbox"
          checked={row.getIsSelected()}
          onClick={row.getToggleSelectedHandler({ selectChildren: false })}
          onChange={() => undefined}
        />
      ),
      enableSorting: false,
    }),
    columnHelper.accessor((row) => row.runRef.executionId, {
      id: "executionId",
      header: "Run",
      sortFn: "alphanumeric",
      cell: ({ row, getValue }) => (
        props.renderRunLink?.(row.original.runRef.executionId, getValue())
        ?? <a className="font-medium underline underline-offset-4" href={`/runs/${encodeURIComponent(row.original.runRef.executionId)}`}>{getValue()}</a>
      ),
    }),
    ...(visible.has("status") ? [columnHelper.accessor((row) => row.status?.status ?? "unknown", {
      id: "status",
      header: "Status",
      sortFn: "alphanumeric",
      cell: ({ getValue }) => <Badge variant={runStatusVariant(getValue())}>{runStatusLabel(getValue())}</Badge>,
    })] : []),
    ...(visible.has("workflow") ? [columnHelper.accessor((row) => `${row.workflow.kind}@${row.workflow.version}`, {
      id: "workflow",
      header: "Workflow",
      sortFn: "alphanumeric",
    })] : []),
    ...(visible.has("user") ? [columnHelper.accessor((row) => row.actor.userId, {
      id: "user",
      header: "User",
      sortFn: "alphanumeric",
    })] : []),
    ...(visible.has("role") ? [columnHelper.accessor((row) => row.actor.roleId, {
      id: "role",
      header: "Role",
      sortFn: "alphanumeric",
    })] : []),
    ...summaryColumn("provider", "Provider", formatText),
    ...summaryColumn("model", "Model", formatText),
    ...summaryColumn("totalElapsedMs", "Total time", (value) => value === null ? "—" : formatDuration(value)),
    ...(visible.has("createdAt") ? [columnHelper.accessor("createdAt", {
      id: "createdAt",
      header: "Created",
      sortFn: "alphanumeric",
      cell: ({ getValue }) => new Date(getValue()).toLocaleString(),
    })] : []),
    ...summaryColumn("inputTokens", "Input tokens", formatNumber),
    ...summaryColumn("cachedInputTokens", "Cached input tokens", formatNumber),
    ...summaryColumn("outputTokens", "Output tokens", formatNumber),
    ...summaryColumn("reasoningOutputTokens", "Reasoning tokens", formatNumber),
    ...summaryColumn("costs", "Cost", formatCosts),
    ...summaryColumn("toolCalls", "Tool calls", formatNumber),
    ...summaryColumn("searchCalls", "Search calls", formatNumber),
    ...summaryColumn("reasoningEffort", "Reasoning effort", formatText),
    ...summaryColumn("speed", "Speed", formatText),
    columnHelper.display({
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const lifecycle = row.original.lifecycleStatus ?? "active";
        const terminal = row.original.status?.status === "complete" || row.original.status?.status === "failed" || row.original.status?.status === "cancelled";
        if (lifecycle === "archived") {
          return <Button size="sm" variant="outline" type="button" onClick={() => props.onRestore?.(row.original.runRef.executionId)}>Restore</Button>;
        }
        return terminal ? <Button size="sm" variant="outline" type="button" onClick={() => props.onArchive?.(row.original.runRef.executionId)}>Archive</Button> : <span className="text-muted-foreground">—</span>;
      },
      enableSorting: false,
    }),
  ]), [props.renderRunLink, props.visibleColumns.join("\0"), props.onArchive, props.onRestore, props.runs, props.selectedExecutionIds]);

  function summaryColumn(
    id: Exclude<ConfigurableRunColumnId, "status" | "workflow" | "user" | "role" | "createdAt">,
    header: string,
    format: (value: never) => string,
  ) {
    if (!visible.has(id)) return [];
    return [columnHelper.accessor((row) => row.summary?.[id] ?? null, {
      id,
      header,
      sortFn: "alphanumeric",
      enableSorting: id !== "costs",
      cell: ({ getValue }) => format(getValue() as never),
    })];
  }
  const table = useTable({
    features,
    columns,
    data: props.runs,
    state: { sorting: props.sorting, rowSelection },
    onSortingChange: (updater) => props.onSortingChange(
      typeof updater === "function" ? updater(props.sorting) : updater,
    ),
    onRowSelectionChange: (updater) => {
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      props.onSelectedExecutionIdsChange(Object.keys(next).filter((id) => next[id]));
    },
    getRowId: (row) => row.runRef.executionId,
    enableSortingRemoval: false,
    enableSubRowSelection: false,
  });

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table aria-label="Runs">
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : header.column.getCanSort() ? (
                    <button type="button" onClick={header.column.getToggleSortingHandler()} className="inline-flex items-center gap-1">
                      <table.FlexRender header={header} />
                      <span aria-hidden="true">{header.column.getIsSorted() === "asc" ? "↑" : header.column.getIsSorted() === "desc" ? "↓" : "↕"}</span>
                    </button>
                  ) : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} data-selected={row.getIsSelected() || undefined}>
              {row.getAllCells().map((cell) => <TableCell key={cell.id}><table.FlexRender cell={cell} /></TableCell>)}
            </TableRow>
          ))}
          {table.getRowModel().rows.length === 0 ? <TableRow><TableCell colSpan={columns.length}>No runs match these filters.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </div>
  );
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function formatText(value: string | null): string {
  return value ?? "—";
}

function formatDuration(value: number): string {
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
}

function formatCosts(value: RunRow["summary"] extends infer T ? T extends { costs?: infer C } ? C : never : never): string {
  if (!value) return "—";
  return value.map(({ amount, currency }) => `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency}`).join(" + ");
}
