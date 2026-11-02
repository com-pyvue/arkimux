import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type {
  PlatformStoreAdapterContext,
  PlatformStoreAdapterFactory,
  PlatformStoreAdapterRegistry,
} from "../../application/platformStore.ts";
import { isRecord } from "../../domain/validation.ts";
import { FileRoleAssignmentStore } from "./fileRoleAssignmentStore.ts";
import { FileRoleStore } from "./fileRoleStore.ts";
import { FileRunConfigurationStore } from "./fileRunConfigurationStore.ts";
import { FileAgentTemplateStore } from "./fileAgentTemplateStore.ts";
import { FileAgentAuthProviderStore } from "./fileAgentAuthProviderStore.ts";
import { FilePlaintextAgentCredentialStore } from "./fileAgentCredentialStore.ts";
import { FileWorkflowRunConfigurationStore } from "./fileWorkflowRunConfigurationStore.ts";
import { FileUserStore } from "./fileUserStore.ts";
import { DefaultPlatformStoreAdapterRegistry } from "./platformStoreRegistry.ts";

interface FilePlatformStoreOptions {
  root: string;
  relativeTo: "repository" | "configuration";
}

function validateOptions(
  value: unknown,
  adapterId: string,
): Record<string, unknown> & FilePlatformStoreOptions {
  if (!isRecord(value)) throw new Error(`Platform store adapter ${adapterId} options must be an object.`);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => key !== "root" && key !== "relativeTo");
  if (unknown.length > 0) throw new Error(`Platform store adapter ${adapterId} has unknown options [${unknown.join(", ")}].`);
  if (typeof value.root !== "string" || value.root.length === 0) {
    throw new Error(`Platform store adapter ${adapterId} option root must be a non-empty string.`);
  }
  if (value.relativeTo !== "repository" && value.relativeTo !== "configuration") {
    throw new Error(`Platform store adapter ${adapterId} option relativeTo must be repository or configuration.`);
  }
  return { root: value.root, relativeTo: value.relativeTo } as Record<string, unknown> & FilePlatformStoreOptions;
}

function root(context: PlatformStoreAdapterContext): string {
  const options = context.options as unknown as FilePlatformStoreOptions;
  if (path.isAbsolute(options.root)) return path.resolve(options.root);
  const base = options.relativeTo === "repository" ? context.repositoryRoot : context.configurationRoot;
  if (!base) throw new Error(`Platform store root requires ${options.relativeTo}Root context.`);
  return path.resolve(base, options.root);
}

function factory<TStore extends { root: string }>(input: {
  adapterId: string;
  role: PlatformStoreAdapterFactory<TStore>["role"];
  create(rootPath: string): TStore;
}): PlatformStoreAdapterFactory<TStore> {
  return {
    adapterId: input.adapterId,
    role: input.role,
    validateConfig: (options) => validateOptions(options, input.adapterId),
    async create(context) {
      validateOptions(context.options, input.adapterId);
      return input.create(root(context));
    },
    async preflight(store) {
      try {
        await fs.mkdir(store.root, { recursive: true });
        await fs.access(store.root, fsConstants.R_OK | fsConstants.W_OK);
        return { adapterId: input.adapterId, role: input.role, available: true };
      } catch (error) {
        return {
          adapterId: input.adapterId,
          role: input.role,
          available: false,
          message: (error as Error).message,
        };
      }
    },
  };
}

export function createFilePlatformStoreAdapterFactories(): PlatformStoreAdapterFactory[] {
  return [
    factory({ adapterId: "file-users@1", role: "user", create: (rootPath) => new FileUserStore(rootPath) }),
    factory({ adapterId: "file-roles@1", role: "role", create: (rootPath) => new FileRoleStore(rootPath) }),
    factory({
      adapterId: "file-role-assignments@1",
      role: "role-assignment",
      create: (rootPath) => new FileRoleAssignmentStore(rootPath),
    }),
    factory({
      adapterId: "file-run-configurations@1",
      role: "run-configuration",
      create: (rootPath) => new FileRunConfigurationStore(rootPath),
    }),
    factory({
      adapterId: "file-agent-templates@1",
      role: "agent-template",
      create: (rootPath) => new FileAgentTemplateStore(rootPath),
    }),
    factory({
      adapterId: "file-workflow-run-configurations@1",
      role: "workflow-run-configuration",
      create: (rootPath) => new FileWorkflowRunConfigurationStore(rootPath),
    }),
    factory({
      adapterId: "file-agent-auth-providers@1",
      role: "agent-auth-provider",
      create: (rootPath) => new FileAgentAuthProviderStore(rootPath),
    }),
    factory({
      adapterId: "local-plaintext-agent-credentials@1",
      role: "agent-credential",
      create: (rootPath) => new FilePlaintextAgentCredentialStore(rootPath),
    }),
  ] as PlatformStoreAdapterFactory[];
}

export function createFilePlatformStoreAdapterRegistry(): PlatformStoreAdapterRegistry {
  return new DefaultPlatformStoreAdapterRegistry(createFilePlatformStoreAdapterFactories());
}
