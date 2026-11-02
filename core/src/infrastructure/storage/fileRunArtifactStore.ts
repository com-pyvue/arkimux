import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunArtifactStore, StoredArtifact } from "../../application/runLifecycle.ts";

function assertSafePathPart(value: string, label: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || path.isAbsolute(value)
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be a single non-empty path segment: ${JSON.stringify(value)}.`);
  }
}

export class FileRunArtifactStore implements RunArtifactStore {
  readonly root: string;
  private readonly baseRoot: string;
  private readonly streamWrites = new Map<string, Promise<void>>();

  constructor(root: string, baseRoot = root) {
    this.root = path.resolve(root);
    this.baseRoot = path.resolve(baseRoot);
  }

  scope(...segments: string[]): RunArtifactStore {
    for (const segment of segments) assertSafePathPart(segment, "Artifact scope segment");
    return new FileRunArtifactStore(path.join(this.root, ...segments), this.baseRoot);
  }

  async writeJson<T>(name: string, value: T): Promise<StoredArtifact> {
    return this.write(name, `${JSON.stringify(value, null, 2)}\n`, "application/json");
  }

  async writeText(name: string, value: string): Promise<StoredArtifact> {
    return this.write(
      name,
      value.endsWith("\n") ? value : `${value}\n`,
      "text/plain; charset=utf-8",
    );
  }

  private async write(name: string, value: string, mediaType: string): Promise<StoredArtifact> {
    const filePath = this.filePath(name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, value, "utf8");
    return {
      key: path.relative(this.baseRoot, filePath).split(path.sep).join("/"),
      mediaType,
      sizeBytes: Buffer.byteLength(value),
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }

  async appendRecord<T>(name: string, sequence: number, value: T): Promise<void> {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error("Artifact stream sequence must be a non-negative integer.");
    }
    const filePath = this.filePath(name);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Artifact stream records must be JSON-serializable values.");
    }
    const previous = this.streamWrites.get(filePath) ?? Promise.resolve();
    const write = previous.then(() => this.writeRecord(filePath, name, sequence, serialized));
    this.streamWrites.set(filePath, write);
    try {
      await write;
    } finally {
      if (this.streamWrites.get(filePath) === write) this.streamWrites.delete(filePath);
    }
  }

  private async writeRecord(
    filePath: string,
    name: string,
    sequence: number,
    serialized: string,
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existing = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const records = existing.length === 0
      ? []
      : existing.endsWith("\n")
        ? existing.slice(0, -1).split("\n")
        : (() => {
            throw new ArtifactStreamCorruptError(name);
          })();
    if (sequence < records.length) {
      if (records[sequence] === serialized) return;
      throw new ArtifactStreamSequenceConflictError(name, sequence);
    }
    if (sequence > records.length) {
      throw new ArtifactStreamSequenceGapError(name, records.length, sequence);
    }
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${existing}${serialized}\n`, "utf8");
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private filePath(name: string): string {
    assertSafePathPart(name, "Artifact name");
    return path.join(this.root, name);
  }
}

export class ArtifactStreamSequenceConflictError extends Error {
  constructor(readonly name: string, readonly sequence: number) {
    super(`Artifact stream ${name} sequence ${sequence} already contains different content.`);
    this.name = "ArtifactStreamSequenceConflictError";
  }
}

export class ArtifactStreamSequenceGapError extends Error {
  constructor(
    readonly name: string,
    readonly expectedSequence: number,
    readonly receivedSequence: number,
  ) {
    super(`Artifact stream ${name} expected sequence ${expectedSequence}, received ${receivedSequence}.`);
    this.name = "ArtifactStreamSequenceGapError";
  }
}

export class ArtifactStreamCorruptError extends Error {
  constructor(readonly name: string) {
    super(`Artifact stream ${name} is not a newline-terminated JSON Lines file.`);
    this.name = "ArtifactStreamCorruptError";
  }
}
