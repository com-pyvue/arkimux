export interface SerializedLocalError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedLocalError;
  errors?: SerializedLocalError[];
  truncated?: true;
}

/** Bound local diagnostics without changing their messages or classifying their source. */
export function serializeError(value: unknown, options: {
  maxTextBytes?: number; maxMessageLength?: number; maxStackLength?: number;
} = {}): SerializedLocalError {
  const seen = new Set<unknown>();
  const encoder = new TextEncoder();
  const size = (text: string) => encoder.encode(JSON.stringify(text)).byteLength;
  const messageLimit = options.maxMessageLength ?? 32 * 1_024;
  const stackLimit = options.maxStackLength ?? 128 * 1_024;
  let nodes = 0, bytes = options.maxTextBytes ?? 224 * 1_024, truncated = false;
  const bounded = (text: string, limit: number): string => {
    let result = clip(text, limit);
    if (result !== text) truncated = true;
    if (size(result) > bytes) {
      truncated = true;
      let low = 0, high = result.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (size(clip(result, middle)) <= bytes) low = middle;
        else high = middle - 1;
      }
      result = clip(result, low);
    }
    bytes = Math.max(0, bytes - size(result));
    return result;
  };
  const visit = (error: unknown, depth: number): SerializedLocalError => {
    nodes++;
    if (!(error instanceof Error)) return { name: "NonError", message: bounded(scalarMessage(error), messageLimit) };
    if (Object.getOwnPropertyDescriptor(error, "diagnosticTruncated")?.value === true) truncated = true;
    const name = bounded(error.name || "Error", 512);
    if (seen.has(error)) return { name, message: "Circular error reference." };
    seen.add(error);
    const serialized: SerializedLocalError = { name, message: bounded(error.message, messageLimit),
      ...(error.stack ? { stack: bounded(error.stack, stackLimit) } : {}) };
    const child = (value: unknown): SerializedLocalError | undefined => {
      if (depth >= 5 || nodes >= 20 || bytes < 128) { truncated = true; return; }
      return visit(value, depth + 1);
    };
    if (error.cause !== undefined) serialized.cause = child(error.cause);
    if (error instanceof AggregateError) {
      serialized.errors = [];
      for (const value of error.errors) {
        const next = child(value);
        if (!next) break;
        serialized.errors.push(next);
      }
    }
    return serialized;
  };
  const result = visit(value, 0);
  if (truncated) result.truncated = true;
  return result;
}

function scalarMessage(value: unknown): string {
  if (value === null) return "null";
  if (["string", "number", "boolean", "bigint", "undefined"].includes(typeof value)) return String(value);
  return `Non-Error value of type ${Array.isArray(value) ? "array" : typeof value}.`;
}

function clip(value: string, max: number): string {
  const suffix = "\n[truncated]";
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - suffix.length))}${suffix.slice(0, max)}`;
}
