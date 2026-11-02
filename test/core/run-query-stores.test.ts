import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FilePublishedResultQueryStore,
  FilePublishedResultStore,
  FileRunArtifactQueryStore,
  FileRunArtifactStore,
  FileRunCatalogStore,
} from "../../core/src/index.ts";

async function root(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "run-query-"));
}

describe("file run query stores", () => {
  it("ignores unsupported historical run manifest schemas", async () => {
    const directory = await root();
    const historicalState = path.join(directory, "historical", "state");
    await mkdir(historicalState, { recursive: true });
    await writeFile(path.join(historicalState, "run-manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      commit: "abc123",
    })}\n`, "utf8");

    const catalog = new FileRunCatalogStore(directory);
    await expect(catalog.list({})).resolves.toEqual({ items: [] });
    await expect(catalog.get({ executionId: "historical" })).resolves.toBeUndefined();
  });

  it("pages and filters schema-v3 run manifests", async () => {
    const directory = await root();
    const state = path.join(directory, "target", "run-01", "state");
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, "run-manifest.json"), `${JSON.stringify({
      schemaVersion: 3,
      runRef: { executionId: "run-01" },
      workflow: { kind: "fixture.workflow", version: 1 },
      target: { kind: "git-commit", identity: { repository: "fixture", commit: "abc123" } },
      createdAt: "2026-08-05T12:00:00.000Z",
      actor: { userId: "yuryp", roleId: "runner" },
      runConfiguration: { configurationId: "fixture-v1", contentHash: "a".repeat(64) },
    })}\n`, "utf8");
    await writeFile(path.join(state, "run-status.json"), `${JSON.stringify({
      status: "complete",
      updatedAt: "2026-08-05T12:01:00.000Z",
    })}\n`, "utf8");
    const page = await new FileRunCatalogStore(directory).list({ userId: "yuryp", pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      runRef: { executionId: "run-01" },
      status: { status: "complete" },
      runConfiguration: { configurationId: "fixture-v1" },
    });
    const catalog = new FileRunCatalogStore(directory);
    expect(await catalog.get({ executionId: "run-01" })).toMatchObject({ actor: { userId: "yuryp" } });
    expect((await catalog.list({
      target: { kind: "git-commit" },
      createdAtOrAfter: "2026-08-05T12:00:00.000Z",
      createdBefore: "2026-08-05T12:00:00.001Z",
    })).items).toHaveLength(1);
    expect((await catalog.list({
      target: { kind: "git-commit", identity: { repository: "other" } },
    })).items).toHaveLength(0);
    await catalog.archive({ executionId: "run-01" }, "2026-08-05T13:00:00.000Z");
    expect((await catalog.list({})).items).toHaveLength(0);
    expect((await catalog.list({ lifecycleStatus: "archived" })).items[0]).toMatchObject({
      lifecycleStatus: "archived",
      archivedAt: "2026-08-05T13:00:00.000Z",
    });
    await catalog.restore({ executionId: "run-01" }, "2026-08-05T14:00:00.000Z");
    expect((await catalog.list({})).items[0]).toMatchObject({ lifecycleStatus: "active" });
  });

  it("lists and reads run artifacts without escaping the run root", async () => {
    const directory = await root();
    const writer = new FileRunArtifactStore(path.join(directory, "state"), directory);
    await writer.writeJson("fixture.json", { accepted: true });
    const reader = new FileRunArtifactQueryStore(directory);
    expect(await reader.readJson("state/fixture.json")).toEqual({ accepted: true });
    expect((await reader.list("state"))[0]?.key).toBe("state/fixture.json");
    await expect(reader.readText("../outside")).rejects.toThrow("escapes the run root");
  });

  it("reads a published result only through its matching reference", async () => {
    const directory = await root();
    const runRef = { executionId: "run-01" };
    const writer = new FilePublishedResultStore({ root: directory, resultId: () => "result.json" });
    const ref = await writer.publish({
      envelopeSchemaVersion: 1,
      resultKind: "fixture.result",
      runRef,
      payload: { accepted: true },
    });
    const reader = new FilePublishedResultQueryStore({ root: directory, runRef });
    expect(await reader.list()).toEqual([ref]);
    expect(await reader.get(ref)).toMatchObject({ payload: { accepted: true } });
    await expect(reader.get({ ...ref, resultKind: "other.result" }))
      .rejects.toThrow("does not match");
    await expect(reader.get({ ...ref, runRef: { executionId: "run-02" } }))
      .rejects.toThrow("outside the query store run scope");
  });
});
