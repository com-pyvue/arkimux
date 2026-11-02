import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const safeIdentifierSchema = z.string().min(1).max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
export const resultIdSchema = z.string().min(1).max(512).refine((value) => (
  value !== "."
  && value !== ".."
  && !value.includes("/")
  && !value.includes("\\")
  && !value.includes("\0")
), "must be a safe result file name");
export const artifactKeySchema = z.string().min(1).max(2048).refine((value) => (
  !value.startsWith("/")
  && !value.includes("\\")
  && !value.includes("\0")
  && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
), "must be a safe relative artifact key");
export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const canonicalTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "must be a canonical ISO-8601 timestamp");

export const runRefSchema = z.object({ executionId: safeIdentifierSchema }).strict();
export const workflowIdentitySchema = z.object({
  kind: safeIdentifierSchema,
  version: z.number().int().positive(),
}).strict();
export const runActorSchema = z.object({
  userId: safeIdentifierSchema,
  roleId: safeIdentifierSchema,
}).strict();
export const runTargetSchema = z.object({
  kind: safeIdentifierSchema,
  identity: z.record(safeIdentifierSchema, z.string().min(1)),
}).strict();
export const runTargetQuerySchema = z.object({
  kind: safeIdentifierSchema,
  identity: z.record(safeIdentifierSchema, z.string().min(1)).optional(),
}).strict();
export const runConfigurationReferenceSchema = z.object({
  configurationId: safeIdentifierSchema,
  contentHash: contentHashSchema,
}).strict();

const usageCostSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  kind: z.enum(["provider-estimate", "billed"]),
}).strict();

export const runStatusSchema = z.discriminatedUnion("status", [
  z.object({
    kind: z.literal("status"), status: z.enum(["waiting_for_input", "resume_queued"]), updatedAt: canonicalTimestampSchema,
    requestId: safeIdentifierSchema, expiresAt: canonicalTimestampSchema,
    activeComputeMs: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({
    kind: z.literal("status"),
    status: z.literal("running"),
    updatedAt: canonicalTimestampSchema,
    stageId: safeIdentifierSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("status"),
    status: z.literal("complete"),
    updatedAt: canonicalTimestampSchema,
  }).strict(),
  z.object({
    kind: z.literal("status"),
    status: z.literal("cancelled"),
    updatedAt: canonicalTimestampSchema,
  }).strict(),
  z.object({
    kind: z.literal("status"),
    status: z.literal("failed"),
    updatedAt: canonicalTimestampSchema,
    stageId: safeIdentifierSchema.optional(),
    message: z.string().min(1),
  }).strict(),
]);

export const runHeartbeatSchema = z.object({
  kind: z.literal("heartbeat"),
  status: z.enum(["running", "waiting_for_input", "resume_queued", "complete", "failed", "cancelled"]),
  lastEventType: z.string().min(1).max(128),
  updatedAt: canonicalTimestampSchema,
  stageId: safeIdentifierSchema.optional(),
  logicalAgentId: safeIdentifierSchema.optional(),
  providerId: safeIdentifierSchema.optional(),
}).strict();

export const runCatalogEntrySchema = z.object({
  runRef: runRefSchema,
  workflow: workflowIdentitySchema,
  target: runTargetSchema.optional(),
  actor: runActorSchema,
  createdAt: canonicalTimestampSchema,
  runConfiguration: runConfigurationReferenceSchema.optional(),
  status: runStatusSchema.optional(),
  heartbeat: runHeartbeatSchema.optional(),
  lifecycleStatus: z.enum(["active", "archived"]).optional(),
  archivedAt: canonicalTimestampSchema.optional(),
}).strict();

export const paginationSchema = z.object({
  nextCursor: z.string().min(1).optional(),
}).strict();

export const submitRunRequestSchema = z.object({
  workflow: workflowIdentitySchema,
  roleId: safeIdentifierSchema,
  input: jsonValueSchema,
  runConfigurationId: safeIdentifierSchema,
  requestedExecutionId: safeIdentifierSchema.optional(),
  correction: z.object({
    priorRunRef: runRefSchema,
    activeOriginal: z.enum(["reject", "cancel"]),
    acknowledgement: z.literal("new-run-from-start-effects-not-undone"),
  }).strict().optional(),
}).strict();
export const runCorrectionLinkSchema = z.object({
  schemaVersion: z.literal(1),
  priorRunRef: runRefSchema,
  correctedRunRef: runRefSchema,
  createdAt: canonicalTimestampSchema,
}).strict();
export const submitRunResponseSchema = z.object({
  runRef: runRefSchema,
  correction: runCorrectionLinkSchema.optional(),
}).strict();
export const cancelRunRequestSchema = z.object({
  acknowledgement: z.literal("external-effects-not-undone"),
}).strict();

export const workflowPreflightRequestSchema = z.object({
  workflow: workflowIdentitySchema,
  roleId: safeIdentifierSchema,
  runConfigurationId: safeIdentifierSchema,
}).strict();
export const agentProviderReadinessSchema = z.object({
  slotId: safeIdentifierSchema,
  providerId: safeIdentifierSchema,
  authProviderId: safeIdentifierSchema,
  available: z.boolean(),
  status: z.enum(["ready", "unavailable", "indeterminate"]).optional(),
  reason: z.enum([
    "session-missing",
    "session-rejected",
    "plan-or-billing-required",
    "credential-invalid",
    "provider-unavailable",
    "unknown",
  ]).optional(),
  identity: z.object({
    authMethod: z.string().min(1).optional(),
    accountEmail: z.string().min(1).optional(),
    reportedPlan: z.string().min(1).optional(),
  }).strict().optional(),
  executable: z.object({
    path: z.string().min(1),
    version: z.string().min(1).optional(),
  }).strict().optional(),
  remediation: z.array(z.object({
    kind: z.enum(["login", "upgrade", "configure-api-key", "retry"]),
    label: z.string().min(1),
  }).strict()).optional(),
  resolvedCommand: z.string().min(1).optional(),
  commandSource: z.enum(["explicit", "repository-local", "path"]).optional(),
  message: z.string().min(1).optional(),
}).strict();
export const workflowPreflightResponseSchema = z.object({
  available: z.boolean(),
  agents: z.array(agentProviderReadinessSchema),
}).strict();

export const agentSlotSchema = z.object({
  slotId: safeIdentifierSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
}).strict();
export const workflowSchema = z.object({
  workflow: workflowIdentitySchema,
  invocationModel: z.literal("graph-entry").optional(),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  inputExample: jsonValueSchema,
  agentSlots: z.array(agentSlotSchema).refine(
    (slots) => new Set(slots.map(({ slotId }) => slotId)).size === slots.length,
    "agent slot IDs must be unique",
  ),
  runConfigurationBase: z.record(z.string(), jsonValueSchema).optional(),
  allowedRoleIds: z.array(safeIdentifierSchema),
}).strict();
export const workflowListResponseSchema = z.object({
  items: z.array(workflowSchema),
}).strict();

export const runNumericFieldSchema = z.enum([
  "totalElapsedMs",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "toolCalls",
  "searchCalls",
]);
export const runSortFieldSchema = z.enum([
  "executionId",
  "workflow",
  "status",
  "userId",
  "roleId",
  "createdAt",
  "provider",
  "model",
  "reasoningEffort",
  "speed",
  ...runNumericFieldSchema.options,
]);
const uniqueStringFilterSchema = z.array(z.string().min(1)).max(100)
  .refine((values) => new Set(values).size === values.length, "filter values must be unique");
export const runListQuerySchema = z.object({
  userId: safeIdentifierSchema.optional(),
  workflow: workflowIdentitySchema.optional(),
  target: runTargetQuerySchema.optional(),
  status: z.enum(["running", "waiting_for_input", "resume_queued", "complete", "failed", "cancelled"]).optional(),
  createdAtOrAfter: canonicalTimestampSchema.optional(),
  createdBefore: canonicalTimestampSchema.optional(),
  lifecycleStatus: z.enum(["active", "archived", "all"]).optional(),
  providers: uniqueStringFilterSchema.optional(),
  models: uniqueStringFilterSchema.optional(),
  numericRange: z.object({
    field: runNumericFieldSchema,
    min: z.number().finite().nonnegative().nullable().optional(),
    max: z.number().finite().nonnegative().nullable().optional(),
  }).strict().refine(({ min, max }) => (
    min == null || max == null || min <= max
  ), "numeric range minimum must not exceed maximum").optional(),
  sort: z.object({
    field: runSortFieldSchema,
    direction: z.enum(["asc", "desc"]),
  }).strict().optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
  summaryFields: z.array(z.enum([
    "totalElapsedMs",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "costs",
    "toolCalls",
    "searchCalls",
    "provider",
    "model",
    "reasoningEffort",
    "speed",
  ])).max(12).refine((fields) => new Set(fields).size === fields.length, "summary fields must be unique").optional(),
}).strict();
export const runSummarySchema = z.object({
  totalElapsedMs: z.number().int().nonnegative().nullable().optional(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  cachedInputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable().optional(),
  costs: z.array(usageCostSchema).nullable().optional(),
  toolCalls: z.number().int().nonnegative().nullable().optional(),
  searchCalls: z.number().int().nonnegative().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  providers: z.array(z.string().min(1)).optional(),
  models: z.array(z.string().min(1)).optional(),
  reasoningEffort: z.string().nullable().optional(),
  speed: z.string().nullable().optional(),
}).strict();
export const runListItemSchema = runCatalogEntrySchema.extend({
  summary: runSummarySchema.optional(),
});
export const runListResponseSchema = z.object({
  items: z.array(runListItemSchema),
  pagination: paginationSchema,
}).strict();
export const runDetailResponseSchema = z.object({
  run: runCatalogEntrySchema,
  correction: runCorrectionLinkSchema.nullable().default(null),
  correctedRuns: z.array(runCorrectionLinkSchema).default([]),
}).strict();
export const runLifecycleResponseSchema = z.object({ run: runCatalogEntrySchema }).strict();
export const runFilterOptionsResponseSchema = z.object({
  providers: z.array(z.string().min(1)).default([]),
  models: z.array(z.string().min(1)).default([]),
  numericFields: z.array(runNumericFieldSchema),
}).strict();

export const storedArtifactSchema = z.object({
  key: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: contentHashSchema,
}).strict();
export const runArtifactsResponseSchema = z.object({
  runRef: runRefSchema,
  items: z.array(storedArtifactSchema),
}).strict();
export const runArtifactContentResponseSchema = z.object({
  runRef: runRefSchema,
  artifact: storedArtifactSchema,
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),
}).strict();

export const runInputResponseSchema = z.object({
  runRef: runRefSchema,
  input: jsonValueSchema.nullable(),
}).strict();

export const publishedResultReferenceSchema = z.object({
  runRef: runRefSchema,
  resultKind: safeIdentifierSchema,
  resultId: resultIdSchema,
  payloadSchemaVersion: z.number().int().positive().nullable(),
}).strict();
export const publishedResultListResponseSchema = z.object({
  runRef: runRefSchema,
  items: z.array(publishedResultReferenceSchema),
}).strict();
export const publishedResultDtoSchema = z.object({
  resultId: resultIdSchema,
  envelopeSchemaVersion: z.literal(1),
  resultKind: safeIdentifierSchema,
  runRef: runRefSchema,
  payload: jsonValueSchema,
}).strict();

const agentUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  cost: usageCostSchema.optional(),
}).strict();
const agentArtifactsSchema = z.object({
  eventsPath: z.string().min(1),
  stderrPath: z.string().min(1),
  lastMessagePath: z.string().min(1),
  heartbeatPath: z.string().min(1),
  repositoryToolAuditPath: z.string().min(1).optional(),
}).strict();
const agentMetricsSchema = z.object({
  providerId: safeIdentifierSchema,
  label: z.string().min(1).optional(),
  attempt: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  status: z.enum(["complete", "failed", "timed-out"]),
  elapsedMs: z.number().int().nonnegative(),
  artifacts: agentArtifactsSchema,
  nativeToolCalls: z.number().int().nonnegative(),
  toolCallUnit: z.enum(["shell-command", "guarded-repository-operation", "native-tool-call"]),
  repositorySearchCalls: z.number().int().nonnegative().optional(),
  fileReadCalls: z.number().int().nonnegative().optional(),
  repositoryResultBytes: z.number().int().nonnegative().optional(),
  rejectedRepositoryCalls: z.number().int().nonnegative().optional(),
  usage: agentUsageSchema.optional(),
}).strict();
const stagePerformanceSchema = z.object({
  stageId: safeIdentifierSchema,
  status: z.enum(["complete", "failed"]),
  elapsedMs: z.number().int().nonnegative(),
}).strict();
const agentAttemptPerformanceSchema = z.object({
  stageId: safeIdentifierSchema,
  logicalAgentId: safeIdentifierSchema,
  metrics: agentMetricsSchema,
}).strict();
const runUsageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  costs: z.array(usageCostSchema).min(1).optional(),
}).strict();
export const runPerformanceSchema = z.object({
  schemaVersion: z.literal(1),
  runRef: runRefSchema,
  workflow: workflowIdentitySchema,
  startedAt: canonicalTimestampSchema,
  completedAt: canonicalTimestampSchema,
  totalElapsedMs: z.number().int().nonnegative(),
  stages: z.array(stagePerformanceSchema),
  agentAttempts: z.array(agentAttemptPerformanceSchema),
  usage: runUsageSummarySchema.optional(),
}).strict();
export const runPerformanceResponseSchema = z.object({
  runRef: runRefSchema,
  performance: runPerformanceSchema.nullable(),
}).strict();

export const resolvedConfigurationResponseSchema = z.object({
  runRef: runRefSchema,
  resolvedConfiguration: jsonValueSchema.nullable(),
}).strict();

export const runComparisonRequestSchema = z.object({
  executionIds: z.array(safeIdentifierSchema).min(2).max(20)
    .refine((values) => new Set(values).size === values.length, "execution IDs must be unique"),
}).strict();
export const runComparisonRowSchema = z.object({
  runRef: runRefSchema,
  status: z.enum(["running", "waiting_for_input", "resume_queued", "complete", "failed", "cancelled"]).nullable(),
  userId: safeIdentifierSchema,
  roleId: safeIdentifierSchema,
  workflow: workflowIdentitySchema,
  target: runTargetSchema.nullable(),
  runConfiguration: runConfigurationReferenceSchema.nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  providers: z.array(z.string().min(1)).default([]),
  models: z.array(z.string().min(1)).default([]),
  reasoningEffort: z.string().nullable(),
  speed: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
  costs: z.array(usageCostSchema).nullable(),
  toolCalls: z.number().int().nonnegative().nullable(),
  searchCalls: z.number().int().nonnegative().nullable(),
}).strict();
export const runComparisonResponseSchema = z.object({
  rows: z.array(runComparisonRowSchema).min(2).max(20),
}).strict();

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: jsonValueSchema.optional(),
  }).strict(),
}).strict();

export type SubmitRunRequestDto = z.infer<typeof submitRunRequestSchema>;
export type SubmitRunResponseDto = z.infer<typeof submitRunResponseSchema>;
export type CancelRunRequestDto = z.infer<typeof cancelRunRequestSchema>;
export type RunCorrectionLinkDto = z.infer<typeof runCorrectionLinkSchema>;
export type WorkflowPreflightRequestDto = z.infer<typeof workflowPreflightRequestSchema>;
export type AgentProviderReadinessDto = z.infer<typeof agentProviderReadinessSchema>;
export type WorkflowPreflightResponseDto = z.infer<typeof workflowPreflightResponseSchema>;
export type WorkflowDto = z.infer<typeof workflowSchema>;
export type AgentSlotDto = z.infer<typeof agentSlotSchema>;
export type WorkflowListResponseDto = z.infer<typeof workflowListResponseSchema>;
export type RunListQueryDto = z.infer<typeof runListQuerySchema>;
export type RunListResponseDto = z.infer<typeof runListResponseSchema>;
export type RunListItemDto = z.infer<typeof runListItemSchema>;
export type RunSummaryDto = z.infer<typeof runSummarySchema>;
export type RunSummaryField = NonNullable<RunListQueryDto["summaryFields"]>[number];
export type RunDetailResponseDto = z.infer<typeof runDetailResponseSchema>;
export type RunLifecycleResponseDto = z.infer<typeof runLifecycleResponseSchema>;
export type RunFilterOptionsResponseDto = z.infer<typeof runFilterOptionsResponseSchema>;
export type RunNumericField = z.infer<typeof runNumericFieldSchema>;
export type RunSortField = z.infer<typeof runSortFieldSchema>;
export type RunArtifactsResponseDto = z.infer<typeof runArtifactsResponseSchema>;
export type RunArtifactContentResponseDto = z.infer<typeof runArtifactContentResponseSchema>;
export type RunInputResponseDto = z.infer<typeof runInputResponseSchema>;
export type PublishedResultListResponseDto = z.infer<typeof publishedResultListResponseSchema>;
export type PublishedResultDto<TPayload extends JsonValue = JsonValue> = Omit<
  z.infer<typeof publishedResultDtoSchema>,
  "payload"
> & { payload: TPayload };
export type RunPerformanceResponseDto = z.infer<typeof runPerformanceResponseSchema>;
export type ResolvedConfigurationResponseDto = z.infer<typeof resolvedConfigurationResponseSchema>;
export type RunComparisonRequestDto = z.infer<typeof runComparisonRequestSchema>;
export type RunComparisonResponseDto = z.infer<typeof runComparisonResponseSchema>;
export type RunComparisonRowDto = z.infer<typeof runComparisonRowSchema>;
export type ApiErrorResponseDto = z.infer<typeof apiErrorResponseSchema>;
