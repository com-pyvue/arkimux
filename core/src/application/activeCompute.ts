import { z } from "zod";

const milliseconds = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime({ precision: 3 });
/** Internal V2 host accounting. Elapsed attempt time, not CPU time or billing. */
export const activeComputeLimitsSchema = z.strictObject({
  totalMs: milliseconds.positive(), attemptMs: milliseconds.positive(), finalizationReserveMs: milliseconds,
}).refine(value => value.finalizationReserveMs < Math.min(value.totalMs, value.attemptMs), "Finalization reserve must fit within both limits.");
export type ActiveComputeLimitsV1 = z.infer<typeof activeComputeLimitsSchema>;
/** OS monotonic epoch is shared by the owned host and worker on this machine. */
export const diagnosticMonotonicNow = (): number => Number(process.hrtime.bigint() / 1_000_000n);
/** Private V2 diagnostic record. Every revision is written under the attempt fence.
 * The wall/charged counters are host-monotonic samples, never calendar differences. */
export const diagnosticClockRecordSchema = z.strictObject({
  schemaVersion: z.literal(2), revision: milliseconds,
  clock: z.enum(["running", "paused"]), pauseId: z.string().min(1).max(200).nullable(),
  activeCount: milliseconds, activityKnown: z.boolean(),
  wallMs: milliseconds, chargedMs: milliseconds, excludedPauseMs: milliseconds, sampledAtMonotonicMs: milliseconds,
}).superRefine((value, ctx) => {
  if (value.wallMs !== value.chargedMs + value.excludedPauseMs) ctx.addIssue({ code: "custom", message: "Diagnostic counters differ." });
  if (value.clock === "paused" && (!value.pauseId || value.activeCount !== 0 || !value.activityKnown)) ctx.addIssue({ code: "custom", message: "Only a confirmed quiet pause excludes time." });
});
export type DiagnosticClockRecordV2 = z.infer<typeof diagnosticClockRecordSchema>;
export const activeComputeSchema = z.strictObject({
  schemaVersion: z.literal(1), limits: activeComputeLimitsSchema, spentMs: milliseconds,
  diagnosticOnly: z.literal(true).optional(), excludedPauseMs: milliseconds.optional(),
  certainty: z.enum(["known", "uncertain"]),
  active: z.strictObject({ attemptId: z.string(), fence: milliseconds.positive(), startedAt: timestamp, deadlineAt: timestamp,
    diagnostic: diagnosticClockRecordSchema.optional() }).nullable(),
  lastAttempt: z.strictObject({ attemptId: z.string(), elapsedMs: milliseconds, endedAt: timestamp,
    wallElapsedMs: milliseconds.optional(), excludedPauseMs: milliseconds.optional(),
    outcome: z.enum(["suspended", "completed", "failed", "cancelled", "deadline_exceeded", "accounting_uncertain"]) }).optional(),
});
export type ActiveComputeV1 = z.infer<typeof activeComputeSchema>;
export type AccountedOutcomeV1 = NonNullable<ActiveComputeV1["lastAttempt"]>["outcome"];
export const readinessFailureSchema = z.enum(["credentials-unavailable", "retained-code-incompatible"]);
export type ReadinessFailureV1 = z.infer<typeof readinessFailureSchema>;
export const readinessFailureMessage = (code: ReadinessFailureV1): string => code === "credentials-unavailable"
  ? "Required credentials are unavailable. Sign in to the selected runtime or configure the referenced API key. No workflow worker was started."
  : "The retained workflow cannot run with this host. Restore its required runtime; current project code will not be substituted.";
export class RetainedAttemptReadinessError extends Error {
  constructor(readonly code: ReadinessFailureV1) { super(readinessFailureMessage(readinessFailureSchema.parse(code))); }
}
export function remainingComputeMs(accounting: ActiveComputeV1): number {
  return Math.max(0, accounting.limits.totalMs - accounting.spentMs);
}

/** Input envelope wall time ends at answer acceptance, never at later replay.
 * This is request-open time, reported separately from the Run's active time. */
export function inputRequestTimingV1(request: { createdAt: string; expiresAt: string }, acceptedAt: string): {
  startedAt: string; completedAt: string; elapsedMs: number; humanWaitMs: number;
} {
  timestamp.parse(request.createdAt); timestamp.parse(request.expiresAt); timestamp.parse(acceptedAt);
  const elapsedMs = Date.parse(acceptedAt) - Date.parse(request.createdAt);
  if (elapsedMs < 0 || Date.parse(acceptedAt) >= Date.parse(request.expiresAt)) throw new Error("Input acceptance must be within the fixed request window.");
  return { startedAt: request.createdAt, completedAt: acceptedAt, elapsedMs, humanWaitMs: elapsedMs };
}
