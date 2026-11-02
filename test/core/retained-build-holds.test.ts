import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import type { ExecutableBindingV1 } from "../../core/src/application/retainedExecution.ts";

const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
const hostRequirements = { node: "22.19.0" };
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "retained-build-holds-")); roots.push(root);
  const store = await FileRetainedExecutionStoreV1.open(root); stores.push(store);
  const publish = (value: number) => store.publishBuild({ inputSha256: String(value).repeat(64), entryPoint: "entry.mjs",
    files: { "entry.mjs": Buffer.from(`export const value = ${value};`) }, hostRequirements });
  const build = await publish(1);
  const binding: ExecutableBindingV1 = { id: "binding-1", buildSha256: build.buildSha256, workflow: { id: "weather" },
    invocation: {}, runConfiguration: {}, executionProfile: {}, nonSecretEnvironment: {}, credentialReferences: [], hostRequirements };
  return { root, store, build, binding, publish };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("prepared workflow build holds", () => {
  it("protects both current and pending candidates before either has a Run", async () => {
    const f = await setup(), pending = await f.publish(2), discarded = await f.publish(3);
    const releaseCurrent = await f.store.holdBuild(f.build.buildSha256);
    const releasePending = await f.store.holdBuild(pending.buildSha256);
    const preview = await f.store.previewBuildCleanup();
    expect(preview.builds.map(build => build.buildSha256)).toEqual([discarded.buildSha256]);
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([discarded.buildSha256]);
    expect((await f.store.readBuild(f.build.buildSha256)).manifest).toEqual(f.build);
    expect((await f.store.readBuild(pending.buildSha256)).manifest).toEqual(pending);
    await releaseCurrent();
    expect((await f.store.previewBuildCleanup()).builds.map(build => build.buildSha256)).toEqual([f.build.buildSha256]);
    await releasePending();
    expect((await f.store.previewBuildCleanup()).builds).toHaveLength(2);
  });

  it("counts independent holds and makes concurrent repeated release idempotent", async () => {
    const f = await setup();
    const first = await f.store.holdBuild(f.build.buildSha256), second = await f.store.holdBuild(f.build.buildSha256);
    await Promise.all([first(), first(), first()]);
    expect((await f.store.previewBuildCleanup()).builds).toEqual([]);
    await second(); await first(); await second();
    expect((await f.store.previewBuildCleanup()).builds.map(build => build.buildSha256)).toEqual([f.build.buildSha256]);
  });

  it("rechecks stale cleanup previews against holds acquired afterward", async () => {
    const f = await setup(), stalePreview = await f.store.previewBuildCleanup();
    const release = await f.store.holdBuild(f.build.buildSha256);
    expect(await f.store.cleanUnusedBuilds(stalePreview)).toEqual([]);
    await release();
    expect(await f.store.cleanUnusedBuilds(stalePreview)).toEqual([f.build.buildSha256]);
    await expect(f.store.readBuild(f.build.buildSha256)).rejects.toThrow("missing-build");
  });

  it("serializes an in-flight acquisition before competing cleanup", async () => {
    const f = await setup(), preview = await f.store.previewBuildCleanup();
    const acquisition = f.store.holdBuild(f.build.buildSha256);
    const cleanup = f.store.cleanUnusedBuilds(preview);
    const release = await acquisition;
    expect(await cleanup).toEqual([]);
    await release();
  });

  it("rejects acquisition if competing cleanup removed the build first", async () => {
    const f = await setup(), preview = await f.store.previewBuildCleanup();
    const cleanup = f.store.cleanUnusedBuilds(preview);
    const acquisition = expect(f.store.holdBuild(f.build.buildSha256)).rejects.toThrow("missing-build");
    expect(await cleanup).toEqual([f.build.buildSha256]);
    await acquisition;
  });

  it("keeps persisted Run pins after release, including terminal Runs until explicit data deletion", async () => {
    const f = await setup(), preview = await f.store.previewBuildCleanup();
    const release = await f.store.holdBuild(f.build.buildSha256), ref = { executionId: "run-1" };
    await f.store.createRun(ref, f.binding);
    await release();
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([]);
    await f.store.cancel(ref);
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([]);
    await f.store.deleteRetainedControlData(ref);
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([f.build.buildSha256]);
  });

  it("keeps a candidate hold after the last persisted Run pin is explicitly deleted", async () => {
    const f = await setup(), preview = await f.store.previewBuildCleanup();
    const release = await f.store.holdBuild(f.build.buildSha256), ref = { executionId: "run-1" };
    await f.store.createRun(ref, f.binding);
    await f.store.cancel(ref);
    await f.store.deleteRetainedControlData(ref);
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([]);
    await release();
    expect(await f.store.cleanUnusedBuilds(preview)).toEqual([f.build.buildSha256]);
  });

  it("rejects missing or invalid build IDs and corrupt bytes without adding a hold", async () => {
    const f = await setup();
    await expect(f.store.holdBuild("f".repeat(64))).rejects.toThrow("missing-build");
    await expect(f.store.holdBuild("../build")).rejects.toThrow();
    const directory = (await readdir(path.join(f.root, "builds")))[0];
    await writeFile(path.join(f.root, "builds", directory, "entry.mjs"), "corrupt");
    await expect(f.store.holdBuild(f.build.buildSha256)).rejects.toThrow("corrupt");
    expect((await f.store.previewBuildCleanup()).builds.map(build => build.buildSha256)).toEqual([f.build.buildSha256]);
  });

  it("does not persist a hold beyond the owning store lifetime", async () => {
    const f = await setup();
    await f.store.holdBuild(f.build.buildSha256);
    expect((await f.store.previewBuildCleanup()).builds).toEqual([]);
    await f.store.close();
    const reopened = await FileRetainedExecutionStoreV1.open(f.root); stores.push(reopened);
    const preview = await reopened.previewBuildCleanup();
    expect(preview.builds.map(build => build.buildSha256)).toEqual([f.build.buildSha256]);
    expect(await reopened.cleanUnusedBuilds(preview)).toEqual([f.build.buildSha256]);
  });
});
