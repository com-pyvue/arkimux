import type { ResolvedRunConfiguration } from "./runConfiguration.ts";
import type {
  AgentTemplateDefinition,
  ResolvedAgentTemplate,
} from "./agentTemplate.ts";
import type { StoreAdapterFactory, StoreAdapterRegistry } from "./storeAdapter.ts";
import type { Role } from "../domain/role.ts";
import type { ExternalIdentity, User, UserStatus } from "../domain/user.ts";
import type {
  DeploymentHealthStore,
  EnvironmentStore,
  MeterRecordStore,
  OrganizationStore,
  WorkflowDeploymentStore,
  WorkflowReleaseStore,
} from "./deploymentLifecycle.ts";
import type { PlatformRunProjectionStore } from "./platformRunProjection.ts";
import type { WorkflowIdentity } from "../domain/workflowIdentity.ts";
import type {
  AgentAuthProviderStore,
  AgentCredentialStore,
} from "./agentAuthentication.ts";

export interface NewUser {
  userId: string;
  displayName?: string;
  identity: ExternalIdentity;
  registeredAt: string;
}

export interface PageQuery {
  pageSize?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface UserListQuery extends PageQuery {
  status?: UserStatus;
}

export interface UserStore {
  register(user: NewUser): Promise<User>;
  get(userId: string): Promise<User | undefined>;
  findByIdentity(providerId: string, subjectId: string): Promise<User | undefined>;
  setStatus(userId: string, status: UserStatus): Promise<void>;
  list(query?: UserListQuery): Promise<Page<User>>;
}

export interface RoleReader {
  get(roleId: string): Promise<Role | undefined>;
  list(query?: PageQuery): Promise<Page<Role>>;
}

export interface RoleStore extends RoleReader {
  create(role: Role): Promise<void>;
}

export interface RoleAssignmentReader {
  isAssigned(userId: string, roleId: string): Promise<boolean>;
  list(query?: RoleAssignmentListQuery): Promise<Page<RoleAssignment>>;
}

export interface RoleAssignment {
  userId: string;
  roleId: string;
}

export interface RoleAssignmentListQuery extends PageQuery {
  userId?: string;
  roleId?: string;
}

export interface RoleAssignmentStore extends RoleAssignmentReader {
  assign(userId: string, roleId: string): Promise<void>;
  revoke(userId: string, roleId: string): Promise<void>;
}

export type RunConfigurationLifecycleStatus = "active" | "archived";

export interface RunConfigurationListQuery extends PageQuery {
  lifecycleStatus?: RunConfigurationLifecycleStatus | "all";
}

export interface RunConfigurationStore<TConfiguration extends { configurationId: string } = { configurationId: string }> {
  publish(configuration: TConfiguration): Promise<ResolvedRunConfiguration<TConfiguration>>;
  resolve(configurationId: string): Promise<ResolvedRunConfiguration<TConfiguration> | undefined>;
  lifecycleStatus(configurationId: string): Promise<RunConfigurationLifecycleStatus | undefined>;
  archive(configurationId: string): Promise<void>;
  restore(configurationId: string): Promise<void>;
  list(query?: RunConfigurationListQuery): Promise<Page<ResolvedRunConfiguration<TConfiguration>>>;
}

export type AgentTemplateLifecycleStatus = "active" | "archived";

export interface AgentTemplateListQuery extends PageQuery {
  lifecycleStatus?: AgentTemplateLifecycleStatus | "all";
}

export interface AgentTemplateStore<
  TTemplate extends AgentTemplateDefinition = AgentTemplateDefinition,
> {
  publish(template: TTemplate): Promise<ResolvedAgentTemplate<TTemplate>>;
  resolve(templateId: string): Promise<ResolvedAgentTemplate<TTemplate> | undefined>;
  lifecycleStatus(templateId: string): Promise<AgentTemplateLifecycleStatus | undefined>;
  archive(templateId: string, options?: { allowPlatformTemplate?: boolean }): Promise<void>;
  restore(templateId: string): Promise<void>;
  list(query?: AgentTemplateListQuery): Promise<Page<ResolvedAgentTemplate<TTemplate>>>;
}

export interface WorkflowRunConfigurationDefinition {
  configurationId: string;
  workflow: WorkflowIdentity;
}

export interface WorkflowRunConfigurationStore<
  TConfiguration extends WorkflowRunConfigurationDefinition = WorkflowRunConfigurationDefinition,
> {
  publish(configuration: TConfiguration): Promise<ResolvedRunConfiguration<TConfiguration>>;
  resolve(
    workflow: WorkflowIdentity,
    configurationId: string,
  ): Promise<ResolvedRunConfiguration<TConfiguration> | undefined>;
  lifecycleStatus(
    workflow: WorkflowIdentity,
    configurationId: string,
  ): Promise<RunConfigurationLifecycleStatus | undefined>;
  archive(workflow: WorkflowIdentity, configurationId: string): Promise<void>;
  restore(workflow: WorkflowIdentity, configurationId: string): Promise<void>;
  list(
    workflow: WorkflowIdentity,
    query?: RunConfigurationListQuery,
  ): Promise<Page<ResolvedRunConfiguration<TConfiguration>>>;
}

export type PlatformStoreRole =
  | "user"
  | "role"
  | "role-assignment"
  | "run-configuration"
  | "agent-template"
  | "workflow-run-configuration"
  | "agent-auth-provider"
  | "agent-credential"
  | "organization"
  | "environment"
  | "workflow-release"
  | "workflow-deployment"
  | "deployment-health"
  | "meter-record"
  | "run-projection";

export interface PlatformStorePortByRole {
  user: UserStore;
  role: RoleStore;
  "role-assignment": RoleAssignmentStore;
  "run-configuration": RunConfigurationStore;
  "agent-template": AgentTemplateStore;
  "workflow-run-configuration": WorkflowRunConfigurationStore;
  "agent-auth-provider": AgentAuthProviderStore;
  "agent-credential": AgentCredentialStore;
  organization: OrganizationStore;
  environment: EnvironmentStore;
  "workflow-release": WorkflowReleaseStore;
  "workflow-deployment": WorkflowDeploymentStore;
  "deployment-health": DeploymentHealthStore;
  "meter-record": MeterRecordStore;
  "run-projection": PlatformRunProjectionStore;
}

export interface PlatformStoreAdapterContext {
  options: Record<string, unknown>;
  configurationRoot?: string;
  repositoryRoot?: string;
}

export type PlatformStoreAdapterFactory<TStore = unknown> = StoreAdapterFactory<
  PlatformStoreRole,
  TStore,
  PlatformStoreAdapterContext
>;

export type PlatformStoreAdapterRegistry = StoreAdapterRegistry<
  PlatformStoreRole,
  PlatformStorePortByRole,
  PlatformStoreAdapterContext
>;
