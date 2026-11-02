import type { PiAgentExtensionProvider } from "@com-pyvue/agent-execution-core";
import type { CodeSnapshotProvider } from "./codeSnapshot.ts";

export type CodeCapabilityRole = "code-snapshot" | "repository-tools";

export interface RepositoryToolsCapability {
  piExtensionProvider: PiAgentExtensionProvider;
}

export interface CodeCapabilityPortByRole {
  "code-snapshot": CodeSnapshotProvider;
  "repository-tools": RepositoryToolsCapability;
}

export interface CodeCapabilityAdapterContext {
  options: Record<string, unknown>;
}

export interface CodeCapabilityPreflightResult {
  adapterId: string;
  role: CodeCapabilityRole;
  available: boolean;
  message?: string;
}

export interface CodeCapabilityAdapterFactory<TRole extends CodeCapabilityRole = CodeCapabilityRole> {
  adapterId: string;
  role: TRole;
  validateConfig(options: unknown): Record<string, unknown>;
  create(context: CodeCapabilityAdapterContext): Promise<CodeCapabilityPortByRole[TRole]>;
  preflight(capability: CodeCapabilityPortByRole[TRole]): Promise<CodeCapabilityPreflightResult>;
}

export interface CodeCapabilityAdapterRegistry {
  resolve<TRole extends CodeCapabilityRole>(
    role: TRole,
    adapterId: string,
  ): CodeCapabilityAdapterFactory<TRole>;
}

export class DefaultCodeCapabilityAdapterRegistry implements CodeCapabilityAdapterRegistry {
  private readonly factories = new Map<string, CodeCapabilityAdapterFactory>();

  constructor(factories: readonly CodeCapabilityAdapterFactory[] = []) {
    for (const factory of factories) {
      const key = this.key(factory.role, factory.adapterId);
      if (this.factories.has(key)) {
        throw new Error(`Duplicate code capability adapter: ${factory.role}/${factory.adapterId}.`);
      }
      this.factories.set(key, factory);
    }
  }

  resolve<TRole extends CodeCapabilityRole>(
    role: TRole,
    adapterId: string,
  ): CodeCapabilityAdapterFactory<TRole> {
    const factory = this.factories.get(this.key(role, adapterId));
    if (!factory) throw new Error(`Unknown code capability adapter: ${role}/${adapterId}.`);
    return factory as CodeCapabilityAdapterFactory<TRole>;
  }

  private key(role: CodeCapabilityRole, adapterId: string): string {
    return `${role}\u0000${adapterId}`;
  }
}
