import { z } from "zod";
import { jsonValueSchema, runRefSchema, safeIdentifierSchema, workflowIdentitySchema } from "./schemas.ts";
import { graphDescriptionSchema, graphEntryPresentationSchema } from "./graphDescription.ts";

export const inputRequestIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/)
  .refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const id = inputRequestIdSchema;
const fieldId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/)
  .refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const at = z.string().datetime({ precision: 3 });
const positive = z.number().int().positive().safe();
const field = { id: fieldId, label: z.string().min(1), required: z.boolean() };
export const inputFieldSchema = z.discriminatedUnion("type", [
  z.object({ ...field, type: z.literal("text"), maxLength: positive }).strict(),
  z.object({ ...field, type: z.literal("number"), min: z.number().finite(), max: z.number().finite(), integer: z.boolean() }).strict(),
  z.object({ ...field, type: z.literal("boolean") }).strict(),
  z.object({ ...field, type: z.literal("date") }).strict(),
  z.object({ ...field, type: z.literal("choice"), options: z.array(z.string()).min(1) }).strict(),
  z.object({ ...field, type: z.literal("files"), maxFiles: positive, maxBytesPerFile: positive, mediaTypes: z.array(z.string()).min(1) }).strict(),
]);
export const inputFormSchema = z.object({ schemaVersion: z.literal(1), id: fieldId, version: fieldId, fields: z.array(inputFieldSchema) }).strict();
export const inputAnswerSchema = z.object({ schemaVersion: z.literal(1), fields: z.record(fieldId, z.union([z.string(), z.number().finite(), z.boolean()])),
  files: z.record(fieldId, z.array(z.object({ objectId: fieldId, mediaType: z.string(), byteLength: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict())) }).strict();
// Keep the submission envelope separate: invalid answer fields are 422, not 400.
export const inputSubmissionSchema = z.object({ submissionId: id, expectedRevision: z.number().int().positive().safe(), response: jsonValueSchema }).strict();
export const inputReceiptSchema = z.object({ schemaVersion: z.literal(1), submissionId: id, requestId: id,
  acceptedAt: at, acceptedBodySha256: z.string().regex(/^[a-f0-9]{64}$/), resumeCommandId: id, responderId: id }).strict();
export const inputRequestItemSchema = z.object({ definition: z.object({ schemaVersion: z.literal(1), requestId: id, stepId: fieldId,
  title: z.string(), form: inputFormSchema, formSha256: z.string().regex(/^[a-f0-9]{64}$/), executableBindingId: id,
  createdAt: at, expiresAt: at }).strict(), status: z.enum(["pending", "submitted", "cancelled", "expired"]),
  revision: positive, updatedAt: at, response: inputAnswerSchema.optional(), receipt: inputReceiptSchema.optional() }).strict();
export const graphOccurrenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subgraph") }).strict(),
  z.object({ kind: z.literal("choice"), case: fieldId }).strict(),
  z.object({ kind: z.literal("map"), index: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal("reduce"), index: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal("loop"), iteration: z.number().int().nonnegative().safe() }).strict(),
]);
export const graphAddressSchema = z.object({ schemaVersion: z.literal(1), path: z.array(z.object({
  nodeId: fieldId, occurrence: graphOccurrenceSchema.optional(),
}).strict()).min(1) }).strict();
export const graphRequirementSchema = z.object({ id: z.string().min(1).max(1000),
  role: z.enum(["entry-input", "root-scope-input", "skipped-node-input", "skipped-node-output", "control-input",
    "map-completed-outputs", "reduce-accumulator", "loop-iteration"]),
  address: graphAddressSchema.optional(), contractVersion: fieldId,
  schema: z.record(z.string(), jsonValueSchema), provenance: z.literal("caller-supplied") }).strict();
export const graphInputRequestItemSchema = z.object({ kind: z.literal("graph-entry"), schemaVersion: z.literal(1),
  requestId: id, status: z.enum(["pending", "submitted", "cancelled", "expired"]), revision: positive,
  updatedAt: at, entry: graphAddressSchema, planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requirements: z.array(graphRequirementSchema), createdAt: at, expiresAt: at,
  accepted: z.object({ acceptanceId: id, acceptedAt: at, acceptedBodySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export const inputRequestsResponseSchema = z.object({ schemaVersion: z.literal(1), runRef: runRefSchema,
  items: z.array(z.union([inputRequestItemSchema, graphInputRequestItemSchema])) }).strict();
const graphInputAcceptanceSchema = z.object({ schemaVersion: z.literal(1), acceptanceId: id, requestId: id,
  acceptedAt: at, acceptedBodySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const inputSubmissionResponseSchema = z.union([
  z.object({ schemaVersion: z.literal(1), runRef: runRefSchema, receipt: inputReceiptSchema }).strict(),
  z.object({ schemaVersion: z.literal(1), runRef: runRefSchema, kind: z.literal("graph-entry"), accepted: graphInputAcceptanceSchema }).strict(),
]);
export const inputUploadFieldsSchema = z.object({ fieldId, uploadId: id }).strict();
export const inputFileRefSchema = z.object({ objectId: fieldId, mediaType: z.string(),
  byteLength: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const inputUploadResponseSchema = z.object({ schemaVersion: z.literal(1), runRef: runRefSchema,
  requestId: id, fieldId, uploadId: id, file: inputFileRefSchema }).strict();
export const graphEntrySelectionSchema = z.union([
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("selected"), address: graphAddressSchema }).strict(),
]);
export const workflowInvocationOptionsRequestSchema = z.object({
  workflow: workflowIdentitySchema,
  roleId: safeIdentifierSchema,
  runConfigurationId: safeIdentifierSchema,
}).strict();
export const workflowInvocationEntrySchema = z.object({
  id: safeIdentifierSchema,
  label: z.string().min(1),
  nodeKind: z.enum(["step", "subgraph", "map", "reduce", "loop", "choice"]),
  entry: graphEntrySelectionSchema,
  requirements: z.array(graphRequirementSchema).min(1),
  presentation: graphEntryPresentationSchema.optional(),
}).strict();
export const workflowInvocationOptionsResponseSchema = z.discriminatedUnion("model", [
  z.object({ model: z.literal("workflow-input") }).strict(),
  z.object({ model: z.literal("graph-entry"), entries: z.array(workflowInvocationEntrySchema).min(1), graph: graphDescriptionSchema.optional() }).strict(),
]);
export type InputSubmissionDto = z.infer<typeof inputSubmissionSchema>;
export type InputRequestsResponseDto = z.infer<typeof inputRequestsResponseSchema>;
export type InputSubmissionResponseDto = z.infer<typeof inputSubmissionResponseSchema>;
export type InputUploadFieldsDto = z.infer<typeof inputUploadFieldsSchema>;
export type InputUploadResponseDto = z.infer<typeof inputUploadResponseSchema>;
export type GraphAddressDto = z.infer<typeof graphAddressSchema>;
export type GraphRequirementDto = z.infer<typeof graphRequirementSchema>;
export type GraphEntrySelectionDto = z.infer<typeof graphEntrySelectionSchema>;
export type WorkflowInvocationOptionsRequestDto = z.infer<typeof workflowInvocationOptionsRequestSchema>;
export type WorkflowInvocationEntryDto = z.infer<typeof workflowInvocationEntrySchema>;
export type WorkflowInvocationOptionsResponseDto = z.infer<typeof workflowInvocationOptionsResponseSchema>;
