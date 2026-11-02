import type { z } from "zod";
import {
  apiErrorResponseSchema,
  artifactKeySchema,
  cancelRunRequestSchema,
  workflowListResponseSchema,
  publishedResultDtoSchema,
  publishedResultListResponseSchema,
  resolvedConfigurationResponseSchema,
  runArtifactContentResponseSchema,
  runArtifactsResponseSchema,
  runComparisonRequestSchema,
  runComparisonResponseSchema,
  runDetailResponseSchema,
  runFilterOptionsResponseSchema,
  runInputResponseSchema,
  runLifecycleResponseSchema,
  runListQuerySchema,
  runListResponseSchema,
  runPerformanceResponseSchema,
  submitRunRequestSchema,
  submitRunResponseSchema,
  workflowPreflightRequestSchema,
  workflowPreflightResponseSchema,
  type PublishedResultDto,
  type CancelRunRequestDto,
  type WorkflowListResponseDto,
  type PublishedResultListResponseDto,
  type ResolvedConfigurationResponseDto,
  type RunArtifactContentResponseDto,
  type RunArtifactsResponseDto,
  type RunComparisonRequestDto,
  type RunComparisonResponseDto,
  type RunDetailResponseDto,
  type RunFilterOptionsResponseDto,
  type RunInputResponseDto,
  type RunLifecycleResponseDto,
  type RunListQueryDto,
  type RunListResponseDto,
  type RunPerformanceResponseDto,
  type SubmitRunRequestDto,
  type SubmitRunResponseDto,
  type WorkflowPreflightRequestDto,
  type WorkflowPreflightResponseDto,
} from "./schemas.ts";
import {
  inputRequestIdSchema,
  inputRequestsResponseSchema,
  inputSubmissionResponseSchema,
  inputSubmissionSchema,
  inputUploadFieldsSchema,
  inputUploadResponseSchema,
  workflowInvocationOptionsRequestSchema,
  workflowInvocationOptionsResponseSchema,
  type InputRequestsResponseDto,
  type InputSubmissionDto,
  type InputSubmissionResponseDto,
  type InputUploadResponseDto,
  type WorkflowInvocationOptionsRequestDto,
  type WorkflowInvocationOptionsResponseDto,
} from "./inputRequests.ts";

export interface RunApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  requestInit?: () => RequestInit | Promise<RequestInit>;
}

export class RunApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RunApiError";
  }
}

export class RunApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestInit?: RunApiClientOptions["requestInit"];

  constructor(options: RunApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch
      ? (...args) => options.fetch!(...args)
      : globalThis.fetch.bind(globalThis);
    this.#requestInit = options.requestInit;
  }

  submitRun(request: SubmitRunRequestDto): Promise<SubmitRunResponseDto> {
    return this.#request("/api/v1/runs", submitRunResponseSchema, {
      method: "POST",
      body: JSON.stringify(submitRunRequestSchema.parse(request)),
    });
  }

  cancelRun(executionId: string, request: CancelRunRequestDto): Promise<RunLifecycleResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/cancel`, runLifecycleResponseSchema, {
      method: "POST",
      body: JSON.stringify(cancelRunRequestSchema.parse(request)),
    });
  }

  preflightWorkflow(request: WorkflowPreflightRequestDto): Promise<WorkflowPreflightResponseDto> {
    return this.#request("/api/v1/workflows/preflight", workflowPreflightResponseSchema, {
      method: "POST",
      body: JSON.stringify(workflowPreflightRequestSchema.parse(request)),
    });
  }

  listWorkflows(): Promise<WorkflowListResponseDto> {
    return this.#request("/api/v1/workflows", workflowListResponseSchema);
  }

  getWorkflowInvocationOptions(request: WorkflowInvocationOptionsRequestDto): Promise<WorkflowInvocationOptionsResponseDto> {
    return this.#request("/api/v1/workflows/invocation-options", workflowInvocationOptionsResponseSchema, {
      method: "POST",
      body: JSON.stringify(workflowInvocationOptionsRequestSchema.parse(request)),
    });
  }

  listRuns(query: RunListQueryDto = {}): Promise<RunListResponseDto> {
    const parsed = runListQuerySchema.parse(query);
    return this.#request(`/api/v1/runs${runListQueryString(parsed)}`, runListResponseSchema);
  }

  getRun(executionId: string): Promise<RunDetailResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}`, runDetailResponseSchema);
  }

  listInputRequests(executionId: string): Promise<InputRequestsResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/input-requests`, inputRequestsResponseSchema);
  }

  submitInputResponse(executionId: string, requestId: string, request: InputSubmissionDto): Promise<InputSubmissionResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/input-requests/${encodeURIComponent(inputRequestIdSchema.parse(requestId))}/response`, inputSubmissionResponseSchema, {
      method: "POST",
      body: JSON.stringify(inputSubmissionSchema.parse(request)),
    });
  }

  uploadInputFile(executionId: string, requestId: string, input: {
    fieldId: string;
    uploadId: string;
    file: Blob;
    filename: string;
  }): Promise<InputUploadResponseDto> {
    const fields = inputUploadFieldsSchema.parse({ fieldId: input.fieldId, uploadId: input.uploadId });
    const body = new FormData();
    body.set("fieldId", fields.fieldId);
    body.set("uploadId", fields.uploadId);
    body.set("file", input.file, input.filename);
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/input-requests/${encodeURIComponent(inputRequestIdSchema.parse(requestId))}/uploads`, inputUploadResponseSchema, {
      method: "POST",
      body,
    });
  }

  getRunFilterOptions(): Promise<RunFilterOptionsResponseDto> {
    return this.#request("/api/v1/runs/filter-options", runFilterOptionsResponseSchema);
  }

  archiveRun(executionId: string): Promise<RunLifecycleResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/archive`, runLifecycleResponseSchema, {
      method: "POST",
    });
  }

  restoreRun(executionId: string): Promise<RunLifecycleResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/restore`, runLifecycleResponseSchema, {
      method: "POST",
    });
  }

  listArtifacts(executionId: string): Promise<RunArtifactsResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/artifacts`, runArtifactsResponseSchema);
  }

  getArtifactContent(executionId: string, key: string): Promise<RunArtifactContentResponseDto> {
    const parsedKey = artifactKeySchema.parse(key);
    const query = new URLSearchParams({ key: parsedKey });
    return this.#request(
      `/api/v1/runs/${encodeURIComponent(executionId)}/artifact-content?${query}`,
      runArtifactContentResponseSchema,
    );
  }

  getInput(executionId: string): Promise<RunInputResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/input`, runInputResponseSchema);
  }

  listResults(executionId: string): Promise<PublishedResultListResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/results`, publishedResultListResponseSchema);
  }

  getResult(executionId: string, resultId: string): Promise<PublishedResultDto> {
    return this.#request(
      `/api/v1/runs/${encodeURIComponent(executionId)}/results/${encodeURIComponent(resultId)}`,
      publishedResultDtoSchema,
    );
  }

  getPerformance(executionId: string): Promise<RunPerformanceResponseDto> {
    return this.#request(`/api/v1/runs/${encodeURIComponent(executionId)}/performance`, runPerformanceResponseSchema);
  }

  getResolvedConfiguration(executionId: string): Promise<ResolvedConfigurationResponseDto> {
    return this.#request(
      `/api/v1/runs/${encodeURIComponent(executionId)}/resolved-configuration`,
      resolvedConfigurationResponseSchema,
    );
  }

  compareRuns(request: RunComparisonRequestDto): Promise<RunComparisonResponseDto> {
    return this.#request("/api/v1/run-comparisons", runComparisonResponseSchema, {
      method: "POST",
      body: JSON.stringify(runComparisonRequestSchema.parse(request)),
    });
  }

  async #request<T>(path: string, schema: z.ZodType<T>, request: RequestInit = {}): Promise<T> {
    const supplied = await this.#requestInit?.() ?? {};
    const headers = new Headers(supplied.headers);
    headers.set("accept", "application/json");
    const multipart = typeof FormData !== "undefined" && request.body instanceof FormData;
    if (multipart) headers.delete("content-type");
    else if (request.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...supplied,
      ...request,
      headers,
    });
    const value = await response.json() as unknown;
    if (!response.ok) {
      const parsed = apiErrorResponseSchema.safeParse(value);
      if (parsed.success) {
        throw new RunApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        );
      }
      throw new RunApiError(response.status, "invalid-error-response", "Run API returned an invalid error response.");
    }
    return schema.parse(value);
  }
}

function runListQueryString(query: RunListQueryDto): string {
  const params = new URLSearchParams();
  if (query.userId !== undefined) params.set("userId", query.userId);
  if (query.workflow !== undefined) {
    params.set("workflowKind", query.workflow.kind);
    params.set("workflowVersion", String(query.workflow.version));
  }
  if (query.target !== undefined) {
    params.set("targetKind", query.target.kind);
    if (query.target.identity !== undefined) params.set("targetIdentity", JSON.stringify(query.target.identity));
  }
  if (query.status !== undefined) params.set("status", query.status);
  if (query.createdAtOrAfter !== undefined) params.set("createdAtOrAfter", query.createdAtOrAfter);
  if (query.createdBefore !== undefined) params.set("createdBefore", query.createdBefore);
  if (query.lifecycleStatus !== undefined) params.set("lifecycleStatus", query.lifecycleStatus);
  for (const provider of query.providers ?? []) params.append("provider", provider);
  for (const model of query.models ?? []) params.append("model", model);
  if (query.numericRange !== undefined) {
    params.set("numericField", query.numericRange.field);
    if (query.numericRange.min != null) params.set("numericMin", String(query.numericRange.min));
    if (query.numericRange.max != null) params.set("numericMax", String(query.numericRange.max));
  }
  if (query.sort !== undefined) {
    params.set("sortField", query.sort.field);
    params.set("sortDirection", query.sort.direction);
  }
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  for (const field of query.summaryFields ?? []) params.append("summaryField", field);
  const serialized = params.toString();
  return serialized.length === 0 ? "" : `?${serialized}`;
}
