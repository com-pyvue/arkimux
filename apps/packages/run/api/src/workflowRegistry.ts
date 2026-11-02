import type {
  AgentProviderReadinessDto,
  AgentSlotDto,
  JsonValue,
  WorkflowPreflightResponseDto,
  WorkflowInvocationOptionsResponseDto,
} from "@com-pyvue/agent-execution-run-contract";

type JsonObject = { [key: string]: JsonValue };
import {
  validateTrustedRunCommand,
  validateWorkflowIdentity,
  type ResolvedRunConfiguration,
  type RunActor,
  type RunRef,
  type TrustedRunCommand,
  type WorkflowIdentity,
} from "@com-pyvue/agent-execution-core";
import type { WorkflowExecutorRegistry } from "@com-pyvue/agent-execution-application-host";

export interface GenericRunConfiguration {
  configurationId: string;
  workflow: WorkflowIdentity;
  [key: string]: unknown;
}

export interface CodedWorkflowReservationRequest<TInput = unknown> {
  actor: RunActor;
  workflow: WorkflowIdentity;
  input: TInput;
  resolvedConfiguration: ResolvedRunConfiguration<GenericRunConfiguration>;
  requestedExecutionId?: string;
}

export interface CodedWorkflowPreflightRequest {
  actor: RunActor;
  workflow: WorkflowIdentity;
  resolvedConfiguration: ResolvedRunConfiguration<GenericRunConfiguration>;
}

export interface CodedWorkflowPreflightResult extends WorkflowPreflightResponseDto {
  agents: AgentProviderReadinessDto[];
}

export interface CodedWorkflowRegistration<TInput = unknown> {
  workflow: WorkflowIdentity;
  /** Legacy workflow input remains the default. Graph workflows use the
   * retained entry-boundary request contract. */
  invocationModel?: "workflow-input" | "graph-entry";
  title?: string;
  description?: string;
  inputExample?: JsonValue;
  agentSlots?: readonly AgentSlotDto[];
  /** Workflow-owned non-agent defaults copied into each new run configuration draft. */
  runConfigurationBase?: JsonObject;
  validateInput(input: JsonValue): TInput;
  preflight?(request: CodedWorkflowPreflightRequest): Promise<CodedWorkflowPreflightResult>;
  describeInvocation?(request: CodedWorkflowPreflightRequest): Promise<WorkflowInvocationOptionsResponseDto>;
  reserve(request: CodedWorkflowReservationRequest<TInput>): Promise<RunRef>;
  /** Cancel the retained Run and wait until its public status is updated. */
  cancel?(runRef: RunRef): Promise<void>;
  execute(command: TrustedRunCommand<TInput>): Promise<void>;
}

export class DuplicateCodedWorkflowError extends Error {
  constructor(readonly key: string) {
    super(`Coded workflow is registered more than once: ${key}`);
    this.name = "DuplicateCodedWorkflowError";
  }
}

export class UnknownCodedWorkflowError extends Error {
  constructor(readonly key: string) {
    super(`Coded workflow is not registered: ${key}`);
    this.name = "UnknownCodedWorkflowError";
  }
}

export class CodedWorkflowRegistry implements WorkflowExecutorRegistry {
  readonly #registrations = new Map<string, CodedWorkflowRegistration>();

  constructor(registrations: readonly CodedWorkflowRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: CodedWorkflowRegistration): void {
    const workflow = validateWorkflowIdentity(registration.workflow);
    const key = workflowKey(workflow);
    if (this.#registrations.has(key)) throw new DuplicateCodedWorkflowError(key);
    const slotIds = (registration.agentSlots ?? []).map(({ slotId }) => slotId);
    if (new Set(slotIds).size !== slotIds.length) {
      throw new Error(`Coded workflow ${key} contains duplicate agent slot IDs.`);
    }
    this.#registrations.set(key, registration);
  }

  resolve(workflow: WorkflowIdentity): CodedWorkflowRegistration {
    const key = workflowKey(validateWorkflowIdentity(workflow));
    const registration = this.#registrations.get(key);
    if (!registration) throw new UnknownCodedWorkflowError(key);
    return registration;
  }

  list(): CodedWorkflowRegistration[] {
    return [...this.#registrations.values()]
      .sort((left, right) => workflowKey(left.workflow).localeCompare(workflowKey(right.workflow)));
  }

  async execute(value: TrustedRunCommand<unknown>): Promise<void> {
    const command = validateTrustedRunCommand(value, (input) => input);
    const registration = this.resolve(command.workflow);
    const input = registration.validateInput(command.input as JsonValue);
    await registration.execute({ ...command, input });
  }
}

export function workflowKey(workflow: WorkflowIdentity): string {
  return `${workflow.kind}@${workflow.version}`;
}
