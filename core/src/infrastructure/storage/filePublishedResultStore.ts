import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  validatePublishedResultEnvelope,
  type PublishedResultEnvelope,
  type PublishedResultRef,
  type PublishedResultStore,
} from "../../application/publishedResult.ts";

export class PublishedResultAlreadyExistsError extends Error {
  constructor(readonly resultId: string) {
    super(`Published result already exists: ${resultId}`);
    this.name = "PublishedResultAlreadyExistsError";
  }
}

export interface FilePublishedResultStoreOptions {
  root: string;
  resultId(result: PublishedResultEnvelope): string;
}

export class FilePublishedResultStore implements PublishedResultStore {
  readonly root: string;
  private readonly resultId: FilePublishedResultStoreOptions["resultId"];

  constructor(options: FilePublishedResultStoreOptions) {
    this.root = path.resolve(options.root);
    this.resultId = options.resultId;
  }

  async publish<TPayload>(result: PublishedResultEnvelope<TPayload>): Promise<PublishedResultRef> {
    const validated = validatePublishedResultEnvelope(result);
    const resultId = this.resultId(validated);
    assertSafeFileName(resultId);
    await fs.mkdir(this.root, { recursive: true });
    const destination = path.join(this.root, resultId);
    const temporary = path.join(this.root, `.${resultId}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, serialize(validated), "utf8");
      await fs.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PublishedResultAlreadyExistsError(resultId);
      }
      throw error;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    return { runRef: validated.runRef, resultKind: validated.resultKind, resultId };
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

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
