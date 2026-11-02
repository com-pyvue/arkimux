import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunApiClient,
  publishedResultDtoSchema,
  runListResponseSchema,
  submitRunRequestSchema,
  inputFormSchema,
  inputSubmissionSchema,
  inputRequestsResponseSchema,
  workflowInvocationOptionsResponseSchema,
} from "../../apps/packages/run/contract/src/index.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Run transport contract", () => {
  it("publishes finite input form types without importing the execution engine", () => {
    const form = { schemaVersion: 1, id: "city:form", version: "v1", fields: [
      { id: "city:name", label: "City", type: "text", required: true, maxLength: 50 },
    ] };
    expect(inputFormSchema.parse(form)).toEqual(form);
    expect(() => inputFormSchema.parse({ ...form, callback: "not-wire-data" })).toThrow();
    expect(() => inputFormSchema.parse({ ...form, fields: [{ id: "x", label: "X", type: "arbitrary-html", required: false }] })).toThrow();
    expect(() => inputRequestsResponseSchema.parse({ schemaVersion: 1, runRef: { executionId: "run" }, items: [], storagePath: "/private" })).toThrow();
  });

  it("separates malformed submission envelopes from answer validation", () => {
    const body = { submissionId: "answer", expectedRevision: 1, response: { badAnswer: true } };
    expect(inputSubmissionSchema.parse(body)).toEqual(body);
    expect(() => inputSubmissionSchema.parse({ ...body, responderId: "spoofed" })).toThrow();
    expect(() => inputSubmissionSchema.parse({ ...body, expectedRevision: 0 })).toThrow();
    expect(() => inputSubmissionSchema.parse({ ...body, submissionId: "constructor" })).toThrow();
  });

  it("keeps graph invocation choices finite and schema-described", () => {
    const response = { model: "graph-entry", entries: [{ id: "default", label: "calculate (default)", nodeKind: "step",
      entry: { kind: "default" }, requirements: [{ id: "entry", role: "entry-input", contractVersion: "1",
        schema: { type: "number" }, provenance: "caller-supplied" }] }] };
    expect(workflowInvocationOptionsResponseSchema.parse(response)).toEqual(response);
    expect(() => workflowInvocationOptionsResponseSchema.parse({ ...response, entries: [{ ...response.entries[0], factory: "project-code" }] })).toThrow();
  });

  it("uses the input-request client routes and leaves multipart content type to the browser", async () => {
    const requests: { url: URL; init?: RequestInit }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input)); requests.push({ url, init });
      if (url.pathname.endsWith("/uploads")) return new Response(JSON.stringify({ schemaVersion: 1,
        runRef: { executionId: "run-1" }, requestId: "request-1", fieldId: "documents", uploadId: "upload-1",
        file: { objectId: "object-1", mediaType: "text/plain", byteLength: 5, sha256: "a".repeat(64) } }));
      if (url.pathname.endsWith("/response")) return new Response(JSON.stringify({ schemaVersion: 1,
        runRef: { executionId: "run-1" }, kind: "graph-entry", accepted: { schemaVersion: 1,
          acceptanceId: "answer-1", requestId: "request-1", acceptedAt: "2026-08-05T12:00:00.000Z", acceptedBodySha256: "b".repeat(64) } }), { status: 202 });
      return new Response(JSON.stringify({ schemaVersion: 1, runRef: { executionId: "run-1" }, items: [] }));
    });
    const client = new RunApiClient({ baseUrl: "https://runs.example", fetch,
      requestInit: () => ({ headers: { "content-type": "application/json", authorization: "Bearer fixture" } }) });
    await client.listInputRequests("run-1");
    await client.submitInputResponse("run-1", "request-1", { submissionId: "answer-1", expectedRevision: 1, response: {} });
    await client.uploadInputFile("run-1", "request-1", { fieldId: "documents", uploadId: "upload-1",
      file: new Blob(["hello"], { type: "text/plain" }), filename: "note.txt" });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/v1/runs/run-1/input-requests",
      "/api/v1/runs/run-1/input-requests/request-1/response",
      "/api/v1/runs/run-1/input-requests/request-1/uploads",
    ]);
    const uploadHeaders = new Headers(requests[2]!.init?.headers);
    expect(uploadHeaders.has("content-type")).toBe(false);
    expect(uploadHeaders.get("authorization")).toBe("Bearer fixture");
    expect(requests[2]!.init?.body).toBeInstanceOf(FormData);
  });

  it("rejects unknown request and response fields", () => {
    expect(() => submitRunRequestSchema.parse({
      workflow: { kind: "fixture.workflow", version: 1 },
      roleId: "runner",
      input: {},
      runConfigurationId: "fixture-v1",
      userId: "caller-must-not-supply-this",
    })).toThrow();
    expect(() => runListResponseSchema.parse({ items: [], pagination: {}, physicalRoot: "/tmp/runs" }))
      .toThrow();
  });

  it("requires an explicit fixed warning acknowledgement for corrected Runs", () => {
    const request = {
      workflow: { kind: "fixture.workflow", version: 1 }, roleId: "runner", input: {},
      runConfigurationId: "fixture-v1",
      correction: { priorRunRef: { executionId: "prior-run" }, activeOriginal: "cancel",
        acknowledgement: "new-run-from-start-effects-not-undone" },
    };
    expect(submitRunRequestSchema.parse(request)).toEqual(request);
    expect(() => submitRunRequestSchema.parse({ ...request, correction: {
      ...request.correction, acknowledgement: "yes",
    } })).toThrow();
    expect(() => submitRunRequestSchema.parse({ ...request, correction: {
      ...request.correction, activeOriginal: true,
    } })).toThrow();
  });

  it("keeps generic result payloads opaque but JSON-valid", () => {
    expect(publishedResultDtoSchema.parse({
      resultId: "result.json",
      envelopeSchemaVersion: 1,
      resultKind: "fixture.result",
      runRef: { executionId: "run-01" },
      payload: { schemaVersion: 7, workflowOwned: [true, null] },
    }).payload).toEqual({ schemaVersion: 7, workflowOwned: [true, null] });
  });

  it("validates independent client responses and serializes server filters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("workflowKind")).toBe("fixture.workflow");
      expect(url.searchParams.get("workflowVersion")).toBe("1");
      expect(url.searchParams.get("pageSize")).toBe("25");
      expect(url.searchParams.getAll("summaryField")).toEqual(["inputTokens", "model"]);
      expect(url.searchParams.getAll("provider")).toEqual(["pi-cli", "codex-cli"]);
      expect(url.searchParams.getAll("model")).toEqual(["gpt-5.6-luna"]);
      expect(url.searchParams.get("numericField")).toBe("inputTokens");
      expect(url.searchParams.get("numericMin")).toBe("100");
      expect(url.searchParams.has("numericMax")).toBe(false);
      expect(url.searchParams.get("sortField")).toBe("inputTokens");
      expect(url.searchParams.get("sortDirection")).toBe("desc");
      expect(url.searchParams.get("lifecycleStatus")).toBe("all");
      return new Response(JSON.stringify({ items: [], pagination: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new RunApiClient({ baseUrl: "https://runs.example/", fetch });
    expect(await client.listRuns({
      workflow: { kind: "fixture.workflow", version: 1 },
      pageSize: 25,
      lifecycleStatus: "all",
      providers: ["pi-cli", "codex-cli"],
      models: ["gpt-5.6-luna"],
      numericRange: { field: "inputTokens", min: 100, max: null },
      sort: { field: "inputTokens", direction: "desc" },
      summaryFields: ["inputTokens", "model"],
    })).toEqual({ items: [], pagination: {} });
  });

  it("binds the browser-native fetch receiver when no implementation is injected", async () => {
    let receiver: unknown;
    vi.stubGlobal("fetch", function browserFetch(this: unknown) {
      receiver = this;
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify({ items: [], pagination: {} })));
    });
    const client = new RunApiClient({ baseUrl: "https://runs.example" });

    await expect(client.listRuns()).resolves.toEqual({ items: [], pagination: {} });
    expect(receiver).toBe(globalThis);
  });

  it("rejects malformed success and exposes validated API errors", async () => {
    const malformed = new RunApiClient({
      baseUrl: "https://runs.example",
      fetch: async () => new Response(JSON.stringify({ items: [], pagination: {}, extra: true })),
    });
    await expect(malformed.listRuns()).rejects.toThrow();

    const rejected = new RunApiClient({
      baseUrl: "https://runs.example",
      fetch: async () => new Response(JSON.stringify({
        error: { code: "forbidden", message: "Permission is required." },
      }), { status: 403 }),
    });
    await expect(rejected.listRuns()).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });
});
