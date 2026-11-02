import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRunCorrectionLinks } from "../../local/src/fileRunCorrectionLinks.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("File Run correction links", () => {
  it("persists immutable forward and reverse Run lineage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-corrections-"));
    roots.push(root);
    const store = new FileRunCorrectionLinks(root);
    const link = {
      schemaVersion: 1 as const,
      priorRunRef: { executionId: "original-run" },
      correctedRunRef: { executionId: "corrected-run" },
      createdAt: "2026-09-18T12:00:00.000Z",
    };

    await expect(store.create(link)).resolves.toEqual(link);
    await expect(store.create({ ...link, createdAt: "2026-09-18T12:01:00.000Z" })).resolves.toEqual(link);
    await expect(new FileRunCorrectionLinks(root).getByCorrectedRun(link.correctedRunRef)).resolves.toEqual(link);
    await expect(store.listByPriorRun(link.priorRunRef)).resolves.toEqual([link]);
    await expect(store.listByPriorRun({ executionId: "unrelated-run" })).resolves.toEqual([]);
  });

  it("rejects changing a corrected Run's prior Run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-corrections-"));
    roots.push(root);
    const store = new FileRunCorrectionLinks(root);
    await store.create({ schemaVersion: 1, priorRunRef: { executionId: "original-one" },
      correctedRunRef: { executionId: "corrected-run" }, createdAt: "2026-09-18T12:00:00.000Z" });
    await expect(store.create({ schemaVersion: 1, priorRunRef: { executionId: "original-two" },
      correctedRunRef: { executionId: "corrected-run" }, createdAt: "2026-09-18T12:01:00.000Z" }))
      .rejects.toThrow("already has different correction lineage");
  });
});
