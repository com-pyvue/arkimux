export type FrameworkErrorOperation = "api" | "startup" | "resource-cleanup" | "background" | "recovery" | "registry" | "worker" | "storage" | "browser" | "telemetry";
export type FrameworkErrorObserver = (error: unknown, operation: FrameworkErrorOperation) => Promise<void>;

/** Suppress expected control flow, never errors because of their source. An
 * unexpected wrapper or aggregate still needs its complete local diagnostic. */
export function isExcludedFrameworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = Object.getOwnPropertyDescriptors(error);
  const name = data.name?.value ?? (error instanceof Error ? error.name : undefined);
  const className = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error) ?? {}, "constructor")?.value?.name;
  const names = [name, className];
  if (names.some(value => ["AbortError", "AgentExecutionCancelledError", "InputControlConflict", "InputResponseShapeError",
    "InputSubmissionValidationError", "DurableRecordConflictError", "RegistryRestartRequired", "RetainedAttemptReadinessError"].includes(value))) return true;
  if (names.some(value => ["RetainedInputValidationError", "RetainedInputError"].includes(value))) return data.code?.value === "invalid-response";
  if (names.includes("RetainedRunAdmissionError")) return ["invalid-input", "invalid-binding", "slot-mismatch", "validation-cancelled"].includes(data.code?.value);
  return names.includes("ApplicationBoundaryError") && typeof data.status?.value === "number" && data.status.value >= 400 && data.status.value < 500;
}

/** Reporting must never replace the original result, error or process outcome. */
export async function observeFrameworkError(observer: FrameworkErrorObserver | undefined, error: unknown, operation: FrameworkErrorOperation): Promise<void> {
  try { if (observer && !isExcludedFrameworkError(error)) await observer(error, operation); } catch { /* Reporting is best effort. */ }
}
