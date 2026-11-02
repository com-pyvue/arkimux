import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { runKey, validateRetainedRunControl, type ExecutableBindingV1 } from "../../core/src/application/retainedExecution.ts";
import type { InputResponseV1 } from "../../core/src/application/inputWait.ts";

const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
const ref = { executionId: "run-1" };
const form = { schemaVersion: 1 as const, id: "trip", version: "v1", fields: [{ id: "city", label: "City", type: "text" as const, required: true, maxLength: 50 }] };
const fileForm = { schemaVersion: 1 as const, id: "documents", version: "v1", fields: [
  { id: "documents", label: "Documents", type: "files" as const, required: true, maxFiles: 2, maxBytesPerFile: 1024, mediaTypes: ["text/plain"] },
] };
const answer = (city = "London"): InputResponseV1 => ({ schemaVersion: 1, fields: { city }, files: {} });
const identity = async (_request: unknown, response: InputResponseV1) => response;
const requirements = { node: "22.19.0", codex: "pinned-test-version" };
async function setup(requestForm = form) {
  const root = await mkdtemp(path.join(tmpdir(), "retained-store-")); roots.push(root);
  let clock = new Date("2026-09-07T12:34:56.789Z");
  const store = await FileRetainedExecutionStoreV1.open(root, { now: () => clock }); stores.push(store);
  const input = { inputSha256: "a".repeat(64), entryPoint: "entry.mjs", files: { "entry.mjs": Buffer.from("export const value = 1;") }, hostRequirements: requirements };
  const build = await store.publishBuild(input);
  const binding: ExecutableBindingV1 = { id: "binding-1", buildSha256: build.buildSha256, workflow: { id: "weather" }, invocation: { city: "London" },
    runConfiguration: { id: "config-v1" }, executionProfile: { id: "local" }, nonSecretEnvironment: {}, credentialReferences: ["codex-native-session"], hostRequirements: requirements };
  await store.createRun(ref, binding);
  const owner = await store.claim(ref, "attempt-1", requirements);
  return { root, store, owner, binding, build, input, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    open: () => store.openRequest(ref, owner, { stepId: "ask", title: "Your trip", form: requestForm, expiresAfter: "1h" }) };
}
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("retained Local execution authority", () => {
  it("retains immutable request files across restart and deletes them only with explicit retained Run data", async () => {
    const f = await setup(fileForm), request = await f.open(), bytes = Buffer.from("approved document");
    const upload = { fieldId: "documents", uploadId: "upload-1", filename: "note.txt", mediaType: "text/plain", bytes };
    const first = await f.store.uploadInputFile(ref, request.requestId, upload);
    expect((await f.store.read(ref))?.status).toBe("waiting_for_input");
    await expect(f.store.readInputFile(ref, first.file)).rejects.toThrow("binding-mismatch");
    expect(await f.store.uploadInputFile(ref, request.requestId, upload)).toEqual(first);
    await expect(f.store.uploadInputFile(ref, request.requestId, { ...upload, bytes: Buffer.from("changed") })).rejects.toThrow("upload-reused");
    const response: InputResponseV1 = { schemaVersion: 1, fields: {}, files: { documents: [first.file] } };
    await f.store.submit(ref, request.requestId, { submissionId: "one", expectedRevision: 1, response }, "developer", identity);
    expect(Buffer.from(await f.store.readInputFile(ref, first.file)).toString()).toBe("approved document");
    await f.store.release(ref, f.owner); await f.store.close();
    const reopened = await FileRetainedExecutionStoreV1.open(f.root); stores.push(reopened);
    await reopened.recover();
    expect(Buffer.from(await reopened.readInputFile(ref, first.file)).toString()).toBe("approved document");
    const owner = await reopened.claim(ref, "attempt-2", requirements);
    await reopened.completeInput(ref, owner, request.requestId); await reopened.finish(ref, owner, "complete");
    await reopened.deleteRetainedControlData(ref);
    await expect(reopened.readInputFile(ref, first.file)).rejects.toThrow();
  });

  it("rejects unsafe upload metadata and forged or cross-Run file references", async () => {
    const f = await setup(fileForm), request = await f.open();
    const valid = { fieldId: "documents", uploadId: "upload-1", filename: "note.txt", mediaType: "text/plain", bytes: Buffer.from("one") };
    await expect(f.store.uploadInputFile(ref, request.requestId, { ...valid, filename: "../note.txt" })).rejects.toThrow("Filename");
    await expect(f.store.uploadInputFile(ref, request.requestId, { ...valid, mediaType: "text/html" })).rejects.toThrow("media type");
    await expect(f.store.uploadInputFile(ref, request.requestId, { ...valid, uploadId: "large", bytes: Buffer.alloc(1025) })).rejects.toThrow("1024 bytes");
    const uploaded = await f.store.uploadInputFile(ref, request.requestId, valid);
    await f.store.uploadInputFile(ref, request.requestId, { ...valid, uploadId: "upload-2", filename: "other.txt" });
    await expect(f.store.uploadInputFile(ref, request.requestId, { ...valid, uploadId: "upload-3", filename: "third.txt" })).rejects.toThrow("at most 2 files");
    const forged: InputResponseV1 = { schemaVersion: 1, fields: {}, files: { documents: [{ ...uploaded.file, sha256: "b".repeat(64) }] } };
    await expect(f.store.submit(ref, request.requestId, { submissionId: "forged", expectedRevision: 1, response: forged }, "developer", identity))
      .rejects.toThrow("not finalized");
    const other = { executionId: "run-2" };
    await f.store.createRun(other, { ...f.binding, id: "binding-2" });
    const otherOwner = await f.store.claim(other, "other-attempt", requirements);
    const otherRequest = await f.store.openRequest(other, otherOwner, { stepId: "ask", title: "Other", form: fileForm, expiresAfter: "1h" });
    const cross: InputResponseV1 = { schemaVersion: 1, fields: {}, files: { documents: [uploaded.file] } };
    await expect(f.store.submit(other, otherRequest.requestId, { submissionId: "cross", expectedRevision: 1, response: cross }, "developer", identity))
      .rejects.toThrow("not finalized");
  });

  it("protects pending uploads and removes only resolved unreferenced uploads after seven days", async () => {
    const f = await setup(fileForm), request = await f.open();
    const upload = await f.store.uploadInputFile(ref, request.requestId,
      { fieldId: "documents", uploadId: "upload-1", filename: "note.txt", mediaType: "text/plain", bytes: Buffer.from("orphan") });
    const content = path.join(f.root, "uploads", runKey(ref), upload.file.objectId, "content");
    f.advance(30 * 24 * 60 * 60 * 1000); await f.store.cleanInputUploads();
    await expect(access(content)).resolves.toBeUndefined();
    await f.store.cancel(ref); await f.store.cleanInputUploads();
    await expect(access(content)).resolves.toBeUndefined();
    f.advance(7 * 24 * 60 * 60 * 1000 - 1); await f.store.cleanInputUploads();
    await expect(access(content)).resolves.toBeUndefined();
    f.advance(1); await f.store.cleanInputUploads();
    await expect(access(content)).rejects.toThrow();
  });
  it("recovers a committed response after its actual worker is killed before release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retained-crash-")); roots.push(root);
    const worker = path.join(root, "worker.mjs"), storage = path.join(root, "storage");
    await bundle({ entryPoints: [fileURLToPath(new URL("./fixtures/retained-worker.ts", import.meta.url))], outfile: worker, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const child = fork(worker, [storage], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Crash worker did not reach its committed response.")), 10000);
        child.once("message", () => { clearTimeout(timer); resolve(); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); if (code !== null) reject(new Error(`Crash worker exited early: ${code}`)); });
      });
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
      const store = await FileRetainedExecutionStoreV1.open(storage); stores.push(store);
      const recovered = await store.recover(); expect(recovered).toHaveLength(1);
      expect(recovered[0].receipts.one).toBeDefined(); expect(recovered[0].owner).toBeNull();
      const owner = await store.claim({ executionId: "crash-run" }, "attempt-2", { node: "22.19.0", unrelated: "allowed" });
      expect(owner.fence).toBe(2);
      const requestId = Object.keys(recovered[0].requests)[0];
      expect(await store.completeInput({ executionId: "crash-run" }, owner, requestId)).toEqual({ schemaVersion: 1, fields: {}, files: {} });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
  it("reuses builds and preserves UTC ISO names across new invocations/configurations", async () => {
    const f = await setup(); f.advance(1000);
    expect(await f.store.publishBuild(f.input)).toEqual(f.build);
    expect(await readdir(path.join(f.root, "builds"))).toEqual([`20260907T123456.789Z-${f.build.buildSha256.slice(0, 16)}`]);
    await f.store.createRun({ ...ref, executionId: "run-2" }, { ...f.binding, id: "binding-2", invocation: { city: "Paris" }, runConfiguration: { id: "config-v2" } });
    expect(await readdir(path.join(f.root, "builds"))).toHaveLength(1);
    const changed = await f.store.publishBuild({ ...f.input, inputSha256: "b".repeat(64), files: { "entry.mjs": Buffer.from("export const value = 2;") } });
    expect(changed.buildSha256).not.toBe(f.build.buildSha256);
    expect((await f.store.read(ref))?.binding).toEqual(f.binding);
    expect((await f.store.readBuild(f.build.buildSha256)).files["entry.mjs"].toString()).toContain("value = 1");
  });
  it("pins one definition and original expiry; changed replay options fail", async () => {
    const f = await setup(), request = await f.open(); f.advance(1000);
    expect(await f.open()).toEqual(request);
    await expect(f.store.openRequest(ref, f.owner, { stepId: "ask", title: "Your trip", form, expiresAfter: "2h" })).rejects.toThrow("binding-mismatch");
    await expect(f.store.openRequest(ref, f.owner, { stepId: "second", title: "Other", form, expiresAfter: "1h" })).rejects.toThrow("request-closed");
  });
  it("accepts exactly one competing response and persists one receipt and resume intent", async () => {
    const f = await setup(), request = await f.open();
    const results = await Promise.allSettled(["one", "two"].map(submissionId => f.store.submit(ref, request.requestId, { submissionId, expectedRevision: 1, response: answer() }, "developer", identity)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const state = await f.store.read(ref);
    expect(state?.status).toBe("resume_queued"); expect(Object.keys(state!.receipts)).toHaveLength(1); expect(Object.keys(state!.commands)).toHaveLength(1);
    await expect(f.store.claim(ref, "attempt-2", requirements)).rejects.toThrow("owner-active");
    await f.store.release(ref, f.owner); // A late release must not overwrite the accepted answer with waiting.
    expect((await f.store.read(ref))?.status).toBe("resume_queued");
    const owner = await f.store.claim(ref, "attempt-2", requirements);
    expect(owner.fence).toBe(2);
    await expect(f.store.release(ref, f.owner)).rejects.toThrow("stale-owner");
    expect(await f.store.completeInput(ref, owner, request.requestId)).toEqual(answer());
    await f.store.finish(ref, owner, "complete");
  });
  it("returns the same immutable receipt after cancellation and expiry, but rejects changed retry bodies", async () => {
    const f = await setup(), request = await f.open(), body = { submissionId: "one", expectedRevision: 1, response: answer() };
    const receipt = await f.store.submit(ref, request.requestId, body, "developer", identity);
    await f.store.cancel(ref); f.advance(86400000);
    expect(await f.store.submit(ref, request.requestId, body, "developer", identity)).toEqual(receipt);
    await expect(f.store.submit(ref, request.requestId, { ...body, expectedRevision: 2 }, "developer", identity)).rejects.toThrow("submission-reused");
    await expect(f.store.submit(ref, request.requestId, { ...body, response: answer("Paris") }, "developer", identity)).rejects.toThrow("submission-reused");
    await f.store.release(ref, f.owner);
    await expect(f.store.claim(ref, "attempt-2", requirements)).rejects.toThrow("run-closed");
    await f.store.deleteRetainedControlData(ref);
    expect(await f.store.submit(ref, request.requestId, body, "developer", identity)).toEqual(receipt);
  });
  it("rejects cancellation winners, stale revisions, and the exact deadline", async () => {
    const f = await setup(), request = await f.open();
    await expect(f.store.submit(ref, request.requestId, { submissionId: "one", expectedRevision: 2, response: answer() }, "developer", identity)).rejects.toThrow("stale-revision");
    f.advance(3600000);
    await expect(f.store.submit(ref, request.requestId, { submissionId: "one", expectedRevision: 1, response: answer() }, "developer", identity)).rejects.toThrow("request-closed");
    expect(await f.store.expire(ref, request.requestId)).toBe(true); expect(await f.store.expire(ref, request.requestId)).toBe(false);
    expect((await f.store.read(ref))?.requests[request.requestId].status).toBe("expired");
  });
  it("checks expiry again after an async retained validator completes", async () => {
    const f = await setup(), request = await f.open();
    await expect(f.store.submit(ref, request.requestId, { submissionId: "one", expectedRevision: 1, response: answer() }, "developer", async (_r, value) => { f.advance(3600000); return value; })).rejects.toThrow("request-closed");
    expect(Object.keys((await f.store.read(ref))!.receipts)).toHaveLength(0);
  });
  it("lets cancellation win while a validator is waiting, then rejects the late commit", async () => {
    const f = await setup(), request = await f.open();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const submission = f.store.submit(ref, request.requestId, { submissionId: "one", expectedRevision: 1, response: answer() }, "developer", async (_request, value) => { entered(); await wait; return value; });
    const outcome = expect(submission).rejects.toThrow("run-closed");
    await ready; await f.store.cancel(ref); release(); await outcome;
    expect(Object.keys((await f.store.read(ref))!.receipts)).toHaveLength(0);
  });
  it("pins the submission Run before async validation can mutate the caller reference", async () => {
    const f = await setup(), request = await f.open(), mutable = { ...ref };
    const receipt = await f.store.submit(mutable, request.requestId, { submissionId: "one", expectedRevision: 1, response: answer() }, "developer", async (_request, value) => {
      mutable.executionId = "different-run"; return value;
    });
    expect((await f.store.read(ref))?.receipts.one).toEqual(receipt);
    expect(await f.store.read(mutable)).toBeUndefined();
  });
  it("retains the whole accepted transition across restart and does not repeat completed input", async () => {
    const f = await setup(), request = await f.open();
    const receipt = await f.store.submit(ref, request.requestId, { submissionId: "one", expectedRevision: 1, response: answer() }, "developer", identity);
    await f.store.release(ref, f.owner); await f.store.close();
    const resumed = await FileRetainedExecutionStoreV1.open(f.root); stores.push(resumed);
    const queue = await resumed.recover(); expect(queue).toHaveLength(1); expect(queue[0].receipts.one).toEqual(receipt);
    const owner = await resumed.claim(ref, "attempt-2", requirements);
    expect(await resumed.completeInput(ref, owner, request.requestId)).toEqual(answer());
    expect(await resumed.completeInput(ref, owner, request.requestId)).toEqual(answer());
    await resumed.release(ref, owner);
    expect(await resumed.recover()).toHaveLength(1);
  });
  it("does not steal a live worker on recovery or permit a second writer", async () => {
    const f = await setup(); expect(await f.store.recover()).toEqual([]);
    await expect(FileRetainedExecutionStoreV1.open(f.root)).rejects.toThrow("exclusive writer ownership");
    expect((await f.store.read(ref))?.owner).toEqual(f.owner);
  });
  it("protects live and shared terminal references; rechecks stale cleanup previews", async () => {
    const f = await setup();
    await expect(f.store.deleteRetainedControlData(ref)).rejects.toThrow("owner-active");
    await f.store.finish(ref, f.owner, "complete"); expect((await f.store.previewBuildCleanup()).builds).toEqual([]);
    await f.store.deleteRetainedControlData(ref);
    expect((await f.store.read(ref))?.binding.invocation).toBeNull();
    const preview = await f.store.previewBuildCleanup(); expect(preview.builds).toHaveLength(1);
    const other = { ...ref, executionId: "run-2" };
    await f.store.createRun(other, { ...f.binding, id: "binding-2" });
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([]);
    const owner = await f.store.claim(other, "other-attempt", requirements);
    await f.store.finish(other, owner, "complete");
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([]);
    await f.store.deleteRetainedControlData(other);
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([f.build.buildSha256]);
    await expect(f.store.readBuild(f.build.buildSha256)).rejects.toThrow("missing-build");
    await expect(f.store.createRun(ref, f.binding)).rejects.toThrow("binding-mismatch");
  });
  it("rejects corrupt executable bytes and incompatible host requirements without substituting current code", async () => {
    const f = await setup(); await f.store.release(ref, f.owner);
    await expect(f.store.claim(ref, "attempt-2", { node: "changed" })).rejects.toThrow("binding-mismatch");
    const directory = (await readdir(path.join(f.root, "builds")))[0];
    await writeFile(path.join(f.root, "builds", directory, "entry.mjs"), "corrupt");
    await expect(f.store.claim(ref, "attempt-2", requirements)).rejects.toThrow(/corrupt/);
    expect((await f.store.read(ref))?.owner).toBeNull();
  });
  it("rejects malformed or cross-bound stored records rather than treating them as absent", async () => {
    const f = await setup(), request = await f.open();
    const filename = path.join(f.root, "runs", `${runKey(ref)}.json`), state = JSON.parse(await readFile(filename, "utf8"));
    state.requests[request.requestId].definition.executableBindingId = "wrong";
    expect(() => validateRetainedRunControl(state)).toThrow(/binding differs/);
    await writeFile(filename, JSON.stringify(state));
    await expect(f.store.read(ref)).rejects.toThrow(/binding differs/);
  });
  it.each(["../escape.mjs", "credentials.json", ".env", "dir/../../escape", "dir\\secret", "__proto__"])("rejects unsafe retained path %s", async name => {
    const f = await setup();
    await expect(f.store.publishBuild({ ...f.input, files: { [name]: Buffer.from("bad"), "entry.mjs": Buffer.from("ok") } })).rejects.toThrow();
  });
});
