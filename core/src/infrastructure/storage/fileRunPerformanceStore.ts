import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  RunPerformanceReader,
  RunPerformanceWriteStore,
} from "../../application/runLifecycle.ts";

export class PerformanceAttemptConflictError extends Error {
  constructor(readonly key: string) {
    super(`Performance attempt already exists with different content: ${key}`);
    this.name = "PerformanceAttemptConflictError";
  }
}

export class PerformanceSummaryConflictError extends Error {
  constructor(readonly key: string) {
    super(`Performance summary already exists with different content: ${key}`);
    this.name = "PerformanceSummaryConflictError";
  }
}

export interface FileRunPerformanceStoreOptions<TAttempt, TSummary, TQuery> {
  root: string;
  attemptFileName(record: TAttempt): string;
  encodeAttempt(record: TAttempt): unknown;
  encodeSummary?(summary: TSummary): unknown;
  decodeSummary?(value: unknown): TSummary;
  matchesQuery(query: TQuery): boolean;
  attemptsDirectory?: string;
  summaryFileName?: string;
}

export class FileRunPerformanceStore<TAttempt, TSummary, TQuery>
implements RunPerformanceWriteStore<TAttempt, TSummary>, RunPerformanceReader<TSummary, TQuery> {
  readonly root: string;
  private readonly attemptsDirectory: string;
  private readonly summaryFileName: string;
  private readonly attemptFileName: (record: TAttempt) => string;
  private readonly encodeAttempt: (record: TAttempt) => unknown;
  private readonly encodeSummary: (summary: TSummary) => unknown;
  private readonly decodeSummary: (value: unknown) => TSummary;
  private readonly matchesQuery: (query: TQuery) => boolean;

  constructor(options: FileRunPerformanceStoreOptions<TAttempt, TSummary, TQuery>) {
    this.root = path.resolve(options.root);
    this.attemptsDirectory = options.attemptsDirectory ?? path.join("performance", "attempts");
    this.summaryFileName = options.summaryFileName ?? "performance.json";
    assertSafeRelativePath(this.attemptsDirectory, "Performance attempts directory");
    assertSafeRelativePath(this.summaryFileName, "Performance summary filename");
    this.attemptFileName = options.attemptFileName;
    this.encodeAttempt = options.encodeAttempt;
    this.encodeSummary = options.encodeSummary ?? identity;
    this.decodeSummary = options.decodeSummary ?? unsafeIdentity;
    this.matchesQuery = options.matchesQuery;
  }

  async recordAttempt(record: TAttempt): Promise<void> {
    const key = this.attemptFileName(record);
    assertSafeFileName(key, "Performance attempt filename");
    await this.createOrVerify(
      path.join(this.root, this.attemptsDirectory, key),
      serialize(this.encodeAttempt(record)),
      () => new PerformanceAttemptConflictError(key),
    );
  }

  async complete(summary: TSummary): Promise<void> {
    await this.createOrVerify(
      path.join(this.root, this.summaryFileName),
      serialize(this.encodeSummary(summary)),
      () => new PerformanceSummaryConflictError(this.summaryFileName),
    );
  }

  async get(query: TQuery): Promise<TSummary | undefined> {
    if (!this.matchesQuery(query)) return undefined;
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(this.root, this.summaryFileName), "utf8"),
      ) as unknown;
      return this.decodeSummary(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async createOrVerify(
    destinationPath: string,
    serialized: string,
    conflict: () => Error,
  ): Promise<void> {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, serialized, "utf8");
      try {
        await fs.link(temporaryPath, destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await fs.readFile(destinationPath, "utf8") !== serialized) throw conflict();
      }
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function assertSafeFileName(value: string, label: string): void {
  if (value.includes(path.sep) || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} must be a single path segment.`);
  }
  assertSafeRelativePath(value, label);
}

function assertSafeRelativePath(value: string, label: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || path.isAbsolute(value)
    || value.includes("\0")
    || value.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
}

function identity<T>(value: T): T {
  return value;
}

function unsafeIdentity<T>(value: unknown): T {
  return value as T;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
