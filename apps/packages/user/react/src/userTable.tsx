import { useMemo, useState } from "react";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type SortingState,
} from "@tanstack/react-table";
import type { UserDto } from "@com-pyvue/agent-execution-user-contract";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@com-pyvue/agent-execution-ui";

export interface UserTableProps {
  users: UserDto[];
  changingUserId?: string;
  onSetStatus(userId: string, status: "active" | "disabled"): void;
}

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
const column = createColumnHelper<typeof features, UserDto>();

export function UserTable({ users, changingUserId, onSetStatus }: UserTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "userId", desc: false }]);
  const columns = useMemo(() => column.columns([
    column.accessor("userId", { header: "User", sortFn: "alphanumeric" }),
    column.accessor((user) => user.displayName ?? "—", { id: "displayName", header: "Display name", sortFn: "alphanumeric" }),
    column.accessor((user) => `${user.identity.providerId}:${user.identity.subjectId}`, {
      id: "identity",
      header: "Identity",
      sortFn: "alphanumeric",
    }),
    column.accessor("status", {
      header: "Status",
      sortFn: "alphanumeric",
      cell: ({ getValue }) => <Badge variant={getValue() === "active" ? "success" : "warning"}>{getValue()}</Badge>,
    }),
    column.accessor("registeredAt", {
      header: "Registered",
      sortFn: "alphanumeric",
      cell: ({ getValue }) => new Date(getValue()).toLocaleString(),
    }),
    column.display({
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const nextStatus = row.original.status === "active" ? "disabled" : "active";
        return (
          <Button
            variant="outline"
            disabled={changingUserId !== undefined}
            onClick={() => onSetStatus(row.original.userId, nextStatus)}
          >
            {changingUserId === row.original.userId
              ? "Updating…"
              : nextStatus === "active" ? "Enable" : "Disable"}
          </Button>
        );
      },
    }),
  ]), [changingUserId, onSetStatus]);
  const table = useTable({
    features,
    data: users,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (user) => user.userId,
    enableSortingRemoval: false,
  });

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table aria-label="Execution platform users">
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>{group.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder ? null : header.column.getCanSort() ? (
                  <button type="button" onClick={header.column.getToggleSortingHandler()} className="inline-flex items-center gap-1">
                    <table.FlexRender header={header} />
                    <span aria-hidden="true">{header.column.getIsSorted() === "asc" ? "↑" : header.column.getIsSorted() === "desc" ? "↓" : "↕"}</span>
                  </button>
                ) : <table.FlexRender header={header} />}
              </TableHead>
            ))}</TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>{row.getAllCells().map((cell) => (
              <TableCell key={cell.id}><table.FlexRender cell={cell} /></TableCell>
            ))}</TableRow>
          ))}
          {users.length === 0 ? <TableRow><TableCell colSpan={6}>No users on this page.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </div>
  );
}
