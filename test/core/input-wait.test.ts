import { describe, expect, it } from "vitest";
import * as publicApi from "../../core/src/index.ts";
import { defineInputForm, inputFormDigestV1, parseInputWaitDurationV1, validateInputFormDescriptorV1,
  validateInputResponseShapeV1, validateInputResponseV1, validateInputRequestV1,
  validateInputRequestStateV1, validateRunStatusProjectionV2, validateRunStateProjection, validateRunStateV6, validateRunStateV5,
  type InputFormDescriptorV1, type InputResponseV1 } from "../../core/src/index.ts";

const form = (): InputFormDescriptorV1 => ({ schemaVersion: 1, id: "trip-details", version: "v1", fields: [
  { id: "name", label: "Name", type: "text", maxLength: 3, required: true },
  { id: "people", label: "People", type: "number", min: 1, max: 10, integer: true, required: true },
  { id: "confirmed", label: "Confirmed", type: "boolean", required: true },
  { id: "date", label: "Date", type: "date", required: true },
  { id: "choice", label: "Choice", type: "choice", options: ["yes", "no"], required: false },
  { id: "itinerary", label: "Itinerary", type: "files", maxFiles: 1, maxBytesPerFile: 10, mediaTypes: ["text/plain"], required: true },
] });
const response = (): InputResponseV1 => ({ schemaVersion: 1, fields: { name: "😀ab", people: 2, confirmed: false, date: "2028-02-29" },
  files: { itinerary: [{ objectId: "upload-1", mediaType: "text/plain", byteLength: 10, sha256: "a".repeat(64) }] } });
const request = () => ({ schemaVersion: 1, requestId: "request-1", stepId: "collect-trip-details", title: "Trip details", form: form(),
  formSha256: inputFormDigestV1(form()), executableBindingId: "bundle-1", createdAt: "2026-09-07T10:00:00.000Z", expiresAt: "2027-09-08T10:00:00.000Z" });

// Intentional any in negative fixtures: exercise malformed wire values that the public types forbid.

describe("public input-wait contract", () => {
  it("preserves approved finite field types, Unicode code points, false values and optional omission", () => {
    expect(validateInputResponseShapeV1(form(), response())).toEqual(response());
    const f = defineInputForm({ descriptor: form(), output: { parse: value => value as InputResponseV1 } });
    const result = validateInputResponseV1(f, response());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.files.itinerary[0])).toBe(true);
    expect(Object.isFrozen(f.descriptor.fields)).toBe(true);
  });
  it.each(["0s", "-1h", "1.5h", " 1h", "1h ", "01h", "1month", "367d", "31622401s", "999999999999999999999s", "1D"])("rejects invalid duration %s", value => {
    expect(() => parseInputWaitDurationV1(value)).toThrow();
  });
  it("allows the full 366 days in equivalent fixed units", () => {
    for (const value of ["366d", "8784h", "527040m", "31622400s"]) expect(parseInputWaitDurationV1(value)).toBe(31_622_400_000);
    expect(parseInputWaitDurationV1("1s")).toBe(1000);
  });
  it.each([
    ["unknown field", (r: any) => r.fields.extra = "secret"], ["missing field", (r: any) => delete r.fields.name],
    ["too long", (r: any) => r.fields.name = "😀abc"], ["wrong boolean", (r: any) => r.fields.confirmed = "false"],
    ["noninteger", (r: any) => r.fields.people = 1.5], ["too large", (r: any) => r.fields.people = 11],
    ["infinity", (r: any) => r.fields.people = Infinity], ["bad leap date", (r: any) => r.fields.date = "2027-02-29"],
    ["datetime", (r: any) => r.fields.date = "2028-02-29T00:00:00Z"], ["unknown choice", (r: any) => r.fields.choice = "maybe"],
    ["missing upload", (r: any) => r.files = {}], ["empty required uploads", (r: any) => r.files.itinerary = []],
    ["extra upload", (r: any) => r.files.other = r.files.itinerary], ["file in scalar", (r: any) => r.fields.itinerary = "file"],
    ["wrong media", (r: any) => r.files.itinerary[0].mediaType = "application/pdf"], ["oversized", (r: any) => r.files.itinerary[0].byteLength = 11],
    ["fractional byte size", (r: any) => r.files.itinerary[0].byteLength = 1.5], ["negative size", (r: any) => r.files.itinerary[0].byteLength = -1],
    ["path identifier", (r: any) => r.files.itinerary[0].objectId = "../file"], ["extra filename", (r: any) => r.files.itinerary[0].filename = "file.txt"],
    ["wrong digest", (r: any) => r.files.itinerary[0].sha256 = "bad"], ["version", (r: any) => r.schemaVersion = 2],
    ["undefined optional", (r: any) => r.fields.choice = undefined], ["null optional", (r: any) => r.fields.choice = null],
    ["array fields", (r: any) => r.fields = []], ["unknown root", (r: any) => r.secret = "secret"],
  ])("rejects malformed response: %s", (_, change) => { const r = response(); change(r); expect(() => validateInputResponseShapeV1(form(), r)).toThrow(); });
  it.each([
    ["duplicate ID", (f: any) => f.fields[1].id = "name"], ["reserved ID", (f: any) => f.fields[0].id = "__proto__"],
    ["unknown type", (f: any) => f.fields[0].type = "html"], ["unknown property", (f: any) => f.fields[0].html = "x"],
    ["zero text size", (f: any) => f.fields[0].maxLength = 0], ["unsafe integer", (f: any) => f.fields[0].maxLength = Number.MAX_SAFE_INTEGER + 1],
    ["reversed bounds", (f: any) => f.fields[1].min = 11], ["duplicate choice", (f: any) => f.fields[4].options = ["yes", "yes"]],
    ["wildcard media", (f: any) => f.fields[5].mediaTypes = ["text/*"]], ["empty media", (f: any) => f.fields[5].mediaTypes = []],
    ["zero file count", (f: any) => f.fields[5].maxFiles = 0], ["no required flag", (f: any) => delete f.fields[0].required],
    ["too many files", (f: any) => f.fields[5].maxFiles = 11], ["file limit above 25 MiB", (f: any) => f.fields[5].maxBytesPerFile = 25 * 1024 * 1024 + 1],
  ])("rejects malformed form: %s", (_, change) => { const f = form(); change(f); expect(() => validateInputFormDescriptorV1(f)).toThrow(); });
  it("does not execute accessors or accept hidden, sparse, symbol, cyclic or class data", () => {
    let called = false; const getter = response(); Object.defineProperty(getter.fields, "name", { enumerable: true, get() { called = true; return "abc"; } });
    const cyclic: any = response(); cyclic.fields.name = cyclic;
    const sparse: any = response(); sparse.files.itinerary = new Array(1);
    const symbol: any = response(); symbol[Symbol("secret")] = "value";
    const hidden: any = response(); Object.defineProperty(hidden, "secret", { value: "value" });
    const date: any = response(); date.fields.date = new Date();
    for (const item of [getter, cyclic, sparse, symbol, hidden, date]) expect(() => validateInputResponseShapeV1(form(), item)).toThrow();
    expect(called).toBe(false);
  });
  it("checks the raw response before invoking workflow validation", () => {
    let called = false;
    const r: any = response(); r.fields.extra = "bad";
    expect(() => validateInputResponseV1({ descriptor: form(), output: { parse() { called = true; return response(); } } }, r)).toThrow();
    expect(called).toBe(false);
  });
  it.each(["objectId", "sha256", "byteLength", "mediaType", "remove"])("rejects output-validator file changes: %s", key => {
    const f = form(); (f.fields[5] as any).required = false;
    const parsed = response(); if (key === "remove") parsed.files = {}; else (parsed.files.itinerary[0] as any)[key] = key === "byteLength" ? 1 : key === "sha256" ? "b".repeat(64) : key === "mediaType" ? "other" : "upload-2";
    expect(() => validateInputResponseV1({ descriptor: f, output: { parse: () => parsed } }, response())).toThrow();
  });
  it("checks the output validator again for undeclared or invalid scalar results", () => {
    const output: any = response(); output.fields.people = 99;
    expect(() => validateInputResponseV1({ descriptor: form(), output: { parse: () => output } }, response())).toThrow();
  });
  it("rejects output-validator attempts to mutate the frozen submitted answer", () => {
    expect(() => validateInputResponseV1({ descriptor: form(), output: { parse(value) {
      (value as InputResponseV1).files.itinerary[0].objectId = "changed"; return value as InputResponseV1;
    } } }, response())).toThrow();
  });
  it("does not invent a prohibition on using a retained file in two declared fields", () => {
    const f = form(); f.fields.push({ ...f.fields[5], id: "copy" });
    const r = response(); r.files.copy = r.files.itinerary;
    expect(validateInputResponseShapeV1(f, r).files.copy).toEqual(r.files.itinerary);
  });
  it("preserves validator receivers and allows valid scalar normalization", () => {
    const output = { amount: 3, parse(value: unknown) { return { ...(value as InputResponseV1), fields: { ...(value as InputResponseV1).fields, people: this.amount } }; } };
    expect(validateInputResponseV1({ descriptor: form(), output }, response()).fields.people).toBe(3);
  });
  it("hashes form content canonically, not just its author-supplied version", () => {
    const f = form(), reverse = Object.fromEntries(Object.entries(f).reverse());
    expect(inputFormDigestV1(reverse)).toBe(inputFormDigestV1(f));
    f.fields[0].label = "Changed"; expect(inputFormDigestV1(f)).not.toBe(inputFormDigestV1(form()));
  });
  it("validates fixed requests and detects definition or deadline drift", () => {
    expect(validateInputRequestV1(request())).toEqual(request());
    for (const r of [{ ...request(), formSha256: "a".repeat(64) }, { ...request(), expiresAt: "2027-09-09T10:00:00.000Z" },
      { ...request(), expiresAt: request().createdAt }, { ...request(), status: "pending" }]) expect(() => validateInputRequestV1(r)).toThrow();
  });
  it("validates request projections without reopening terminal requests or accepting at the deadline", () => {
    const r = request(), base = { schemaVersion: 1, request: r, revision: 1, status: "pending", updatedAt: r.createdAt };
    expect(validateInputRequestStateV1(base).status).toBe("pending");
    expect(validateInputRequestStateV1({ ...base, status: "expired", updatedAt: r.expiresAt }).status).toBe("expired");
    for (const state of [{ ...base, revision: 0 }, { ...base, status: "reopened" }, { ...base, status: "submitted", updatedAt: r.expiresAt },
      { ...base, status: "expired" }, { ...base, updatedAt: "2020-01-01T00:00:00.000Z" }]) expect(() => validateInputRequestStateV1(state)).toThrow();
  });
  it("admits waiting in the existing status contract and the internal versioned wrapper", () => {
    const waiting = { schemaVersion: 2, kind: "status", status: "waiting_for_input", updatedAt: request().createdAt, requestId: "request-1", expiresAt: request().expiresAt, activeComputeMs: 30 };
    expect(validateRunStatusProjectionV2(waiting)).toEqual(waiting);
    expect(() => validateRunStateProjection(waiting)).toThrow();
    const { schemaVersion: _, ...unversioned } = waiting;
    expect(validateRunStateProjection(unversioned)).toEqual(unversioned);
    expect(() => validateRunStatusProjectionV2({ ...waiting, activeComputeMs: -1 })).toThrow();
    expect(() => validateRunStatusProjectionV2({ ...waiting, schemaVersion: 1 })).toThrow();
    const queued = { ...waiting, status: "resume_queued", updatedAt: "2028-01-01T00:00:00.000Z" };
    expect(validateRunStatusProjectionV2(queued).status).toBe("resume_queued");
    expect(validateRunStatusProjectionV2({ schemaVersion: 2, kind: "status", status: "complete", updatedAt: waiting.updatedAt }).status).toBe("complete");
  });
  it("exposes form helpers but not internal host, storage, or engine implementations", () => {
    expect(publicApi.defineInputForm).toBe(defineInputForm);
    for (const key of ["DurableWorkflowEngineV2", "DurableWorkflowRunExecutorV2", "SuspendedInputOutcomeV1", "inputWaitJsonSnapshot"]) expect(key in publicApi).toBe(false);
  });
  it("validates V6 state with the existing manifest and rejects V6 through old readers", () => {
    const manifest = { schemaVersion: 5, runRef: { executionId: "run-1" }, workflow: { kind: "fixture", version: 1 },
      createdAt: request().createdAt, actor: { userId: "user-1", roleId: "runner" },
      runConfiguration: { configurationId: "fixture-v1", contentHash: "a".repeat(64) }, executionMode: "local" };
    const state = { schemaVersion: 6, manifest, status: { schemaVersion: 2, kind: "status", status: "waiting_for_input", updatedAt: request().createdAt,
      requestId: "request-1", expiresAt: request().expiresAt, activeComputeMs: 20 } };
    expect(validateRunStateV6(state)).toEqual(state);
    expect(validateRunStateV6({ schemaVersion: 6, manifest })).toEqual({ schemaVersion: 6, manifest });
    expect(() => validateRunStateV5(state)).toThrow();
    expect(() => validateRunStateV6({ ...state, schemaVersion: 5 })).toThrow();
    expect(() => validateRunStateV6({ ...state, status: { kind: "status", status: "complete", updatedAt: request().createdAt } })).toThrow();
    expect(() => validateRunStateV6({ ...state, manifest: { ...manifest, executionMode: "cloud" } })).toThrow();
  });
  it("state validators reject accessors without evaluating them", () => {
    let called = false;
    const state = { schemaVersion: 2 }; Object.defineProperty(state, "status", { enumerable: true, get() { called = true; return "running"; } });
    for (const validate of [validateRunStateV6, validateRunStatusProjectionV2, validateInputRequestStateV1]) expect(() => validate(state)).toThrow();
    expect(called).toBe(false);
  });
});
