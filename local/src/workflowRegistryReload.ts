/** Private Local composition. No HTTP or workflow SDK dependency. */
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { CodedWorkflowRegistry } from "../../apps/packages/run/api/src/workflowRegistry.ts";
import { RunConfigurationDefinitionValidatorRegistry } from "../../apps/packages/run-configuration/api/src/validatorRegistry.ts";
import type { LocalWorkflowRegistration } from "./index.ts";

export interface WorkflowRegistrySourceDiagnostic {
  kind: "source";
  code: string;
  message: string;
  file: string;
  line?: number;
  column?: number;
}
export interface WorkflowRegistryStatus {
  revision: number;
  status: "ready" | "validating" | "waiting" | "error";
  message?: string;
  restartRequired?: boolean;
  diagnostic?: WorkflowRegistrySourceDiagnostic;
}

function copySourceDiagnostic(value: unknown): WorkflowRegistrySourceDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  try {
    const { kind, code, message, file, line, column } = value as Record<string, unknown>;
    if (kind !== "source" || typeof code !== "string" || code.length < 1 || code.length > 64
      || typeof message !== "string" || message.length < 1 || message.length > 1000
      || /[\u0000-\u001f\u007f-\u009f]/u.test(code) || /[\u0000-\u001f\u007f-\u009f]/u.test(message)
      || typeof file !== "string" || file.length < 1 || file.length > 512
      || !/^(src|workflows)\//.test(file) || /[\\\u0000-\u001f\u007f-\u009f]/u.test(file)
      || file.split("/").some(part => !part || part === "." || part === "..")) return;
    if (line === undefined && column === undefined) return { kind, code, message, file };
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1
      || typeof column !== "number" || !Number.isSafeInteger(column) || column < 1) return;
    return { kind, code, message, file, line, column };
  } catch { return; }
}
export interface PreparedLocalRegistry {
  workflows: readonly LocalWorkflowRegistration[];
  release(): Promise<void>;
  validate?(): Promise<void>;
}
interface Generation extends PreparedLocalRegistry {
  registry: CodedWorkflowRegistry;
  validators: RunConfigurationDefinitionValidatorRegistry;
}
export class LocalRegistryUnavailable extends Error {}

/** One selected generation for catalog, validation, reservation and dispatch. */
export class LocalWorkflowRegistryReload {
  readonly #scope = new AsyncLocalStorage<Generation>();
  #current?: Generation;
  #requests = 0;
  #executions = 0;
  #gated = false;
  #closed = false;
  #fault = false;
  #state: WorkflowRegistryStatus = { revision: 0, status: "validating" };
  #activation: Promise<unknown> = Promise.resolve();
  readonly workflows: CodedWorkflowRegistry;
  readonly validators: RunConfigurationDefinitionValidatorRegistry;

  constructor(private readonly options: {
    isIdle(): boolean;
    reconcile(workflows: readonly LocalWorkflowRegistration[]): Promise<unknown>;
  }) {
    const owner = this;
    this.workflows = new class extends CodedWorkflowRegistry {
      override register(): never { throw new Error("Local registrations must be replaced as a complete candidate."); }
      override resolve(workflow: Parameters<CodedWorkflowRegistry["resolve"]>[0]) { return owner.#selected().registry.resolve(workflow); }
      override list() { return owner.#selected().registry.list(); }
      override async execute(command: Parameters<CodedWorkflowRegistry["execute"]>[0]) {
        const selected = owner.#selected();
        owner.#executions++;
        try { await selected.registry.execute(command); }
        finally { owner.#executions--; }
      }
    }();
    this.validators = new class extends RunConfigurationDefinitionValidatorRegistry {
      override register(): never { throw new Error("Local validators must be replaced as a complete candidate."); }
      override validate(value: unknown, id?: string) { return owner.#selected().validators.validate(value, id); }
    }();
  }

  #selected(): Generation {
    const selected = this.#scope.getStore() ?? this.#current;
    if (!selected) throw new LocalRegistryUnavailable("The workflow registry is not ready.");
    return selected;
  }
  status(): WorkflowRegistryStatus {
    const status = { ...this.#state };
    if (status.diagnostic) status.diagnostic = { ...status.diagnostic };
    return status;
  }
  validating(): void {
    if (!this.#closed && !this.#fault) this.#state = { revision: this.#state.revision, status: "validating" };
  }
  failed(restartRequired = false, diagnostic?: WorkflowRegistrySourceDiagnostic): void {
    if (this.#closed || this.#fault) return;
    const sourceDiagnostic = restartRequired ? undefined : copySourceDiagnostic(diagnostic);
    this.#state = { revision: this.#state.revision, status: "error", restartRequired,
      message: restartRequired
        ? "Project settings or existing workflow files changed. Restart the Local server to load them. Previous workflows remain available."
        : "Workflow reload failed. Previous workflows remain available. Run npm run validate, fix the registry, and save it again.",
      ...(sourceDiagnostic ? { diagnostic: sourceDiagnostic } : {}) };
  }

  /** The outer Local request wrapper precedes authentication and all API routers. */
  async withRequest<T>(operation: () => Promise<T>): Promise<T> {
    while (this.#gated && !this.#closed && !this.#fault) await delay(10);
    if (this.#closed || this.#fault) throw new LocalRegistryUnavailable("The Local server must be restarted before handling requests.");
    const selected = this.#selected();
    this.#requests++;
    try { return await this.#scope.run(selected, operation); }
    finally { this.#requests--; }
  }

  prepareCandidate(prepared: PreparedLocalRegistry): Generation {
    for (const registration of prepared.workflows) {
      const validator = registration.runConfigurationValidator.workflow;
      if (validator.kind !== registration.workflow.kind || validator.version !== registration.workflow.version) {
        throw new Error("Workflow and Run Configuration validator identities differ.");
      }
    }
    return { ...prepared, registry: new CodedWorkflowRegistry(prepared.workflows),
      validators: new RunConfigurationDefinitionValidatorRegistry(prepared.workflows.map(w => w.runConfigurationValidator)) };
  }

  /** Ownership transfers to this controller, including rejected/superseded candidates. */
  activateCandidate(candidate: Generation, isCurrent: () => boolean = () => true): Promise<boolean> {
    const work = this.#activation.catch(() => {}).then(async () => {
      let published = false;
      let permissionsChanged = false;
      try {
        while (!this.#closed && !this.#fault && isCurrent()) {
          if (this.#requests || this.#executions || !this.options.isIdle()) {
            this.#state = { revision: this.#state.revision, status: "waiting", message: "Workflow reload is waiting for active work to finish." };
            await delay(10);
            continue;
          }
          // No await between the idle check and the gate. Existing requests have
          // drained, and new input responses/admissions cannot race reconciliation.
          this.#gated = true;
          await candidate.validate?.();
          try { await this.options.reconcile(candidate.workflows); }
          catch (error) {
            if ((error as { restartRequired?: boolean })?.restartRequired) {
              this.#fault = true;
              this.#state = { revision: this.#state.revision, status: "error", restartRequired: true,
                message: "Workflow permissions could not be restored. Restart the Local server before continuing." };
            } else this.failed();
            throw error;
          }
          permissionsChanged = true;
          await candidate.validate?.();
          // A save during reconciliation must not leave candidate permissions
          // paired with the old registry. Roll back before releasing the gate.
          if (this.#closed || !isCurrent()) {
            return false;
          }
          const previous = this.#current;
          this.#current = candidate;
          published = true;
          this.#state = { revision: this.#state.revision + 1, status: "ready" };
          await previous?.release();
          return true;
        }
        return false;
      } catch (error) {
        // A rollback/release failure cannot be advertised as a healthy last-good state.
        if (this.#gated && !this.#fault && published) {
          this.#fault = true;
          this.#state = { revision: this.#state.revision, status: "error", restartRequired: true,
            message: "Workflow reload could not finish safely. Restart the Local server before continuing." };
        }
        throw error;
      } finally {
        try {
          if (permissionsChanged && !published && this.#current) {
            try { await this.options.reconcile(this.#current.workflows); }
            catch {
              this.#fault = true;
              this.#state = { revision: this.#state.revision, status: "error", restartRequired: true,
                message: "Workflow permissions could not be restored. Restart the Local server before continuing." };
              throw new LocalRegistryUnavailable("Workflow permissions could not be restored.");
            }
          }
        } finally {
          this.#gated = false;
          if (!published) await candidate.release();
        }
      }
    });
    this.#activation = work;
    return work;
  }

  stop(): void { this.#closed = true; }
  /** Call after the host drains/cancels its requests and workers, before closing storage. */
  async close(): Promise<void> {
    this.stop();
    await this.#activation.catch(() => {});
    const current = this.#current;
    this.#current = undefined;
    await current?.release();
  }
}
