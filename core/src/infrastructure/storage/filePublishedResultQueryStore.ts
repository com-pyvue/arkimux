import { promises as fs } from "node:fs";
import path from "node:path";
import {
  validatePublishedResultEnvelope,
  type PublishedResultEnvelope,
  type PublishedResultRef,
} from "../../application/publishedResult.ts";
import type { PublishedResultQueryStore } from "../../application/runQueries.ts";
import { validateRunRef } from "../../domain/runIdentity.ts";

export class FilePublishedResultQueryStore implements PublishedResultQueryStore {
  readonly root: string;
  readonly runRef: PublishedResultRef["runRef"];

  constructor(options: { root: string; runRef: PublishedResultRef["runRef"] }) {
    this.root = path.resolve(options.root);
    this.runRef = validateRunRef(options.runRef);
  }

  async list(): Promise<PublishedResultRef[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const refs = await Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (resultId) => {
      const result = await this.read(resultId);
      if (result.runRef.executionId !== this.runRef.executionId) {
        throw new Error(`Published result ${resultId} belongs to a different run.`);
      }
      return { runRef: this.runRef, resultKind: result.resultKind, resultId };
    }));
    return refs;
  }

  async get(ref: PublishedResultRef): Promise<PublishedResultEnvelope | undefined> {
    const requestedRun = validateRunRef(ref.runRef);
    if (requestedRun.executionId !== this.runRef.executionId) {
      throw new Error("Published result reference is outside the query store run scope.");
    }
    assertSafeFileName(ref.resultId);
    let result: PublishedResultEnvelope;
    try {
      result = await this.read(ref.resultId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (
      result.runRef.executionId !== requestedRun.executionId
      || result.resultKind !== ref.resultKind
    ) {
      throw new Error("Published result reference does not match the stored envelope.");
    }
    return result;
  }

  private async read(resultId: string): Promise<PublishedResultEnvelope> {
    assertSafeFileName(resultId);
    const value = JSON.parse(await fs.readFile(path.join(this.root, resultId), "utf8")) as unknown;
    return validatePublishedResultEnvelope(value);
  }
}

function assertSafeFileName(value: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || path.isAbsolute(value)
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error("Published result ID must be a safe file name.");
  }
}
