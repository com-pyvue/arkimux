import { assertSafeIdentifier } from "../domain/identifiers.ts";
import { isRecord } from "../domain/validation.ts";

export function record(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  return value;
}

export function safeIdentifier(value: unknown, location: string): asserts value is string {
  assertSafeIdentifier(value, location);
}

export function requiredString(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string.`);
  }
}

export function positiveInteger(value: unknown, location: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${location} must be a positive integer.`);
  }
}

export function nonNegativeInteger(value: unknown, location: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${location} must be a non-negative integer.`);
  }
}

export function nonNegativeNumber(value: unknown, location: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${location} must be a non-negative finite number.`);
  }
}

export function canonicalTimestamp(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a canonical ISO-8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${location} must be a canonical ISO-8601 timestamp.`);
  }
}

export function unique(values: string[], location: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${location} contains duplicates.`);
  }
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
