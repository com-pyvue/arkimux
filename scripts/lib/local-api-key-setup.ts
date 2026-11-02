import path from "node:path";
import { AgentAuthenticationApplicationService, createAgentAuthenticationRouter } from "../../apps/packages/agent-authentication/api/src/index.ts";
import { AgentAuthenticationApiClient } from "../../apps/packages/agent-authentication/contract/src/index.ts";
import {
  FileAgentAuthProviderStore, FilePlaintextAgentCredentialStore,
  createStoreBackedAgentAuthProviderRegistry, createAgentExecutionProviderRegistry,
  ExecutionAgentAuthConnectionProbe,
  resolveAgentProviderConfigDocument,
  type AgentAuthConnectionProbe, type ResolvedAgentProviderConfig,
} from "../../core/src/index.ts";
import { loadPiCliProbeModels } from "../../core/src/infrastructure/agents/piCliModelCatalog.ts";

/** Validate the project document before replacing its static auth catalog with private REST records. */
export function resolvePrivateApiKeyConfig(document: unknown, environment: NodeJS.ProcessEnv): ResolvedAgentProviderConfig {
  const config = resolveAgentProviderConfigDocument(document, environment);
  // The store-backed registry obtains the sole binding from configurePrivateAnthropicKey.
  // Resolving a document with an empty auth catalog is invalid; clearing it happens only here.
  return { ...config, authProviders: {} };
}

/** Private setup harness, not a released catalog or a production authentication bypass.
 * Uses the real HTTP Request/Response routes in-process; binds no network listener.
 */
export function createPrivateApiKeySetup(
  root: string,
  config: ResolvedAgentProviderConfig,
  environment: NodeJS.ProcessEnv,
  controlledProbe?: AgentAuthConnectionProbe,
  cancelled: () => boolean = () => false,
) {
  const providers = new FileAgentAuthProviderStore(path.join(root, "definitions"));
  const credentials = new FilePlaintextAgentCredentialStore(path.join(root, "credentials"));
  const auth = createStoreBackedAgentAuthProviderRegistry(config, providers, credentials, environment);
  const registry = createAgentExecutionProviderRegistry(config, auth, environment);
  const probe = controlledProbe ?? new ExecutionAgentAuthConnectionProbe({ get: (id) => {
    const provider = registry.get(id);
    return { providerId: provider.providerId, preflight: provider.preflight.bind(provider), run: (request) => {
      if (cancelled()) throw new Error("Private setup was cancelled before inference.");
      return provider.run(request);
    } };
  } }, config, root, environment, async (options) => (await loadPiCliProbeModels(options)).slice(0, 1));
  const permissions = ["agent-auth-providers:admin"];
  const router = createAgentAuthenticationRouter({
    service: new AgentAuthenticationApplicationService(providers, credentials, { providerConfig: config, connectionProbe: {
      probe: async (target) => {
        const definition = (await providers.get(target.authProviderId))?.definition;
        const secret = definition?.kind === "stored-credential" ? await credentials.getValue(definition.credentialId) : undefined;
        const result = await probe.probe(target);
        return secret ? { ...result, message: result.message.split(secret).join("[REDACTED]"),
          ...(result.probeModel ? { probeModel: result.probeModel.split(secret).join("[REDACTED]") } : {}),
        } : result;
      },
    } }),
    authenticate: async () => ({
      user: { schemaVersion: 1, userId: "private-setup-operator", status: "active", identity: { providerId: "private-setup", subjectId: "operator" }, registeredAt: "2026-09-06T00:00:00.000Z" },
      roles: [{ schemaVersion: 1, roleId: "private-setup", permissions }], permissions,
    }),
  });
  const routes: string[] = [];
  const client = new AgentAuthenticationApiClient({
    baseUrl: "http://private-setup.invalid",
    fetch: async (input, init) => {
      // Retain route names only, never request bodies or credential hashes.
      routes.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return router.request(input, init);
    },
  });
  return { client, routes };
}

export async function configurePrivateAnthropicKey(client: AgentAuthenticationApiClient, credential: string) {
  await client.createCredential({ definition: { schemaVersion: 1, credentialId: "private-anthropic-key", displayName: "Private setup key", kind: "api-key", modelProvider: "anthropic" }, credential });
  await client.create({ definition: { schemaVersion: 2, authProviderId: "pi-anthropic-api-key", displayName: "Pi Claude API key", kind: "stored-credential", executionProviderId: "pi-cli", modelProvider: "anthropic", credentialId: "private-anthropic-key", targetVariable: "ANTHROPIC_API_KEY" } });
}
