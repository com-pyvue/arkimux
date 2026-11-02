export type * from "./application/codeSnapshot.ts";
export type * from "./application/codeCapability.ts";
export { DefaultCodeCapabilityAdapterRegistry } from "./application/codeCapability.ts";
export {
  gitCommand,
  type GitCommand,
} from "./infrastructure/git/gitCommand.ts";
export { GitCodeSnapshotProvider } from "./infrastructure/git/gitSnapshotProvider.ts";
export {
  createGuardedRepositoryHandlers,
  DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS,
  GUARDED_REPOSITORY_TOOL_GUIDANCE,
  GUARDED_REPOSITORY_TOOL_NAMES,
  prepareGuardedRepositoryExtension,
  renderGuardedRepositoryExtension,
} from "./infrastructure/repository/guardedRepositoryTools.ts";
export type {
  GuardedRepositoryHandlers,
  GuardedRepositoryHandlerDependencies,
  GuardedRepositoryToolLimits,
} from "./infrastructure/repository/guardedRepositoryTools.ts";
export {
  GuardedRepositoryPiExtensionProvider,
  summarizeGuardedRepositoryToolAudit,
} from "./infrastructure/repository/guardedRepositoryPiExtensionProvider.ts";
export {
  createDefaultCodeCapabilityAdapterRegistry,
  gitCodeSnapshotAdapterFactory,
  guardedRepositoryToolsAdapterFactory,
} from "./infrastructure/codeCapabilityFactories.ts";
