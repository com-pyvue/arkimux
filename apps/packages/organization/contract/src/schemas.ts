import { z } from "zod";

export const organizationIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
export const canonicalTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
});
export const organizationSchema = z.object({
  schemaVersion: z.literal(1),
  organizationId: organizationIdSchema,
  displayName: z.string().trim().min(1).max(256),
  status: z.enum(["active", "disabled"]),
  createdAt: canonicalTimestampSchema,
}).strict();
export const createOrganizationRequestSchema = z.object({
  organizationId: organizationIdSchema,
  displayName: z.string().trim().min(1).max(256),
}).strict();
export const setOrganizationStatusRequestSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();
export const organizationResponseSchema = z.object({ organization: organizationSchema }).strict();
export const organizationListResponseSchema = z.object({
  items: z.array(organizationSchema),
  pagination: z.object({ nextCursor: z.string().optional() }).strict(),
}).strict();
export const apiErrorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
export type OrganizationDto = z.infer<typeof organizationSchema>;
export type CreateOrganizationRequestDto = z.infer<typeof createOrganizationRequestSchema>;
export type OrganizationResponseDto = z.infer<typeof organizationResponseSchema>;
export type OrganizationListResponseDto = z.infer<typeof organizationListResponseSchema>;
export type SetOrganizationStatusRequestDto = z.infer<typeof setOrganizationStatusRequestSchema>;
