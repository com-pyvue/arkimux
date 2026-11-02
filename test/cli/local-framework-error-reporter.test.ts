import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFrameworkDiagnostics } from "../../local/src/localFrameworkDiagnostics.ts";
import { createBrowserDiagnosticReceiver } from "../../local/src/localBrowserDiagnostics.ts";
import { createLocalFrameworkErrorReporter } from "../../local/src/localFrameworkErrorReporter.ts";
import { ExternalProviderError } from "../../core/src/application/externalError.ts";
import { InputControlConflict } from "../../core/src/application/retainedExecution.ts";
import { RetainedAttemptReadinessError } from "../../core/src/application/activeCompute.ts";
import { ApplicationBoundaryError } from "../../apps/packages/application-host/src/index.ts";
import { resolveWorkflowEnvironment } from "../../local/src/workflowEnvironment.ts";
import { observeFrameworkStorage } from "../../local/src/localFrameworkStorageObserver.ts";
import { deserializeFrameworkError } from "../../local/src/localFrameworkWorkerError.ts";
import { serializeError } from "../../local/src/localFrameworkDiagnostics.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-framework-report-")); roots.push(root);
  const diagnostics = new LocalFrameworkDiagnostics({ projectRoot: root });
  return { diagnostics, ...createLocalFrameworkErrorReporter({ diagnostics, version: "0.1.0" }) };
}
describe("shared framework error reporter", () => {
  it("persists original errors and causes locally, once across boundaries, without network access", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network must not be used"));
    const f = await fixture(), error = new Error("private original", { cause: new TypeError("nested original") });
    await Promise.all([f.report(error, "api"), f.report(error, "background")]);
    await f.report(new Error("outer wrapper", { cause: error }), "background");
    const [summary] = await f.diagnostics.list();
    expect((await f.diagnostics.get(summary!.diagnosticId))?.error).toMatchObject({ message: "private original", cause: { message: "nested original" } });
    expect(await f.diagnostics.list()).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
  it("excludes expected input and cancellation without hiding unrelated causes or provider errors", async () => {
    const f = await fixture();
    const excluded = [new InputControlConflict("stale-owner"),
      new RetainedAttemptReadinessError("credentials-unavailable"), new ApplicationBoundaryError("invalid-request", 400, "bad input"),
      Object.assign(new Error("cancelled"), { name: "AbortError" })];
    for (const error of excluded) await f.report(error, "api");
    expect(await f.diagnostics.list()).toEqual([]);
    const included = [new ExternalProviderError("test", "provider detail"),
      Object.assign(new Error("run failed"), { code: "workflow-failed" }),
      new AggregateError([new InputControlConflict("stale-owner"), new Error("storage failed")], "mixed failure"),
      new Error("unexpected wrapper", { cause: excluded[0] }),
      Object.assign(new Error("invalid provider response"), { status: 400 })];
    try { resolveWorkflowEnvironment({ schemaVersion: 1, variables: [{ name: "SECRET", required: true, secret: true, type: "string" }] }, {}); }
    catch (error) { included.push(error as Error); }
    for (const error of included) await f.report(error, "background");
    expect(await f.diagnostics.list()).toHaveLength(included.length);
  });
  it("retains workflow and unknown-origin errors without build metadata or network access", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network must not be used"));
    try {
      const f = await fixture();
      const cause = new Error("workflow private detail");
      cause.stack = "Error: workflow private detail\n    at run (/private/project/workflow.ts:8:2)";
      const error = new Error("worker failed", { cause });
      error.stack = undefined;
      await f.report(error, "worker");
      await f.report(new Error("outbox failure"), "telemetry");
      const records = await f.diagnostics.list();
      expect(records).toHaveLength(2);
      const worker = records.find(record => record.operation === "worker")!;
      expect((await f.diagnostics.get(worker.diagnosticId))?.error).toMatchObject({
        message: "worker failed", cause: { message: cause.message, stack: cause.stack },
      });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("captures a fatal workflow error locally once, without source maps or bundle hashes", async () => {
    const f = await fixture();
    const cause = new Error("workflow failed with private context");
    cause.stack = "Error: workflow failed with private context\n    at run (/project/workflow.ts:5:2)";
    const error = new Error("fatal wrapper", { cause });
    f.reportFatal(error); f.reportFatal(error);
    const records = await f.diagnostics.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.operation).toBe("process");
    expect((await f.diagnostics.get(records[0]!.diagnosticId))?.error).toMatchObject({
      message: error.message, stack: error.stack, cause: { message: cause.message, stack: cause.stack },
    });
  });
  it("deduplicates fatal causes across normal boundaries and retains non-Error rejections", async () => {
    const f = await fixture(), cause = new Error("original failure");
    f.reportFatal(new Error("fatal wrapper", { cause }));
    await f.report(cause, "background");
    await f.report("rejected with a string", "background");
    const records = await f.diagnostics.list();
    expect(records).toHaveLength(2);
    const nonError = records.find(record => record.operation === "background")!;
    expect((await f.diagnostics.get(nonError.diagnosticId))?.error).toEqual({ name: "NonError", message: "rejected with a string" });
  });
  it("keeps a new aggregate failure when another child was already reported", async () => {
    const f = await fixture(), previous = new Error("previous failure");
    await f.report(previous, "storage");
    await f.report(new AggregateError([previous, new Error("new failure")], "aggregate"), "background");
    expect(await f.diagnostics.list()).toHaveLength(2);
  });
  it("keeps arbitrary browser traces unchanged and still rejects malformed or oversized input", async () => {
    const f = await fixture(), receive = createBrowserDiagnosticReceiver(f.report);
    const input = { name: "CustomWorkflowError", message: "private plugin failure", stack:
      "Error: private plugin failure\n    at plugin (https://plugin.example/private.js:2:3)\n    at workflow (/project/workflow.ts:4:5)" };
    expect(await receive(input)).toBe(true);
    const [record] = await f.diagnostics.list();
    expect(record?.operation).toBe("browser");
    expect((await f.diagnostics.get(record!.diagnosticId))?.error).toMatchObject(input);
    for (const invalid of [null, { ...input, secret: "unexpected field" }, { ...input, message: "x".repeat(4097) },
      { ...input, stack: "x".repeat(12001) }, { ...input, name: 42 }]) {
      expect(await receive(invalid)).toBe(false);
    }
    expect(await f.diagnostics.list()).toHaveLength(1);
  });
  it("keeps browser causes and aggregate children for local inspection", async () => {
    const f = await fixture(), receive = createBrowserDiagnosticReceiver(f.report);
    const browser = new AggregateError([new TypeError("child detail")], "browser failure", { cause: new Error("original cause") });
    browser.name = "CustomBrowserError";
    expect(await receive(serializeError(browser))).toBe(true);
    const [summary] = await f.diagnostics.list();
    expect((await f.diagnostics.get(summary!.diagnosticId))?.error).toMatchObject({ name: "CustomBrowserError",
      message: "browser failure", cause: { message: "original cause" }, errors: [{ message: "child detail" }] });
  });
  it("cannot replace the original outcome when diagnostic storage fails", async () => {
    const f = await fixture();
    await expect(f.report(new Error("framework failed"), "api")).resolves.toBeUndefined();
    vi.spyOn(f.diagnostics, "record").mockRejectedValueOnce(new Error("disk full"));
    await expect(f.report(new Error("another failure"), "storage")).resolves.toBeUndefined();
  });
  it("observes a storage failure without changing private fields, sync values or thrown identity", async () => {
    const error = new Error("disk failed"), reported: unknown[] = [];
    class Store { #value = 42; read() { return this.#value; } async write() { throw error; } }
    const store = observeFrameworkStorage(new Store(), error => reported.push(error));
    expect(store.read()).toBe(42); await expect(store.write()).rejects.toBe(error); expect(reported).toEqual([error]);
  });
  it("preserves bounded causes across worker IPC and rejects malformed diagnostic input", () => {
    const original = new AggregateError([new TypeError("child")], "outer", { cause: new Error("cause") });
    const restored = deserializeFrameworkError(serializeError(original)) as AggregateError;
    expect(restored.message).toBe("outer"); expect((restored.cause as Error).message).toBe("cause");
    expect(restored.errors[0].stack).toBe(original.errors[0].stack);
    expect(deserializeFrameworkError({ name: "Error", message: "x".repeat(40000) })).toBeUndefined();
    expect(deserializeFrameworkError({ name: "Error", message: "x", installation_id: "injected" })).toBeUndefined();
  });
  it("retains oversized worker traces within IPC and storage limits instead of dropping the error", async () => {
    const f = await fixture();
    let cause = new Error("deepest");
    for (let index = 0; index < 10; index++) cause = new Error(`cause ${index}`, { cause });
    const original = new AggregateError([cause, ...Array.from({ length: 40 }, (_, index) => new Error(`child ${index}`))], "long".repeat(12_000));
    original.stack = "😀\u0000".repeat(80_000);
    const serialized = serializeError(original);
    const restored = deserializeFrameworkError(serialized);
    expect(restored).toBeInstanceOf(AggregateError);
    expect(restored!.message).toContain("[truncated]");
    await f.report(restored, "worker");
    const [summary] = await f.diagnostics.list();
    const record = await f.diagnostics.get(summary!.diagnosticId);
    expect(record?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(256 * 1024);
    expect(record?.error.message).toContain("long");
  });
});
