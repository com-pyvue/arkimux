import type { ResolvedRunConfiguration } from "./runConfiguration.ts";
import type {
  RoleAssignmentReader,
  RoleReader,
  WorkflowRunConfigurationStore,
  WorkflowRunConfigurationDefinition,
  UserStore,
} from "./platformStore.ts";
import type { TrustedRunCommand } from "./trustedRunCommand.ts";
import { validateRunActor, type RunActor } from "../domain/runActor.ts";
import type { RunRef } from "../domain/runIdentity.ts";
import type { WorkflowIdentity } from "../domain/workflowIdentity.ts";

export interface RunDispatcher<TInput> {
  dispatch(command: TrustedRunCommand<TInput>): Promise<void>;
}

export interface RunReservationRequest<TInput, TConfiguration> {
  actor: RunActor;
  workflow: WorkflowIdentity;
  input: TInput;
  resolvedConfiguration: ResolvedRunConfiguration<TConfiguration>;
  requestedExecutionId?: string;
}

export interface SubmitRunRequest<TInput> {
  userId: string;
  roleId: string;
  input: TInput;
  runConfigurationId: string;
  requestedExecutionId?: string;
}

export interface RunSubmissionServiceDependencies<
  TInput,
  TConfiguration extends WorkflowRunConfigurationDefinition,
> {
  workflow: WorkflowIdentity;
  users: Pick<UserStore, "get">;
  roles: RoleReader;
  assignments: RoleAssignmentReader;
  runConfigurations: WorkflowRunConfigurationStore<TConfiguration>;
  configurationWorkflow(configuration: TConfiguration): WorkflowIdentity;
  reserve(request: RunReservationRequest<TInput, TConfiguration>): Promise<RunRef>;
  dispatcher: RunDispatcher<TInput>;
}

export class RunSubmissionService<
  TInput,
  TConfiguration extends WorkflowRunConfigurationDefinition,
> {
  constructor(private readonly dependencies: RunSubmissionServiceDependencies<TInput, TConfiguration>) {}

  async submit(request: SubmitRunRequest<TInput>): Promise<RunRef> {
    const actor = validateRunActor({ userId: request.userId, roleId: request.roleId });
    await this.authorize(actor);
    const resolvedConfiguration = await this.dependencies.runConfigurations.resolve(
      this.dependencies.workflow,
      request.runConfigurationId,
    );
    if (!resolvedConfiguration) {
      throw new Error(`Run configuration ${request.runConfigurationId} does not exist.`);
    }
    if (await this.dependencies.runConfigurations.lifecycleStatus(
      this.dependencies.workflow,
      request.runConfigurationId,
    ) !== "active") {
      throw new Error(`Run configuration ${request.runConfigurationId} is archived and cannot start new runs.`);
    }
    const configuredWorkflow = this.dependencies.configurationWorkflow(resolvedConfiguration.configuration);
    if (
      configuredWorkflow.kind !== this.dependencies.workflow.kind
      || configuredWorkflow.version !== this.dependencies.workflow.version
    ) {
      throw new Error(
        `Run configuration workflow must be ${this.dependencies.workflow.kind}@${this.dependencies.workflow.version}.`,
      );
    }
    const runRef = await this.dependencies.reserve({
      actor,
      workflow: this.dependencies.workflow,
      input: request.input,
      resolvedConfiguration,
      ...(request.requestedExecutionId === undefined
        ? {}
        : { requestedExecutionId: request.requestedExecutionId }),
    });
    await this.dependencies.dispatcher.dispatch({
      runRef,
      actor,
      workflow: this.dependencies.workflow,
      input: request.input,
      runConfiguration: {
        configurationId: resolvedConfiguration.configuration.configurationId,
        contentHash: resolvedConfiguration.contentHash,
      },
    });
    return runRef;
  }

  private async authorize(actor: RunActor): Promise<void> {
    const user = await this.dependencies.users.get(actor.userId);
    if (!user) throw new Error(`User ${actor.userId} does not exist.`);
    if (user.status !== "active") throw new Error(`User ${actor.userId} is disabled.`);
    const role = await this.dependencies.roles.get(actor.roleId);
    if (!role) throw new Error(`Role ${actor.roleId} does not exist.`);
    if (!await this.dependencies.assignments.isAssigned(actor.userId, actor.roleId)) {
      throw new Error(`Role ${actor.roleId} is not assigned to user ${actor.userId}.`);
    }
    const permission = `workflow:${this.dependencies.workflow.kind}:start`;
    if (!role.permissions.includes(permission)) {
      throw new Error(`Role ${actor.roleId} does not grant ${permission}.`);
    }
  }
}

export class DirectRunDispatcher<TInput> implements RunDispatcher<TInput> {
  constructor(private readonly execute: (command: TrustedRunCommand<TInput>) => Promise<void>) {}

  async dispatch(command: TrustedRunCommand<TInput>): Promise<void> {
    await this.execute(command);
  }
}
