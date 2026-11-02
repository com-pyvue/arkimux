import { z } from "zod";
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
const organization = z.object({ organizationId: id }).strict();
const environment = z.object({ environmentId: id }).strict();
const workflowDeployment = z.object({ workflowDeploymentId: id }).strict();
export const healthTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("environment"), organization, environment }).strict(),
  z.object({ kind: z.literal("workflow"), organization, environment, workflowDeployment }).strict(),
]);
export const deploymentHealthSchema = z.object({ schemaVersion: z.literal(1), target: healthTargetSchema, status: z.enum(["healthy", "unhealthy", "decommissioned"]), revision: z.number().int().nonnegative(), checkedAt: z.string().datetime(), details: z.record(z.string(), z.string()).optional() }).strict();
export const meterRecordSchema = z.object({ schemaVersion: z.literal(1), meterId: id, organization, environment, workflowDeployment: workflowDeployment.optional(), meterKind: id, quantity: z.number().nonnegative(), unit: id, occurredAt: z.string().datetime() }).strict();
export const healthResponseSchema = z.object({ health: deploymentHealthSchema }).strict();
export const meterListResponseSchema = z.object({ items: z.array(meterRecordSchema), pagination: z.object({ nextCursor: z.string().optional() }).strict() }).strict();
export const decommissionReadinessSchema = z.object({ ready: z.boolean(), blockingWorkflowDeploymentIds: z.array(id) }).strict();
export const apiErrorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
export type DeploymentHealthDto = z.infer<typeof deploymentHealthSchema>;
export type MeterRecordDto = z.infer<typeof meterRecordSchema>;
export type DecommissionReadinessDto = z.infer<typeof decommissionReadinessSchema>;
