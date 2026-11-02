const safeIdentifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && safeIdentifierPattern.test(value);
}

export function assertSafeIdentifier(
  value: unknown,
  location: string,
): asserts value is string {
  if (!isSafeIdentifier(value)) {
    throw new Error(
      `${location} must start with an alphanumeric character and contain only alphanumerics, dot, underscore, or hyphen.`,
    );
  }
}
