import { appendFile } from 'node:fs/promises';

const identity = { parse: value => value };

export function createRecordFixtureAdapter(context) {
  return {
    schemaVersion: 1,
    operationId: 'record-fixture',
    definitionVersion: 'v1',
    safety: 'idempotent-write',
    input: identity,
    output: identity,
    async execute(_execution, input) {
      await appendFile(context.environment.AUDIT_FILE, `${JSON.stringify({ count: input.count, pid: input.pid })}\n`);
      return { recorded: true };
    },
  };
}
