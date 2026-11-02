import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useState, type FormEvent } from "react";
import type {
  PageQueryDto,
  RoleApiClient,
  RoleAssignmentListQueryDto,
} from "@com-pyvue/agent-execution-role-contract";
import {
  Field, FormValidation, fieldError,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@com-pyvue/agent-execution-ui";
import {
  useAssignRole,
  useDefineRole,
  useRevokeRole,
  useRoleAssignmentList,
  useRoleList,
} from "./queries.ts";
import { RoleAssignmentTable, RoleTable } from "./roleTables.tsx";

export interface RoleFeatureProps {
  client: RoleApiClient;
}

export function RoleFeature({ client }: RoleFeatureProps) {
  const [roleId, setRoleId] = useState("");
  const [permissions, setPermissions] = useState("");
  const [roleInputError, setRoleInputError] = useState<string>();
  const [assignmentUserId, setAssignmentUserId] = useState("");
  const [assignmentRoleId, setAssignmentRoleId] = useState("");
  const [filterUserId, setFilterUserId] = useState("");
  const [filterRoleId, setFilterRoleId] = useState("");
  const [roleQuery, setRoleQuery] = useState<PageQueryDto>({ pageSize: 50 });
  const [roleCursorHistory, setRoleCursorHistory] = useState<Array<string | undefined>>([]);
  const [assignmentQuery, setAssignmentQuery] = useState<RoleAssignmentListQueryDto>({ pageSize: 50 });
  const [assignmentCursorHistory, setAssignmentCursorHistory] = useState<Array<string | undefined>>([]);
  const roles = useRoleList(client, roleQuery);
  const assignments = useRoleAssignmentList(client, assignmentQuery);
  const defineRole = useDefineRole(client);
  const assignRole = useAssignRole(client);
  const revokeRole = useRevokeRole(client);

  function submitRole(event: FormEvent) {
    event.preventDefault();
    const parsedPermissions = permissions.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    if (parsedPermissions.length === 0) {
      setRoleInputError("At least one permission is required.");
      return;
    }
    setRoleInputError(undefined);
    defineRole.mutate({ roleId: roleId.trim(), permissions: parsedPermissions });
  }

  function submitAssignment(event: FormEvent) {
    event.preventDefault();
    assignRole.mutate({ userId: assignmentUserId.trim(), roleId: assignmentRoleId.trim() });
  }

  function applyAssignmentFilters(event: FormEvent) {
    event.preventDefault();
    setAssignmentCursorHistory([]);
    setAssignmentQuery({
      pageSize: 50,
      ...(filterUserId.trim() ? { userId: filterUserId.trim() } : {}),
      ...(filterRoleId.trim() ? { roleId: filterRoleId.trim() } : {}),
    });
  }

  return (
    <main className="mx-auto max-w-[100rem] space-y-6 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Roles and assignments</h1>
        <p className="text-muted-foreground">Define immutable roles and manage explicit user assignments.</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Define role</CardTitle>
          <CardDescription>Existing role IDs are immutable; permission changes require a new role ID.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormValidation error={roleInputError ? fieldError("permissions", roleInputError) : defineRole.error}><form noValidate className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(20rem,2fr)_auto]" onSubmit={submitRole}>
            <Field name="roleId">Role ID<Input aria-label="Role ID" placeholder="role-id-v1" value={roleId} onChange={(event) => setRoleId(event.target.value)} /></Field>
            <Field name="permissions">Permissions<Input aria-label="Permissions" placeholder="runs:read-own, workflow:example:start" value={permissions} onChange={(event) => { setPermissions(event.target.value); setRoleInputError(undefined); }} /></Field>
            <Button type="submit" disabled={defineRole.isPending}>{defineRole.isPending ? "Defining…" : "Define role"}</Button>
          </form></FormValidation>


          {defineRole.data ? <p role="status">Role <strong>{defineRole.data.role.roleId}</strong> is defined.</p> : null}
          {roles.isPending ? <p>Loading roles…</p> : roles.error ? <ErrorNotification description={message(roles.error)} /> : (
            <>
              <RoleTable roles={roles.data?.items ?? []} />
              <Pagination
                history={roleCursorHistory}
                nextCursor={roles.data?.pagination.nextCursor}
                onPrevious={() => {
                  const previous = roleCursorHistory.at(-1);
                  setRoleCursorHistory((history) => history.slice(0, -1));
                  setRoleQuery((current) => withCursor(current, previous));
                }}
                onNext={(next) => {
                  setRoleCursorHistory((history) => [...history, roleQuery.cursor]);
                  setRoleQuery((current) => withCursor(current, next));
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Role assignments</CardTitle>
          <CardDescription>Assign only existing roles to existing users; registration never assigns a role.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormValidation error={assignRole.error}><form noValidate className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto]" onSubmit={submitAssignment}>
            <Field name="userId">Assignment user ID<Input aria-label="Assignment user ID" placeholder="user-id" value={assignmentUserId} onChange={(event) => setAssignmentUserId(event.target.value)} /></Field>
            <Field name="roleId">Assignment role ID<Input aria-label="Assignment role ID" placeholder="role-id-v1" value={assignmentRoleId} onChange={(event) => setAssignmentRoleId(event.target.value)} /></Field>
            <Button type="submit" disabled={assignRole.isPending}>{assignRole.isPending ? "Assigning…" : "Assign role"}</Button>
          </form></FormValidation>

          {assignRole.data ? <p role="status">Assigned {assignRole.data.assignment.roleId} to {assignRole.data.assignment.userId}.</p> : null}
          <FormValidation error={assignments.error}><form noValidate className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto]" onSubmit={applyAssignmentFilters}>
            <Field name="userId">Filter assignments by user<Input aria-label="Filter assignments by user" placeholder="Optional user ID" value={filterUserId} onChange={(event) => setFilterUserId(event.target.value)} /></Field>
            <Field name="roleId">Filter assignments by role<Input aria-label="Filter assignments by role" placeholder="Optional role ID" value={filterRoleId} onChange={(event) => setFilterRoleId(event.target.value)} /></Field>
            <Button type="submit" variant="outline">Apply filters</Button>
          </form></FormValidation>
          {revokeRole.error ? <ErrorNotification description={message(revokeRole.error)} /> : null}
          {assignments.isPending ? <p>Loading assignments…</p> : assignments.error ? null : (
            <>
              <RoleAssignmentTable
                assignments={assignments.data?.items ?? []}
                revoking={revokeRole.isPending ? revokeRole.variables : undefined}
                onRevoke={(assignment) => revokeRole.mutate(assignment)}
              />
              <Pagination
                history={assignmentCursorHistory}
                nextCursor={assignments.data?.pagination.nextCursor}
                onPrevious={() => {
                  const previous = assignmentCursorHistory.at(-1);
                  setAssignmentCursorHistory((history) => history.slice(0, -1));
                  setAssignmentQuery((current) => withCursor(current, previous));
                }}
                onNext={(next) => {
                  setAssignmentCursorHistory((history) => [...history, assignmentQuery.cursor]);
                  setAssignmentQuery((current) => withCursor(current, next));
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Pagination(props: {
  history: Array<string | undefined>;
  nextCursor?: string;
  onPrevious(): void;
  onNext(cursor: string): void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={props.history.length === 0} onClick={props.onPrevious}>Previous page</Button>
      <Button variant="outline" disabled={!props.nextCursor} onClick={() => props.nextCursor && props.onNext(props.nextCursor)}>Next page</Button>
    </div>
  );
}

function withCursor<T extends PageQueryDto>(query: T, cursor: string | undefined): T {
  const { cursor: _discarded, ...withoutCursor } = query;
  return (cursor === undefined ? withoutCursor : { ...withoutCursor, cursor }) as T;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
