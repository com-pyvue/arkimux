export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertExactKeys(
  record: Record<string, unknown>,
  required: string[],
  location: string,
  allowed: string[] = required,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${location} contains unknown fields [${unknown.join(", ")}].`);
  }
  const missing = required.filter((key) => !(key in record));
  if (missing.length > 0) {
    throw new Error(`${location} is missing required fields [${missing.join(", ")}].`);
  }
}
