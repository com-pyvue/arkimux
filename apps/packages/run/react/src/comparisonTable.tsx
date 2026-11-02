import { useState } from "react";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type SortingState,
} from "@tanstack/react-table";
import type { RunComparisonRowDto } from "@com-pyvue/agent-execution-run-contract";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@com-pyvue/agent-execution-ui";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
const helper = createColumnHelper<typeof features, RunComparisonRowDto>();
const columns = helper.columns([
  helper.accessor((row) => row.runRef.executionId, { id: "run", header: "Run", sortFn: "alphanumeric" }),
  helper.accessor("status", { header: "Status", sortFn: "alphanumeric", sortUndefined: "last" }),
  helper.accessor("provider", { header: "Provider", sortFn: "alphanumeric", sortUndefined: "last" }),
  helper.accessor("model", { header: "Model", sortFn: "alphanumeric", sortUndefined: "last" }),
  helper.accessor("reasoningEffort", { header: "Effort", sortFn: "alphanumeric", sortUndefined: "last" }),
  helper.accessor("speed", { header: "Speed", sortFn: "alphanumeric", sortUndefined: "last" }),
  helper.accessor("durationMs", { header: "Duration ms", sortUndefined: "last" }),
  helper.accessor("inputTokens", { header: "Input", sortUndefined: "last" }),
  helper.accessor("cachedInputTokens", { header: "Cached", sortUndefined: "last" }),
  helper.accessor("outputTokens", { header: "Output", sortUndefined: "last" }),
  helper.accessor("toolCalls", { header: "Tools", sortUndefined: "last" }),
  helper.accessor("searchCalls", { header: "Searches", sortUndefined: "last" }),
  helper.accessor((row) => row.costs?.map(({ amount, currency }) => `${amount.toFixed(4)} ${currency}`).join(", ") ?? null, {
    id: "cost",
    header: "Cost",
    sortFn: "alphanumeric",
    sortUndefined: "last",
  }),
]);

export function ComparisonTable({ rows }: { rows: RunComparisonRowDto[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "durationMs", desc: false }]);
  const table = useTable({
    features,
    columns,
    data: rows,
    state: { sorting },
    onSortingChange: setSorting,
    enableSortingRemoval: false,
  });
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table aria-label="Selected run comparison">
        <TableHeader>{table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>{group.headers.map((header) => (
            <TableHead key={header.id}>
              <button type="button" onClick={header.column.getToggleSortingHandler()}>
                <table.FlexRender header={header} /> {header.column.getIsSorted() === "asc" ? "↑" : header.column.getIsSorted() === "desc" ? "↓" : "↕"}
              </button>
            </TableHead>
          ))}</TableRow>
        ))}</TableHeader>
        <TableBody>{table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>{row.getAllCells().map((cell) => (
            <TableCell key={cell.id}>{cell.getValue() === null ? <span className="text-muted-foreground">unknown</span> : <table.FlexRender cell={cell} />}</TableCell>
          ))}</TableRow>
        ))}</TableBody>
      </Table>
    </div>
  );
}
