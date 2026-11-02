/** Additive Local retained-execution metadata; the frozen V1 declaration stays unchanged. */
import { z } from "zod";
import { projectSourcePathV1Schema, sourceExportV1Schema, workflowDeclarationV1Schema } from "./workflowManifest.ts";

export const retainedConstructionDeclarationSchema = sourceExportV1Schema.extend({
  assets: z.array(projectSourcePathV1Schema).refine(paths => new Set(paths).size === paths.length, "Duplicate retained asset."),
  invocationModel: z.enum(["workflow-input", "graph-entry"]).optional(),
}).strict();

export const workflowDeclarationWithConstructionSchema = workflowDeclarationV1Schema.extend({
  construction: retainedConstructionDeclarationSchema.optional(),
}).strict();
export type WorkflowDeclarationWithConstruction = z.infer<typeof workflowDeclarationWithConstructionSchema>;
