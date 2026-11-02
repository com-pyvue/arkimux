import {
  FileAgentAuthProviderStore,
  FilePlaintextAgentCredentialStore,
  createStoreBackedAgentAuthProviderRegistry,
  type AgentAuthProviderRegistry,
  type ResolvedAgentProviderConfig,
} from "../../core/src/index.ts";
import { resolveLocalFileStorePaths } from "./localStorePaths.ts";

/** Resolve current host credentials without importing or starting the Local API. */
export async function createLocalAgentAuthProviderRegistry(options: {
  repositoryRoot: string;
  providerConfig: ResolvedAgentProviderConfig;
  environment?: NodeJS.ProcessEnv;
}): Promise<AgentAuthProviderRegistry> {
  const paths = resolveLocalFileStorePaths(options.repositoryRoot);
  const definitions = new FileAgentAuthProviderStore(paths.agentAuthProviders);
  const credentials = new FilePlaintextAgentCredentialStore(paths.credentials);
  return createStoreBackedAgentAuthProviderRegistry(
    options.providerConfig,
    definitions,
    credentials,
    options.environment ?? process.env,
  );
}
