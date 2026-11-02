import type {
  ResolvedRunConfiguration,
  RunActor,
  RunRef,
  TrustedRunCommand,
  WorkflowIdentity,
  AgentAuthProviderRegistry,
  ResolvedAgentProviderConfig,
} from "@com-pyvue/agent-execution-core";
import type { AgentSlotDto, JsonValue } from "@com-pyvue/agent-execution-run-contract";
import type { WorkflowPreflightResponseDto } from "@com-pyvue/agent-execution-run-contract";

type JsonObject = { [key: string]: JsonValue };
import type { DeepReadonly, ValueValidatorV1, WorkflowExecutionContextV1 } from "@com-pyvue/agent-execution-core";

export interface PortableWorkflowDefinition<Input extends JsonValue, Output extends JsonValue> {
  workflow: WorkflowIdentity;
  workflowContractVersion: string;
  resultKind: string;
  input: ValueValidatorV1<Input>;
  output: ValueValidatorV1<Output>;
  execute(context: WorkflowExecutionContextV1, input: DeepReadonly<Input>): Promise<Output>;
}

export interface LocalPortableWorkflowOptions<Input extends JsonValue, Output extends JsonValue> {
  repositoryRoot: string;
  workflow: WorkflowIdentity;
  title: string;
  description: string;
  inputExample: Input;
  input: ValueValidatorV1<Input>;
  environment: WorkflowEnvironmentDeclaration;
  /** Called once at server startup without environment or credential authority. */
  define(): PortableWorkflowDefinition<Input, Output>;
  agentSlots: readonly { slotId: string; title: string; description: string; prompt: string }[];
  maxDurationMs: number;
  finalizationReserveMs: number;
  manifest?: import("@com-pyvue/agent-execution-core").WorkflowManifestV1;
  environmentFile?: string;
  resultSchemaVersion?: number;
}
export function createLocalPortableWorkflow<Input extends JsonValue, Output extends JsonValue>(options: LocalPortableWorkflowOptions<Input, Output>): Promise<LocalWorkflowRegistration<Input>>;
export interface LocalGraphWorkflowOptions<Input extends JsonValue, Output extends JsonValue> extends Omit<LocalPortableWorkflowOptions<Input, Output>, "define"> {
  workflowContractVersion: string;
  resultKind: string;
  output: ValueValidatorV1<Output>;
}
export function createLocalGraphWorkflow<Input extends JsonValue, Output extends JsonValue>(options: LocalGraphWorkflowOptions<Input, Output>): Promise<LocalWorkflowRegistration<Input>>;

export interface LocalWorkflowDeclarationBinding<T = unknown> {
  manifest: import("@com-pyvue/agent-execution-core").WorkflowManifestV1;
  result: { kind: string; schemaVersion: number };
  inputValidator: { parse(value: unknown): T };
  resultValidator: { parse(value: unknown): unknown };
  environment: { file: string; declaration: WorkflowEnvironmentDeclaration };
}
export function withLocalWorkflowDeclaration<T>(registration: LocalWorkflowRegistration<T>, binding: LocalWorkflowDeclarationBinding<T>): LocalWorkflowRegistration<T>;
export function assertLocalWorkflowDeclarations(options: {
  repositoryRoot: string; declarations: readonly unknown[]; workflows: readonly LocalWorkflowRegistration[];
}): Promise<void>;
export function assertLocalRendererDeclarations(declarations: readonly unknown[], views: readonly LocalResultView[]): void;

export interface WorkflowEnvironmentVariableDeclaration {
  name: string;
  required: boolean;
  secret: boolean;
  type: "string" | "url";
}

export interface WorkflowEnvironmentDeclaration {
  schemaVersion: 1;
  variables: readonly WorkflowEnvironmentVariableDeclaration[];
}

export type ResolvedWorkflowEnvironment = Readonly<Record<string, string>>;

export function validateWorkflowEnvironmentDeclaration(value: unknown): WorkflowEnvironmentDeclaration;
export function resolveWorkflowEnvironment(
  declaration: WorkflowEnvironmentDeclaration,
  values: Readonly<Record<string, string | undefined>>,
): ResolvedWorkflowEnvironment;
export function loadLocalWorkflowEnvironment(
  projectRoot: string,
  declaration: WorkflowEnvironmentDeclaration,
): Promise<ResolvedWorkflowEnvironment>;

export interface GenericRunConfiguration {
  configurationId: string;
  workflow: WorkflowIdentity;
}

export interface LocalWorkflowRegistration<TInput = unknown> {
  workflow: WorkflowIdentity;
  invocationModel?: "workflow-input" | "graph-entry";
  title?: string;
  description?: string;
  agentSlots?: readonly AgentSlotDto[];
  runConfigurationBase?: JsonObject;
  inputExample?: JsonValue;
  validateInput(input: JsonValue): TInput;
  preflight?(request: {
    actor: RunActor;
    workflow: WorkflowIdentity;
    resolvedConfiguration: ResolvedRunConfiguration<GenericRunConfiguration>;
  }): Promise<WorkflowPreflightResponseDto>;
  reserve(request: {
    actor: RunActor;
    workflow: WorkflowIdentity;
    input: TInput;
    resolvedConfiguration: ResolvedRunConfiguration<GenericRunConfiguration>;
    requestedExecutionId?: string;
  }): Promise<RunRef>;
  execute(command: TrustedRunCommand<TInput>): Promise<void>;
  runConfigurationValidator: {
    workflow: WorkflowIdentity;
    validate(value: unknown, expectedConfigurationId?: string): GenericRunConfiguration;
  };
}

export interface StartLocalWorkflowDevelopmentServerOptions {
  repositoryRoot: string;
  subjectId: string;
  workflows: readonly LocalWorkflowRegistration[];
  resultViews?: readonly LocalResultView[];
  resultViewSource?: LocalResultViewSource;
  hostname?: string;
  port?: number;
  environment?: NodeJS.ProcessEnv;
  onBackgroundError?(error: Error): void;
}

export interface LocalResultView {
  resultKind: string;
  payloadSchemaVersion: number;
  render(payload: unknown): string | Promise<string>;
}
export interface LocalResultViewSource {
  snapshot(): { revision: number; status: "ready" | "unavailable" | "error"; views: readonly LocalResultView[] };
  close(): Promise<void>;
}

export interface LocalFileStorePaths {
  root: string;
  configuration: string;
  /** @deprecated Use configuration. */
  platform: string;
  runs: string;
  deployments: string;
  reservations: string;
  agentAuthProviders: string;
  credentials: string;
  processes: string;
  privacy: string;
  diagnostics: string;
  legacyBackup: string;
}

export function resolveLocalFileStorePaths(repositoryRoot: string): LocalFileStorePaths;

export function createLocalAgentAuthProviderRegistry(options: {
  repositoryRoot: string;
  providerConfig: ResolvedAgentProviderConfig;
  environment?: NodeJS.ProcessEnv;
}): Promise<AgentAuthProviderRegistry>;

export function startLocalWorkflowDevelopmentServer(
  options: StartLocalWorkflowDevelopmentServerOptions,
): Promise<{ server: { close(callback?: (error?: Error) => void): void }; url: string }>;
