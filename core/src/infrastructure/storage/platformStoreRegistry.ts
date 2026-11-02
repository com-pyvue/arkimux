import type {
  PlatformStoreAdapterFactory,
  PlatformStoreAdapterRegistry,
  PlatformStorePortByRole,
  PlatformStoreRole,
  PlatformStoreAdapterContext,
} from "../../application/platformStore.ts";
import { DefaultStoreAdapterRegistry } from "./storeAdapterRegistry.ts";

const roles = [
  "user",
  "role",
  "role-assignment",
  "run-configuration",
  "agent-template",
  "workflow-run-configuration",
  "agent-auth-provider",
  "agent-credential",
  "organization",
  "environment",
  "workflow-release",
  "workflow-deployment",
  "deployment-health",
  "meter-record",
  "run-projection",
] as const satisfies readonly PlatformStoreRole[];

export class DefaultPlatformStoreAdapterRegistry
  extends DefaultStoreAdapterRegistry<
    PlatformStoreRole,
    PlatformStorePortByRole,
    PlatformStoreAdapterContext
  > implements PlatformStoreAdapterRegistry {
  constructor(factories: PlatformStoreAdapterFactory[]) {
    super({ roles, factories });
  }
}
