import type { RunRef } from "@com-pyvue/agent-execution-core/internal/domain/runIdentity.ts";
import type { InputSubmissionDto, InputRequestsResponseDto, InputSubmissionResponseDto, InputUploadResponseDto } from "@com-pyvue/agent-execution-run-contract";

export interface InputUploadDto {
  fieldId: string;
  uploadId: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}

/** Optional server-owned capability; no Local storage dependency in the Run API. */
export interface RunInputRequests {
  list(ref: RunRef): Promise<InputRequestsResponseDto>;
  upload(ref: RunRef, requestId: string, body: InputUploadDto): Promise<InputUploadResponseDto>;
  submit(ref: RunRef, requestId: string, body: InputSubmissionDto, responderId: string): Promise<InputSubmissionResponseDto>;
}
export class RunInputRequestError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 503, readonly code: string, message: string,
    readonly details?: { reason?: string; fieldErrors?: { field: string; message: string }[] }) { super(message); }
}
