import { ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { useState, type FormEvent } from "react";
import { Field, FormValidation, Select } from "@com-pyvue/agent-execution-ui";
import type { UserApiClient, UserListQueryDto } from "@com-pyvue/agent-execution-user-contract";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@com-pyvue/agent-execution-ui";
import { useCurrentUserRegistration, useSetUserStatus, useUserList } from "./queries.ts";
import { UserTable } from "./userTable.tsx";

export interface UserFeatureProps {
  client: UserApiClient;
}

export function UserFeature({ client }: UserFeatureProps) {
  const [requestedUserId, setRequestedUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [draftStatus, setDraftStatus] = useState("");
  const [query, setQuery] = useState<UserListQueryDto>({ pageSize: 50 });
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const registration = useCurrentUserRegistration(client);
  const users = useUserList(client, query);
  const statusChange = useSetUserStatus(client);

  function register(event: FormEvent) {
    event.preventDefault();
    registration.mutate({
      ...(requestedUserId.trim() ? { requestedUserId: requestedUserId.trim() } : {}),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
    });
  }

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setCursorHistory([]);
    setQuery({
      pageSize: 50,
      ...(draftStatus ? { status: draftStatus as "active" | "disabled" } : {}),
    });
  }

  return (
    <main className="mx-auto max-w-[100rem] space-y-6 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Execution platform users</h1>
        <p className="text-muted-foreground">Register the current trusted identity and administer platform user status.</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Register current identity</CardTitle>
          <CardDescription>Provider and subject are supplied by the server and cannot be entered here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormValidation error={registration.error}><form noValidate className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto]" onSubmit={register}>
            <Field name="requestedUserId">Requested user ID<Input aria-label="Requested user ID" placeholder="Optional user ID" value={requestedUserId} onChange={(event) => setRequestedUserId(event.target.value)} /></Field>
            <Field name="displayName">Display name<Input aria-label="Display name" placeholder="Optional display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
            <Button type="submit" disabled={registration.isPending}>{registration.isPending ? "Registering…" : "Register"}</Button>
          </form></FormValidation>

          {registration.data ? <p role="status">Identity is registered as <strong>{registration.data.user.userId}</strong>.</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>User administration</CardTitle>
          <CardDescription>Listing and status changes require the users:admin permission.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormValidation error={users.error}><form noValidate className="flex flex-wrap gap-3" onSubmit={applyFilters}>
            <Field name="status">User status filter<Select aria-label="User status filter" className="h-9 min-w-48 rounded-md border bg-background px-3 text-sm" value={draftStatus} onChange={(event) => setDraftStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </Select></Field>
            <Button type="submit">Apply filters</Button>
          </form></FormValidation>
          {statusChange.error ? <ErrorNotification description={message(statusChange.error)} /> : null}
          {users.isPending ? <p>Loading users…</p> : users.error ? null : (
            <>
              <UserTable
                users={users.data?.items ?? []}
                changingUserId={statusChange.isPending ? statusChange.variables?.userId : undefined}
                onSetStatus={(userId, status) => statusChange.mutate({ userId, request: { status } })}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={cursorHistory.length === 0}
                  onClick={() => {
                    const previous = cursorHistory.at(-1);
                    setCursorHistory((history) => history.slice(0, -1));
                    setQuery((current) => withCursor(current, previous));
                  }}
                >Previous page</Button>
                <Button
                  variant="outline"
                  disabled={!users.data?.pagination.nextCursor}
                  onClick={() => {
                    const next = users.data?.pagination.nextCursor;
                    if (!next) return;
                    setCursorHistory((history) => [...history, query.cursor]);
                    setQuery((current) => withCursor(current, next));
                  }}
                >Next page</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function withCursor(query: UserListQueryDto, cursor: string | undefined): UserListQueryDto {
  const { cursor: _discarded, ...withoutCursor } = query;
  return cursor === undefined ? withoutCursor : { ...withoutCursor, cursor };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
