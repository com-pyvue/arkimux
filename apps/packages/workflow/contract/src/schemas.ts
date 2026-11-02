import { z } from "zod";
export const safeId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
export const workflowIdentitySchema = z.object({ kind: safeId, version: z.number().int().positive() }).strict();
export const releaseRefSchema = z.object({
  workflow: workflowIdentitySchema,
  releaseId: safeId,
  sourceCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export const publishReleaseRequestSchema = z.object({ release: releaseRefSchema }).strict();
export const releaseSchema = z.object({ schemaVersion: z.literal(1), organization: z.object({ organizationId: safeId }).strict(), release: releaseRefSchema, createdAt: z.string().datetime() }).strict();
export const deploymentSchema = z.object({
  schemaVersion: z.literal(1),
  organization: z.object({ organizationId: safeId }).strict(),
  environment: z.object({ environmentId: safeId }).strict(),
  workflowDeployment: z.object({ workflowDeploymentId: safeId }).strict(),
  release: releaseRefSchema,
  definitionVersion: z.number().int().positive(),
  executionBundleId: safeId,
  executionBundleVersion: z.number().int().positive(),
  status: z.enum(["draft", "deploying", "ready", "unhealthy", "decommissioning", "decommissioned"]),
  dispatchReady: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export const publishDeploymentRequestSchema = deploymentSchema.omit({ schemaVersion: true, organization: true, status: true, dispatchReady: true, createdAt: true, updatedAt: true });
export const updateReadinessRequestSchema = z.object({ status: deploymentSchema.shape.status, dispatchReady: z.boolean() }).strict();
export const releaseResponseSchema = z.object({ release: releaseSchema }).strict();
export const deploymentResponseSchema = z.object({ deployment: deploymentSchema }).strict();
export const deploymentListResponseSchema = z.object({ items: z.array(deploymentSchema), pagination: z.object({ nextCursor: z.string().optional() }).strict() }).strict();
export const apiErrorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
export type PublishReleaseRequestDto = z.infer<typeof publishReleaseRequestSchema>;
export type PublishDeploymentRequestDto = z.infer<typeof publishDeploymentRequestSchema>;
export type UpdateReadinessRequestDto = z.infer<typeof updateReadinessRequestSchema>;
export type DeploymentListResponseDto = z.infer<typeof deploymentListResponseSchema>;
export type DeploymentResponseDto = z.infer<typeof deploymentResponseSchema>;
export type ReleaseResponseDto = z.infer<typeof releaseResponseSchema>;
