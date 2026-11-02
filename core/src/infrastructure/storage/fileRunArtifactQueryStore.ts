import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { RunArtifactQueryStore } from "../../application/runQueries.ts";
import type { StoredArtifact } from "../../application/runLifecycle.ts";

export class FileRunArtifactQueryStore implements RunArtifactQueryStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async list(prefix = ""): Promise<StoredArtifact[]> {
    const root = this.resolveKey(prefix, true);
    const files = await findFiles(root);
    return Promise.all(files.map(async (filePath) => {
      const value = await fs.readFile(filePath);
      return {
        key: path.relative(this.root, filePath).split(path.sep).join("/"),
        mediaType: mediaTypeFor(filePath),
        sizeBytes: value.byteLength,
        sha256: createHash("sha256").update(value).digest("hex"),
      };
    }));
  }

  async readText(key: string): Promise<string | undefined> {
    const value = await this.readBytes(key);
    return value === undefined ? undefined : new TextDecoder().decode(value);
  }

  async readBytes(key: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile(this.resolveKey(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readJson(key: string): Promise<unknown | undefined> {
    const value = await this.readText(key);
    return value === undefined ? undefined : JSON.parse(value) as unknown;
  }

  private resolveKey(key: string, allowEmpty = false): string {
    if ((!allowEmpty && key.length === 0) || path.isAbsolute(key) || key.includes("\0")) {
      throw new Error("Artifact query key must be a safe relative path.");
    }
    const resolved = path.resolve(this.root, key || ".");
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Artifact query key escapes the run root.");
    }
    return resolved;
  }
}

function mediaTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".json": return "application/json";
    case ".jsonl": return "application/x-ndjson";
    case ".html": return "text/html; charset=utf-8";
    case ".md": return "text/markdown; charset=utf-8";
    case ".txt":
    case ".log": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function findFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return findFiles(filePath);
    return entry.isFile() ? [filePath] : [];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}
