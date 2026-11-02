import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodType } from "zod";
import {
  ApplicationBoundaryError,
  toApplicationBoundaryError,
  type AuthorizedApplicationPrincipal,
} from "@com-pyvue/agent-execution-application-host";
import {
  apiErrorResponseSchema,
  artifactKeySchema,
  cancelRunRequestSchema,
  resultIdSchema,
  runComparisonRequestSchema,
  runListQuerySchema,
  runRefSchema,
  submitRunRequestSchema,
  workflowInvocationOptionsRequestSchema,
  workflowPreflightRequestSchema,
  type RunListQueryDto,
} from "@com-pyvue/agent-execution-run-contract";
import type { RunApplicationService } from "./services.ts";
import { inputSubmissionSchema, inputRequestIdSchema, inputUploadFieldsSchema } from "@com-pyvue/agent-execution-run-contract";
import { RunInputRequestError } from "./inputRequests.ts";
import { INPUT_UPLOAD_MAX_BYTES_PER_FILE } from "@com-pyvue/agent-execution-core/internal/application/inputWait.ts";

const MULTIPART_UPLOAD_OVERHEAD_BYTES = 64 * 1024;

interface RunRouterEnvironment {
  Variables: {
    principal: AuthorizedApplicationPrincipal;
  };
}

export interface RunRouterDependencies {
  service: RunApplicationService;
  authenticate(request: Request): Promise<AuthorizedApplicationPrincipal>;
}

export function createRunRouter(dependencies: RunRouterDependencies): Hono<RunRouterEnvironment> {
  const router = new Hono<RunRouterEnvironment>();

  const authenticate = async (context: Context<RunRouterEnvironment>, next: () => Promise<void>) => {
    context.set("principal", await dependencies.authenticate(context.req.raw));
    await next();
  };
  router.use("/api/v1/runs", authenticate);
  router.use("/api/v1/runs/*", authenticate);
  router.use("/api/v1/run-comparisons", authenticate);
  router.use("/api/v1/workflows", authenticate);
  router.use("/api/v1/workflows/*", authenticate);

  router.post("/api/v1/runs", async (context) => {
    const result = await dependencies.service.submit(
      context.get("principal"),
      requestContract(submitRunRequestSchema, await jsonBody(context)),
    );
    return context.json(result, 202);
  });

  router.get("/api/v1/workflows", async (context) => context.json(
    await dependencies.service.listWorkflows(context.get("principal")),
  ));

  router.post("/api/v1/workflows/preflight", async (context) => context.json(
    await dependencies.service.preflight(
      context.get("principal"),
      requestContract(workflowPreflightRequestSchema, await jsonBody(context)),
    ),
  ));

  router.post("/api/v1/workflows/invocation-options", async (context) => context.json(
    await dependencies.service.invocationOptions(
      context.get("principal"),
      requestContract(workflowInvocationOptionsRequestSchema, await jsonBody(context)),
    ),
  ));

  router.get("/api/v1/runs", async (context) => context.json(
    await dependencies.service.list(
      context.get("principal"),
      parseRunListQuery(context.req.query(), new URL(context.req.url).searchParams),
    ),
  ));

  router.get("/api/v1/runs/filter-options", async (context) => context.json(
    await dependencies.service.filterOptions(context.get("principal")),
  ));

  router.post("/api/v1/runs/:executionId/archive", async (context) => context.json(
    await dependencies.service.archive(context.get("principal"), runRef(context.req.param("executionId"))),
  ));

  router.post("/api/v1/runs/:executionId/restore", async (context) => context.json(
    await dependencies.service.restore(context.get("principal"), runRef(context.req.param("executionId"))),
  ));

  router.post("/api/v1/runs/:executionId/cancel", async (context) => context.json(
    await dependencies.service.cancel(
      context.get("principal"),
      runRef(context.req.param("executionId")),
      requestContract(cancelRunRequestSchema, await jsonBody(context)),
    ),
  ));

  router.get("/api/v1/runs/:executionId", async (context) => context.json(
    await dependencies.service.get(context.get("principal"), runRef(context.req.param("executionId"))),
  ));

  router.get("/api/v1/runs/:executionId/input-requests", async context => context.json(
    await dependencies.service.listInputRequests(context.get("principal"), runRef(context.req.param("executionId"))),
  ));
  router.post("/api/v1/runs/:executionId/input-requests/:requestId/uploads",
    bodyLimit({ maxSize: INPUT_UPLOAD_MAX_BYTES_PER_FILE + MULTIPART_UPLOAD_OVERHEAD_BYTES, onError: context => context.json({ error: {
      code: "file-too-large", message: "Upload exceeds the 25 MiB file limit.",
    } }, 413) }),
    async context => context.json(await dependencies.service.uploadInputFile(
      context.get("principal"), runRef(context.req.param("executionId")),
      requestContract(inputRequestIdSchema, context.req.param("requestId")), await multipartUpload(context),
    ), 201));
  router.post("/api/v1/runs/:executionId/input-requests/:requestId/response", async context => context.json(
    await dependencies.service.submitInputResponse(context.get("principal"), runRef(context.req.param("executionId")),
      requestContract(inputRequestIdSchema, context.req.param("requestId")), requestContract(inputSubmissionSchema, await jsonBody(context))), 202,
  ));

  router.get("/api/v1/runs/:executionId/artifacts", async (context) => context.json(
    await dependencies.service.listArtifacts(context.get("principal"), runRef(context.req.param("executionId"))),
  ));

  router.get("/api/v1/runs/:executionId/artifact-content", async (context) => context.json(
    await dependencies.service.getArtifactContent(
      context.get("principal"),
      runRef(context.req.param("executionId")),
      requestContract(artifactKeySchema, context.req.query("key")),
    ),
  ));

  router.get("/api/v1/runs/:executionId/input", async (context) => context.json(
    await dependencies.service.getInput(context.get("principal"), runRef(context.req.param("executionId"))),
  ));

  router.get("/api/v1/runs/:executionId/results", async (context) => context.json(
    await dependencies.service.listResults(context.get("principal"), runRef(context.req.param("executionId"))),
  ));

  router.get("/api/v1/runs/:executionId/results/:resultId", async (context) => context.json(
    await dependencies.service.getResult(
      context.get("principal"),
      runRef(context.req.param("executionId")),
      requestContract(resultIdSchema, context.req.param("resultId")),
    ),
  ));

  router.get("/api/v1/runs/:executionId/performance", async (context) => context.json(
    await dependencies.service.getPerformance(context.get("principal"), runRef(context.req.param("executionId"))),
  ));

  router.get("/api/v1/runs/:executionId/resolved-configuration", async (context) => context.json(
    await dependencies.service.getResolvedConfiguration(
      context.get("principal"),
      runRef(context.req.param("executionId")),
    ),
  ));

  router.post("/api/v1/run-comparisons", async (context) => context.json(
    await dependencies.service.compare(
      context.get("principal"),
      requestContract(runComparisonRequestSchema, await jsonBody(context)),
    ),
  ));

  router.onError((error, context) => {
    if (error instanceof RunInputRequestError) return context.json(apiErrorResponseSchema.parse({
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    }), error.status);
    const mapped = mapError(error);
    return context.json(apiErrorResponseSchema.parse({
      error: { code: mapped.code, message: mapped.message },
    }), mapped.status as ContentfulStatusCode);
  });

  return router;
}

function runRef(executionId: string) {
  return requestContract(runRefSchema, { executionId });
}

async function jsonBody(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new ApplicationBoundaryError("invalid-request", 400, "Request body must be valid JSON.");
  }
}

async function multipartUpload(context: Context) {
  if (!context.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new RunInputRequestError(415, "unsupported-media-type", "Upload body must be multipart/form-data.");
  }
  let body: Record<string, string | File | (string | File)[]>;
  try { body = await context.req.parseBody({ all: true }); }
  catch { throw new RunInputRequestError(400, "invalid-upload", "Upload body could not be read as multipart data."); }
  if (Object.keys(body).some(key => !["fieldId", "uploadId", "file"].includes(key))) {
    throw new RunInputRequestError(400, "invalid-upload", "Upload body contains unsupported fields.");
  }
  const one = (key: string): string | File | undefined => {
    const value = body[key];
    return Array.isArray(value) ? value.length === 1 ? value[0] : undefined : value;
  };
  const fields = requestContract(inputUploadFieldsSchema, { fieldId: one("fieldId"), uploadId: one("uploadId") });
  const file = one("file");
  if (!(file instanceof File)) throw new RunInputRequestError(400, "invalid-upload", "Upload body must contain exactly one file.");
  return { ...fields, filename: file.name, mediaType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function parseRunListQuery(query: Record<string, string>, searchParams: URLSearchParams): RunListQueryDto {
  const supported = new Set([
    "userId",
    "workflowKind",
    "workflowVersion",
    "targetKind",
    "targetIdentity",
    "status",
    "createdAtOrAfter",
    "createdBefore",
    "lifecycleStatus",
    "provider",
    "model",
    "numericField",
    "numericMin",
    "numericMax",
    "sortField",
    "sortDirection",
    "pageSize",
    "cursor",
    "summaryField",
  ]);
  const unknown = Object.keys(query).filter((key) => !supported.has(key));
  if (unknown.length > 0) {
    throw new ApplicationBoundaryError("invalid-request", 400, `Unknown run query fields: ${unknown.join(", ")}.`);
  }
  if ((query.workflowKind === undefined) !== (query.workflowVersion === undefined)) {
    throw new ApplicationBoundaryError("invalid-request", 400, "workflowKind and workflowVersion must be supplied together.");
  }
  if (query.targetIdentity !== undefined && query.targetKind === undefined) {
    throw new ApplicationBoundaryError("invalid-request", 400, "targetIdentity requires targetKind.");
  }
  if ((query.numericMin !== undefined || query.numericMax !== undefined) && query.numericField === undefined) {
    throw new ApplicationBoundaryError("invalid-request", 400, "numericMin and numericMax require numericField.");
  }
  if ((query.sortField === undefined) !== (query.sortDirection === undefined)) {
    throw new ApplicationBoundaryError("invalid-request", 400, "sortField and sortDirection must be supplied together.");
  }
  let targetIdentity: unknown;
  if (query.targetIdentity !== undefined) {
    try {
      targetIdentity = JSON.parse(query.targetIdentity) as unknown;
    } catch {
      throw new ApplicationBoundaryError("invalid-request", 400, "targetIdentity must be a JSON object.");
    }
  }
  return requestContract(runListQuerySchema, {
    ...(query.userId === undefined ? {} : { userId: query.userId }),
    ...(query.workflowKind === undefined ? {} : {
      workflow: { kind: query.workflowKind, version: Number(query.workflowVersion) },
    }),
    ...(query.targetKind === undefined ? {} : {
      target: {
        kind: query.targetKind,
        ...(targetIdentity === undefined ? {} : { identity: targetIdentity }),
      },
    }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.createdAtOrAfter === undefined ? {} : { createdAtOrAfter: query.createdAtOrAfter }),
    ...(query.createdBefore === undefined ? {} : { createdBefore: query.createdBefore }),
    ...(query.lifecycleStatus === undefined ? {} : { lifecycleStatus: query.lifecycleStatus }),
    ...(searchParams.getAll("provider").length === 0 ? {} : { providers: searchParams.getAll("provider") }),
    ...(searchParams.getAll("model").length === 0 ? {} : { models: searchParams.getAll("model") }),
    ...(query.numericField === undefined ? {} : {
      numericRange: {
        field: query.numericField,
        ...(query.numericMin === undefined ? {} : { min: Number(query.numericMin) }),
        ...(query.numericMax === undefined ? {} : { max: Number(query.numericMax) }),
      },
    }),
    ...(query.sortField === undefined ? {} : {
      sort: { field: query.sortField, direction: query.sortDirection },
    }),
    ...(query.pageSize === undefined ? {} : { pageSize: Number(query.pageSize) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(searchParams.getAll("summaryField").length === 0
      ? {}
      : { summaryFields: searchParams.getAll("summaryField") }),
  });
}

function mapError(error: unknown): ApplicationBoundaryError {
  if (error instanceof ZodError) {
    return new ApplicationBoundaryError("internal-error", 500, "Run API data did not match its response contract.");
  }
  return toApplicationBoundaryError(error);
}

function requestContract<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationBoundaryError("invalid-request", 400, "Request did not match the Run API contract.");
  }
  return parsed.data;
}
