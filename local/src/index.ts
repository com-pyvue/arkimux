import type { ServerType } from "@hono/node-server";
import {
  type CodedWorkflowRegistration,
} from "../../apps/packages/run/api/src/index.ts";
import {
  type RunConfigurationDefinitionValidator,
} from "../../apps/packages/run-configuration/api/src/index.ts";
import { type LocalResultView, type LocalResultViewSource } from "./resultViews.ts";
import { createLocalDevelopmentServer } from "./developmentServer.ts";
export type { LocalResultView, LocalResultViewSource } from "./resultViews.ts";
export { createLocalGraphWorkflow, createLocalPortableWorkflow } from "./portableWorkflow.ts";
export type { LocalGraphWorkflowOptions, LocalPortableWorkflowOptions, PortableWorkflowDefinition } from "./portableWorkflow.ts";
export { withLocalWorkflowDeclaration, assertLocalWorkflowDeclarations, assertLocalRendererDeclarations, type LocalWorkflowDeclarationBinding } from "./workflowDeclarations.ts";
export { createLocalAgentAuthProviderRegistry } from "./localAgentAuthProviderRegistry.ts";

export { resolveLocalFileStorePaths, type LocalFileStorePaths } from "./localStorePaths.ts";
export {
  validateWorkflowEnvironmentDeclaration,
  resolveWorkflowEnvironment,
  loadLocalWorkflowEnvironment,
  type WorkflowEnvironmentDeclaration,
  type WorkflowEnvironmentVariableDeclaration,
  type ResolvedWorkflowEnvironment,
} from "./workflowEnvironment.ts";

export interface LocalWorkflowRegistration<TInput = unknown> extends CodedWorkflowRegistration<TInput> {
  runConfigurationValidator: RunConfigurationDefinitionValidator;
}

export interface StartLocalWorkflowDevelopmentServerOptions {
  repositoryRoot: string;
  subjectId: string;
  workflows: readonly LocalWorkflowRegistration[];
  resultViews?: readonly LocalResultView[];
  resultViewSource?: LocalResultViewSource;
  hostname?: string;
  port?: number;
  environment?: NodeJS.ProcessEnv;
  onBackgroundError?(error: Error): void;
}

export async function startLocalWorkflowDevelopmentServer(
  options: StartLocalWorkflowDevelopmentServerOptions,
): Promise<{ server: ServerType; url: string }> {
  const host = await createLocalDevelopmentServer(options);
  void host.recover().catch((error: Error) => options.onBackgroundError?.(error));
  return { server: host.server, url: host.url };
}
