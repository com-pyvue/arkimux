import type {
  AgentExecutionProvider,
  AgentExecutionProviderRegistry,
  AgentAuthProviderRegistry,
  PiAgentExtensionProvider,
} from "../../application/agentProvider.ts";
import { NoopPiAgentExtensionProvider } from "../../application/agentProvider.ts";
import type { ResolvedAgentProviderConfig } from "./agentProviderConfigProvider.ts";
import { CodexCliAgentRunner } from "./codexCliAgentRunner.ts";
import { PiCliAgentRunner } from "./piCliAgentRunner.ts";
import { ClaudeCodeCliAgentRunner } from "./claudeCodeCliAgentRunner.ts";
import { KimiCodeCliAgentRunner } from "./kimiCodeCliAgentRunner.ts";

export class DefaultAgentExecutionProviderRegistry implements AgentExecutionProviderRegistry {
  private readonly providers: ReadonlyMap<string, AgentExecutionProvider>;

  constructor(providers: AgentExecutionProvider[]) {
    const entries = providers.map((provider) => [provider.providerId, provider] as const);
    const uniqueProviderIds = new Set(entries.map(([providerId]) => providerId));
    if (uniqueProviderIds.size !== entries.length) {
      throw new Error("Agent execution provider registry contains duplicate provider IDs.");
    }
    this.providers = new Map(entries);
  }

  get(providerId: string): AgentExecutionProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Agent execution provider ${providerId} is not installed.`);
    }
    return provider;
  }
}

export function createAgentExecutionProviderRegistry(
  config: ResolvedAgentProviderConfig,
  authProviders: AgentAuthProviderRegistry,
  environment: NodeJS.ProcessEnv = process.env,
  piExtensionProvider: PiAgentExtensionProvider = new NoopPiAgentExtensionProvider(),
): AgentExecutionProviderRegistry {
  return new DefaultAgentExecutionProviderRegistry([
    new CodexCliAgentRunner(config.executionProviders["codex-cli"], authProviders, environment),
    new PiCliAgentRunner(
      config.executionProviders["pi-cli"],
      authProviders,
      environment,
      piExtensionProvider,
    ),
    new ClaudeCodeCliAgentRunner(
      config.executionProviders["claude-code-cli"],
      authProviders,
      environment,
    ),
    new KimiCodeCliAgentRunner(
      config.executionProviders["kimi-code-cli"],
      authProviders,
      environment,
    ),
  ]);
}
