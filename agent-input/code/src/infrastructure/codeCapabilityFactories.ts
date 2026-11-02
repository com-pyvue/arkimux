import type {
  CodeCapabilityAdapterFactory,
  CodeCapabilityAdapterRegistry,
  CodeCapabilityRole,
} from "../application/codeCapability.ts";
import { DefaultCodeCapabilityAdapterRegistry } from "../application/codeCapability.ts";
import { GitCodeSnapshotProvider } from "./git/gitSnapshotProvider.ts";
import { GuardedRepositoryPiExtensionProvider } from "./repository/guardedRepositoryPiExtensionProvider.ts";

function validateEmptyOptions(options: unknown, adapterId: string): Record<string, unknown> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error(`Code capability adapter ${adapterId} options must be an object.`);
  }
  const keys = Object.keys(options);
  if (keys.length > 0) {
    throw new Error(`Code capability adapter ${adapterId} does not support options [${keys.join(", ")}].`);
  }
  return {};
}

function factory<TRole extends CodeCapabilityRole>(input: {
  adapterId: string;
  role: TRole;
  create(): ReturnType<CodeCapabilityAdapterFactory<TRole>["create"]>;
}): CodeCapabilityAdapterFactory<TRole> {
  return {
    adapterId: input.adapterId,
    role: input.role,
    validateConfig: (options) => validateEmptyOptions(options, input.adapterId),
    async create(context) {
      validateEmptyOptions(context.options, input.adapterId);
      return input.create();
    },
    async preflight() {
      return { adapterId: input.adapterId, role: input.role, available: true };
    },
  };
}

export const gitCodeSnapshotAdapterFactory = factory({
  adapterId: "git-code-snapshot@1",
  role: "code-snapshot",
  create: async () => new GitCodeSnapshotProvider(),
});

export const guardedRepositoryToolsAdapterFactory = factory({
  adapterId: "guarded-repository-tools@1",
  role: "repository-tools",
  create: async () => ({
    piExtensionProvider: new GuardedRepositoryPiExtensionProvider(),
  }),
});

export function createDefaultCodeCapabilityAdapterRegistry(): CodeCapabilityAdapterRegistry {
  return new DefaultCodeCapabilityAdapterRegistry([
    gitCodeSnapshotAdapterFactory,
    guardedRepositoryToolsAdapterFactory,
  ]);
}
