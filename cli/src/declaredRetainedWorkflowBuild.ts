/** Registry-to-build preparation for new Runs, never a resolver for existing Runs. */
import { validateProjectSource } from "./projectSourceGuard.ts";
import { prepareRetainedWorkflowBuild } from "./retainedWorkflowBuild.ts";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";

export async function prepareDeclaredRetainedWorkflowBuild(store: FileRetainedExecutionStoreV1, options: {
  projectRoot: string; workflowId: string; hostRequirements: Record<string, string>;
}) {
  const project = await validateProjectSource(options.projectRoot, { includeRenderers: false });
  const workflow = project.workflows.find(item => item.manifest.workflowId === options.workflowId);
  if (!workflow) throw new Error(`Workflow ${options.workflowId} is not declared in this project.`);
  const construction = workflow.declaration.construction;
  if (!construction) throw new Error(`Workflow ${options.workflowId} requires a retained construction declaration; its live registry factory cannot be used for resumable Runs.`);
  if (!project.sourceDigests) throw new Error("Retained admission requires source-policy validation.");
  const build = await prepareRetainedWorkflowBuild(store, { projectRoot: options.projectRoot,
    entryPoint: construction.file, constructionExport: construction.export, assets: construction.assets,
    invocationModel: construction.invocationModel,
    effectAdapterExports: workflow.declaration.effects,
    constructionValidators: { input: workflow.declaration.inputValidator, output: workflow.declaration.resultValidator },
    resultSchemaVersion: workflow.declaration.result.schemaVersion,
    validatedInputFiles: project.sourceDigests, hostRequirements: options.hostRequirements });
  return { ...build, workflow };
}
