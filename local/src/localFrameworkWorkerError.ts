/** Bounded private IPC decoder. Preserve original errors and causes for local inspection. */
export function deserializeFrameworkError(value: unknown, limits: { maxMessageLength?: number; maxStackLength?: number; maxBytes?: number } = {},
  depth = 0, budget = { nodes: 0, bytes: 0 }): Error | undefined {
  if (!value || typeof value !== "object" || depth >= 6 || ++budget.nodes > 20) return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["name", "message", "stack", "cause", "errors", "truncated"].includes(key))
    || (record.truncated !== undefined && record.truncated !== true)
    || typeof record.name !== "string" || !record.name || record.name.length > 512 || typeof record.message !== "string" || record.message.length > (limits.maxMessageLength ?? 32768)
    || (record.stack !== undefined && (typeof record.stack !== "string" || record.stack.length > (limits.maxStackLength ?? 131072)))) return;
  budget.bytes += Buffer.byteLength(record.name + record.message + (record.stack ?? "")); if (budget.bytes > (limits.maxBytes ?? 256 * 1024)) return;
  const cause = record.cause === undefined ? undefined : deserializeFrameworkError(record.cause, limits, depth + 1, budget);
  if (record.cause !== undefined && !cause) return;
  const errors: Error[] = [];
  if (record.errors !== undefined) {
    if (!Array.isArray(record.errors) || record.errors.length > 20) return;
    for (const child of record.errors) { const decoded = deserializeFrameworkError(child, limits, depth + 1, budget); if (!decoded) return; errors.push(decoded); }
  }
  const error = record.errors === undefined ? new Error(record.message, { cause }) : new AggregateError(errors, record.message, { cause });
  error.name = record.name; error.stack = record.stack as string | undefined;
  if (record.truncated) Object.defineProperty(error, "diagnosticTruncated", { value: true });
  return error;
}
