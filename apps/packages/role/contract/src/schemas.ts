import { z } from "zod";

export const safeIdentifierSchema = z.string().min(1).max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
export const permissionSchema = safeIdentifierSchema;

export const roleSchema = z.object({
  schemaVersion: z.literal(1),
  roleId: safeIdentifierSchema,
  permissions: z.array(permissionSchema).min(1),
}).strict();

export const defineRoleRequestSchema = z.object({
  roleId: safeIdentifierSchema,
  permissions: z.array(permissionSchema).min(1),
}).strict();
export const defineRoleResponseSchema = z.object({ role: roleSchema }).strict();

export const pageQuerySchema = z.object({
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
}).strict();
export const paginationSchema = z.object({ nextCursor: z.string().min(1).optional() }).strict();
export const roleListResponseSchema = z.object({
  items: z.array(roleSchema),
  pagination: paginationSchema,
}).strict();
export const roleDetailResponseSchema = z.object({ role: roleSchema }).strict();

export const roleAssignmentSchema = z.object({
  userId: safeIdentifierSchema,
  roleId: safeIdentifierSchema,
}).strict();
export const roleAssignmentListQuerySchema = pageQuerySchema.extend({
  userId: safeIdentifierSchema.optional(),
  roleId: safeIdentifierSchema.optional(),
}).strict();
export const roleAssignmentListResponseSchema = z.object({
  items: z.array(roleAssignmentSchema),
  pagination: paginationSchema,
}).strict();
export const assignRoleRequestSchema = roleAssignmentSchema;
export const assignRoleResponseSchema = z.object({ assignment: roleAssignmentSchema }).strict();
export const revokeRoleResponseSchema = z.object({
  assignment: roleAssignmentSchema,
  revoked: z.boolean(),
}).strict();

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }).strict(),
}).strict();

export type RoleDto = z.infer<typeof roleSchema>;
export type DefineRoleRequestDto = z.infer<typeof defineRoleRequestSchema>;
export type DefineRoleResponseDto = z.infer<typeof defineRoleResponseSchema>;
export type PageQueryDto = z.infer<typeof pageQuerySchema>;
export type RoleListResponseDto = z.infer<typeof roleListResponseSchema>;
export type RoleDetailResponseDto = z.infer<typeof roleDetailResponseSchema>;
export type RoleAssignmentDto = z.infer<typeof roleAssignmentSchema>;
export type RoleAssignmentListQueryDto = z.infer<typeof roleAssignmentListQuerySchema>;
export type RoleAssignmentListResponseDto = z.infer<typeof roleAssignmentListResponseSchema>;
export type AssignRoleRequestDto = z.infer<typeof assignRoleRequestSchema>;
export type AssignRoleResponseDto = z.infer<typeof assignRoleResponseSchema>;
export type RevokeRoleResponseDto = z.infer<typeof revokeRoleResponseSchema>;
