/** Internal API adapter. Run execution and lifecycle live in the orchestrator. */
import type { CodedWorkflowRegistration, CodedWorkflowReservationRequest } from "../../apps/packages/run/api/src/workflowRegistry.ts";
import { ApplicationBoundaryError } from "../../apps/packages/application-host/src/authorization.ts";
import { RunInputRequestError, type RunInputRequests } from "../../apps/packages/run/api/src/inputRequests.ts";
import { inputRequestsResponseSchema, inputSubmissionResponseSchema, inputUploadResponseSchema } from "../../apps/packages/run/contract/src/inputRequests.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { InputControlConflict } from "../../core/src/application/retainedExecution.ts";
import { RunReservationAlreadyExistsError } from "../../core/src/infrastructure/storage/fileRunStateStore.ts";
import { InputFileUploadValidationError } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { RetainedRunAdmissionError } from "./localRetainedRunAdmission.ts";
import { LocalRetainedRunOrchestrator, RetainedInputError, type PreparedRetainedBinding } from "./localRetainedRunOrchestrator.ts";
import type { RunRef } from "../../core/src/domain/runIdentity.ts";

export { projectRetainedRunStatus } from "./localRetainedRunOrchestrator.ts";

/** Kept as the existing server/test adapter; not a second execution service. */
export class LocalRetainedRunService {
  readonly application: LocalRetainedRunOrchestrator;
  readonly options: LocalRetainedRunOrchestrator["options"];
  constructor(options: LocalRetainedRunOrchestrator["options"], application?: LocalRetainedRunOrchestrator) {
    if (application && application.options !== options) throw new Error("API adapter must use its orchestrator's options.");
    this.options = options;
    this.application = application ?? new LocalRetainedRunOrchestrator(options);
  }

  readonly inputRequests: RunInputRequests = {
    list: async ref => inputRequestsResponseSchema.parse({
      schemaVersion: 1, runRef: ref, items: await this.application.listInputRequests(ref),
    }),
    upload: async (ref, requestId, body) => {
      try {
        const receipt = await this.application.uploadInputFile(ref, requestId, body);
        return inputUploadResponseSchema.parse({ schemaVersion: 1, runRef: ref, ...receipt });
      } catch (error) {
        if (error instanceof InputControlConflict) throw new RunInputRequestError(error.code === "not-found" ? 404 : 409,
          error.code === "not-found" ? "not-found" : "conflict", "The input request cannot accept this upload.", { reason: error.code });
        if (error instanceof InputFileUploadValidationError) {
          let status: 413 | 415 | 422 = 422;
          if (error.code === "unsupported-media-type") status = 415;
          else if (["file-too-large", "request-size-exceeded"].includes(error.code)) status = 413;
          throw new RunInputRequestError(status, error.code, error.message, { fieldErrors: [{ field: error.field, message: error.message }] });
        }
        throw new RunInputRequestError(503, "upload-unavailable", "The file could not be retained. Retry with the same upload ID.");
      }
    },
    submit: async (ref, requestId, body, responderId) => {
      try {
        const receipt = await this.application.submitInput(ref, requestId, body, responderId);
        try { return inputSubmissionResponseSchema.parse("kind" in receipt
          ? { schemaVersion: 1, runRef: ref, kind: "graph-entry", accepted: receipt.accepted }
          : { schemaVersion: 1, runRef: ref, receipt }); }
        catch { throw new RetainedInputError("input-unavailable", "The input request could not be processed. Retry with the same submission ID."); }
      } catch (error) {
        if (error instanceof InputControlConflict) throw new RunInputRequestError(error.code === "not-found" ? 404 : 409,
          error.code === "not-found" ? "not-found" : "conflict", "The input request cannot accept this submission.", { reason: error.code });
        if (error instanceof RetainedInputError) throw new RunInputRequestError(
          error.code === "invalid-response" ? 422 : 503, error.code, error.message,
          error.fieldErrors ? { fieldErrors: error.fieldErrors } : undefined);
        throw error;
      }
    },
  };

  /** The normal Run API still owns authorization, configuration and readiness. */
  registration(options: Omit<CodedWorkflowRegistration, "reserve" | "execute" | "validateInput"> & {
    prepareBinding(request: CodedWorkflowReservationRequest): Promise<PreparedRetainedBinding>;
  }): CodedWorkflowRegistration {
    const { prepareBinding, ...metadata } = options;
    return { ...metadata, validateInput: inputWaitJsonSnapshot,
      reserve: async request => {
        try {
          return await this.application.reserve(request, {
            workflow: metadata.workflow, agentSlotIds: (metadata.agentSlots ?? []).map(slot => slot.slotId), prepareBinding,
          });
        } catch (error) {
          if (error instanceof RunReservationAlreadyExistsError) throw new ApplicationBoundaryError("conflict", 409, "This Run ID is already reserved. Choose a new Run ID.");
          if (error instanceof RetainedRunAdmissionError) throw new ApplicationBoundaryError("invalid-request", error.code === "invalid-input" ? 400 : 409, error.message);
          throw error;
        }
      },
      cancel: ref => this.application.cancel(ref),
      execute: command => this.application.dispatch(command),
    };
  }

  execute(ref: RunRef): Promise<void> { return this.application.execute(ref); }
  refresh(ref: RunRef): Promise<void> { return this.application.refresh(ref); }
  recover(): Promise<void> { return this.application.recover(); }
  close(): Promise<void> { return this.application.close(); }
}
