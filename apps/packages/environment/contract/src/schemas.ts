import { z } from "zod";

export const safeId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
export const placementSchema = z.object({
  provider: z.enum(["aws", "gcp"]),
  owner: z.enum(["customer", "managed"]),
  accountOrProjectId: z.string().min(1).max(128),
  region: z.string().min(1).max(128),
}).strict();
export const environmentSchema = z.object({
  schemaVersion: z.literal(1),
  organization: z.object({ organizationId: safeId }).strict(),
  environment: z.object({ environmentId: safeId }).strict(),
  displayName: z.string().min(1).max(256),
  placement: placementSchema,
  definitionVersion: z.number().int().positive(),
  dataApiBundleId: safeId,
  dataApiBundleVersion: z.number().int().positive(),
  status: z.enum(["draft", "deploying", "ready", "unhealthy", "decommissioning", "decommissioned"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export const publishEnvironmentRequestSchema = environmentSchema.omit({ schemaVersion: true, organization: true, status: true, createdAt: true, updatedAt: true });
export const updateEnvironmentStatusRequestSchema = z.object({ status: environmentSchema.shape.status }).strict();
export const environmentResponseSchema = z.object({ environment: environmentSchema }).strict();
export const environmentListResponseSchema = z.object({ items: z.array(environmentSchema), pagination: z.object({ nextCursor: z.string().optional() }).strict() }).strict();
export const apiErrorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
export type EnvironmentDto = z.infer<typeof environmentSchema>;
export type PublishEnvironmentRequestDto = z.infer<typeof publishEnvironmentRequestSchema>;
export type UpdateEnvironmentStatusRequestDto = z.infer<typeof updateEnvironmentStatusRequestSchema>;
export type EnvironmentResponseDto = z.infer<typeof environmentResponseSchema>;
export type EnvironmentListResponseDto = z.infer<typeof environmentListResponseSchema>;
