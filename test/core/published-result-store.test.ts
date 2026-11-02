import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilePublishedResultStore,
  PublishedResultAlreadyExistsError,
} from "../../core/src/index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("generic file published-result store", () => {
  it("publishes an immutable generic envelope", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-result-"));
    directories.push(directory);
    const store = new FilePublishedResultStore({
      root: directory,
      resultId: () => "result.json",
    });
    const result = {
      envelopeSchemaVersion: 1 as const,
      resultKind: "fixture.result",
      runRef: { executionId: "fixture-run" },
      payload: { accepted: true },
    };

    await expect(store.publish(result)).resolves.toEqual({
      runRef: result.runRef,
      resultKind: result.resultKind,
      resultId: "result.json",
    });
    await expect(store.publish(result)).rejects.toBeInstanceOf(PublishedResultAlreadyExistsError);
  });
});
