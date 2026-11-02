import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_RECORDS,
  LocalFrameworkDiagnostics,
} from "../../local/src/localFrameworkDiagnostics.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("Local framework diagnostics", () => {
  it("persists a fatal diagnostic synchronously before process exit", async () => {
    const root = await fixtureRoot(), diagnostics = new LocalFrameworkDiagnostics({ projectRoot: root });
    const record = diagnostics.recordFatal({ arkimuxVersion: "0.1.0", component: "local-server", operation: "process",
      error: new Error("uncaught internal failure") });
    const file = path.join(root, ".arkimux/local/diagnostics", `${record.diagnosticId}.json`);
    expect(JSON.parse(await readFile(file, "utf8")).error.message).toBe("uncaught internal failure");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await diagnostics.list()).toHaveLength(1);
  });
  it("keeps a full private local record and exposes a metadata-only summary", async () => {
    const root = await fixtureRoot();
    const diagnostics = new LocalFrameworkDiagnostics({ projectRoot: root });
    const cause = new Error("socket failed");
    const record = await diagnostics.record({ arkimuxVersion: "0.1.0", component: "local-server",
      operation: "resource-cleanup",
      error: new Error("cleanup failed", { cause }) });
    expect(record.error).toMatchObject({ name: "Error", message: "cleanup failed", cause: { message: "socket failed" } });
    expect(record.error.stack).toContain("cleanup failed");
    expect(await diagnostics.list()).toEqual([{ schemaVersion: 1, diagnosticId: record.diagnosticId,
      recordedAt: record.recordedAt, arkimuxVersion: "0.1.0", component: "local-server",
      operation: "resource-cleanup", }]);
    expect(await diagnostics.get(record.diagnosticId)).toEqual(record);

    const directory = path.join(root, ".arkimux/local/diagnostics");
    const file = path.join(directory, `${record.diagnosticId}.json`);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(await readFile(file))).toBeLessThanOrEqual(256 * 1_024);
  });

  it("caps records, physically removes expired files, and supports explicit deletion", async () => {
    const root = await fixtureRoot();
    let now = new Date("2026-09-21T00:00:00.000Z");
    const diagnostics = new LocalFrameworkDiagnostics({ projectRoot: root, now: () => now });
    for (let index = 0; index < LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_RECORDS + 2; index += 1) {
      now = new Date(now.getTime() + 1_000);
      await diagnostics.record({ arkimuxVersion: "0.1.0", component: "telemetry", operation: `flush-${index}`,
        error: new Error(`failure ${index}`) });
    }
    expect(await diagnostics.list()).toHaveLength(LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_RECORDS);
    const newest = (await diagnostics.list())[0]!;
    await diagnostics.delete(newest.diagnosticId);
    expect(await diagnostics.get(newest.diagnosticId)).toBeUndefined();
    now = new Date("2026-09-29T00:00:00.000Z");
    expect(await diagnostics.list()).toEqual([]);
    expect(await readdir(path.join(root, ".arkimux/local/diagnostics"))).toEqual([]);
    await diagnostics.clear();
  });

  it("does not invoke arbitrary objects while serializing a non-Error failure", async () => {
    const root = await fixtureRoot();
    let invoked = false;
    const value = { toString() { invoked = true; return "secret"; } };
    const record = await new LocalFrameworkDiagnostics({ projectRoot: root }).record({ arkimuxVersion: "0.1.0",
      component: "local-store", operation: "open", error: value });
    expect(invoked).toBe(false);
    expect(record.error).toEqual({ name: "NonError", message: "Non-Error value of type object." });
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-diagnostics-"));
  roots.push(root);
  return root;
}
