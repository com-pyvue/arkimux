import type { RoleAssignmentDto, RoleDto } from "@com-pyvue/agent-execution-role-contract";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@com-pyvue/agent-execution-ui";

export function RoleTable({ roles }: { roles: RoleDto[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table aria-label="Execution platform roles">
        <TableHeader><TableRow><TableHead>Role</TableHead><TableHead>Permissions</TableHead></TableRow></TableHeader>
        <TableBody>
          {roles.map((role) => (
            <TableRow key={role.roleId}>
              <TableCell>{role.roleId}</TableCell>
              <TableCell><code className="text-xs">{role.permissions.join(", ")}</code></TableCell>
            </TableRow>
          ))}
          {roles.length === 0 ? <TableRow><TableCell colSpan={2}>No roles on this page.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </div>
  );
}

export interface RoleAssignmentTableProps {
  assignments: RoleAssignmentDto[];
  revoking?: RoleAssignmentDto;
  onRevoke(assignment: RoleAssignmentDto): void;
}

export function RoleAssignmentTable({ assignments, revoking, onRevoke }: RoleAssignmentTableProps) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table aria-label="Role assignments">
        <TableHeader><TableRow><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
        <TableBody>
          {assignments.map((assignment) => {
            const pending = revoking?.userId === assignment.userId && revoking.roleId === assignment.roleId;
            return (
              <TableRow key={`${assignment.userId}/${assignment.roleId}`}>
                <TableCell>{assignment.userId}</TableCell>
                <TableCell>{assignment.roleId}</TableCell>
                <TableCell>
                  <Button variant="outline" disabled={revoking !== undefined} onClick={() => onRevoke(assignment)}>
                    {pending ? "Revoking…" : "Revoke"}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {assignments.length === 0 ? <TableRow><TableCell colSpan={3}>No assignments on this page.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </div>
  );
}
