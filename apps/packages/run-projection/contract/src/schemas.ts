import { z } from "zod";
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
const timestamp = z.string().datetime();
const organization = z.object({ organizationId: id }).strict();
const environment = z.object({ environmentId: id }).strict();
const runRef = z.object({ executionId: id }).strict();
const workflow = z.object({ kind: id, version: z.number().int().positive() }).strict();
const workflowDeployment = z.object({ workflowDeploymentId: id }).strict();
const status = z.enum(["accepted", "running", "waiting_for_input", "resume_queued", "complete", "failed", "cancelled", "archived"]);
const availability = z.enum(["environment", "archive", "unavailable"]);
export const projectionListQuerySchema = z.object({
  environmentId: id.optional(),
  workflowKind: id.optional(),
  workflowVersion: z.number().int().positive().optional(),
  status: status.optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
}).strict().refine(
  (value) => (value.workflowKind === undefined) === (value.workflowVersion === undefined),
  { message: "workflowKind and workflowVersion must be supplied together." },
);
const performance = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  totalElapsedMs: z.number().int().nonnegative().optional(),
  costs: z.array(z.object({ amount: z.number().nonnegative(), currency: z.string(), kind: z.enum(["provider-estimate", "billed"]) }).strict()).optional(),
}).strict();
export const platformRunEventSchema = z.object({
  schemaVersion: z.literal(1), eventId: id,
  type: z.enum(["run.accepted", "run.running", "run.waiting-for-input", "run.resume-queued", "run.completed", "run.failed", "run.cancelled", "run.performance-updated", "run.archived"]),
  organization, environment, runRef, workflow, workflowDeployment: workflowDeployment.optional(),
  revision: z.number().int().nonnegative(), occurredAt: timestamp, status,
  aggregatePerformance: performance.optional(), canonicalResultAvailability: availability,
}).strict();
export const platformRunProjectionSchema = z.object({
  schemaVersion: z.literal(1), organization, environment, runRef, workflow, workflowDeployment: workflowDeployment.optional(),
  status, createdAt: timestamp, updatedAt: timestamp, revision: z.number().int().nonnegative(),
  aggregatePerformance: performance.optional(), canonicalResultAvailability: availability, sourceFreshnessAt: timestamp,
}).strict();
export const projectionEventResponseSchema = z.object({ projection: platformRunProjectionSchema }).strict();
export const projectionListResponseSchema = z.object({ items: z.array(platformRunProjectionSchema), pagination: z.object({ nextCursor: z.string().optional() }).strict() }).strict();
export const apiErrorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
export type PlatformRunEventDto = z.infer<typeof platformRunEventSchema>;
export type ProjectionEventResponseDto = z.infer<typeof projectionEventResponseSchema>;
export type ProjectionListResponseDto = z.infer<typeof projectionListResponseSchema>;
export type ProjectionListQueryDto = z.infer<typeof projectionListQuerySchema>;
