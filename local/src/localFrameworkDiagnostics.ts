import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdirSync, chmodSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolveLocalFileStorePaths } from "./localStorePaths.ts";
import { serializeError, type SerializedLocalError } from "../../core/src/application/errorDiagnostics.ts";
export { serializeError } from "../../core/src/application/errorDiagnostics.ts";

export const LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_RECORDS = 20;
export const LOCAL_FRAMEWORK_DIAGNOSTIC_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_BYTES = 256 * 1_024;

export interface LocalFrameworkDiagnosticSummary {
  schemaVersion: 1;
  diagnosticId: string;
  recordedAt: string;
  arkimuxVersion: string;
  component: "local-server" | "local-browser" | "local-store" | "workflow-registry" | "telemetry";
  operation: string;
}

export interface LocalFrameworkDiagnosticRecord extends LocalFrameworkDiagnosticSummary {
  runtime: { nodeVersion: string; platform: NodeJS.Platform; architecture: string };
  error: SerializedLocalError;
  truncated: boolean;
}

export interface LocalFrameworkDiagnosticInput {
  arkimuxVersion: string;
  component: LocalFrameworkDiagnosticSummary["component"];
  operation: string;
  error: unknown;
}

/** Full Local-only diagnostics. Records are never uploaded by this service. */
export class LocalFrameworkDiagnostics {
  readonly #root: string;
  readonly #now: () => Date;
  #operation: Promise<unknown> = Promise.resolve();

  constructor(options: { projectRoot: string; now?: () => Date }) {
    this.#root = resolveLocalFileStorePaths(options.projectRoot).diagnostics;
    this.#now = options.now ?? (() => new Date());
  }

  record(input: LocalFrameworkDiagnosticInput): Promise<LocalFrameworkDiagnosticRecord> {
    return this.#serialize(async () => {
      const diagnosticId = randomUUID();
      const record = fitRecord({
        schemaVersion: 1,
        diagnosticId,
        recordedAt: this.#now().toISOString(),
        arkimuxVersion: boundedToken(input.arkimuxVersion, "arkimuxVersion"),
        component: input.component,
        operation: boundedToken(input.operation, "operation"),
        runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
        error: serializeError(input.error),
        truncated: false,
      });
      await writePrivateJson(this.#file(diagnosticId), record);
      await this.#prune();
      return record;
    });
  }

  /** Emergency path for uncaughtExceptionMonitor. No promises or remote work:
   * Node must retain its normal fatal-exception behavior. */
  recordFatal(input: LocalFrameworkDiagnosticInput): LocalFrameworkDiagnosticRecord {
    const record = fitRecord({ schemaVersion: 1, diagnosticId: randomUUID(), recordedAt: this.#now().toISOString(),
      arkimuxVersion: boundedToken(input.arkimuxVersion, "arkimuxVersion"), component: input.component,
      operation: boundedToken(input.operation, "operation"),
      runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch }, error: serializeError(input.error), truncated: false });
    const source = JSON.stringify(record);
    if (Buffer.byteLength(source) > LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_BYTES) throw new Error("Diagnostic record exceeds 256 KiB.");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 }); chmodSync(this.#root, 0o700);
    const file = this.#file(record.diagnosticId), temporary = `${file}.tmp`;
    writeFileSync(temporary, source, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, file);
    const records = readdirSync(this.#root).filter(name => UUID_FILE.test(name)).flatMap(name => {
      try { return [validateRecord(JSON.parse(readFileSync(path.join(this.#root, name), "utf8")))]; } catch { return []; }
    }).sort(newestFirst);
    for (const [index, saved] of records.entries()) if (index >= LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_RECORDS || Date.parse(saved.recordedAt) < this.#now().getTime() - LOCAL_FRAMEWORK_DIAGNOSTIC_TTL_MS) unlinkSync(this.#file(saved.diagnosticId));
    return record;
  }

  list(): Promise<LocalFrameworkDiagnosticSummary[]> {
    return this.#serialize(async () => {
      await this.#prune();
      return (await this.#readAll()).sort(newestFirst).map(
        ({ runtime: _runtime, error: _error, truncated: _truncated, ...summary }) => summary,
      );
    });
  }

  get(diagnosticId: string): Promise<LocalFrameworkDiagnosticRecord | undefined> {
    return this.#serialize(async () => {
      validateDiagnosticId(diagnosticId);
      await this.#prune();
      return this.#read(diagnosticId);
    });
  }

  delete(diagnosticId: string): Promise<void> {
    return this.#serialize(async () => {
      validateDiagnosticId(diagnosticId);
      await rm(this.#file(diagnosticId), { force: true });
    });
  }

  clear(): Promise<void> {
    return this.#serialize(async () => { await rm(this.#root, { recursive: true, force: true }); });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#operation.catch(() => undefined).then(operation);
    this.#operation = work;
    return work;
  }

  #file(diagnosticId: string): string { return path.join(this.#root, `${diagnosticId}.json`); }

  async #read(diagnosticId: string): Promise<LocalFrameworkDiagnosticRecord | undefined> {
    try { return validateRecord(JSON.parse(await readFile(this.#file(diagnosticId), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await rm(this.#file(diagnosticId), { force: true });
      return undefined;
    }
  }

  async #readAll(): Promise<LocalFrameworkDiagnosticRecord[]> {
    let names: string[];
    try { names = await readdir(this.#root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records = await Promise.all(names.filter(name => UUID_FILE.test(name)).map(name => this.#read(name.slice(0, -5))));
    return records.filter((record): record is LocalFrameworkDiagnosticRecord => record !== undefined);
  }

  async #prune(): Promise<void> {
    const records = (await this.#readAll()).sort(newestFirst);
    const oldest = this.#now().getTime() - LOCAL_FRAMEWORK_DIAGNOSTIC_TTL_MS;
    const expired = records.filter((record, index) => Date.parse(record.recordedAt) < oldest || index >= LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_RECORDS);
    await Promise.all(expired.map(record => rm(this.#file(record.diagnosticId), { force: true })));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_FILE = /^[0-9a-f-]{36}\.json$/i;
function validateDiagnosticId(value: string): void { if (!UUID.test(value)) throw new Error("Diagnostic ID is invalid."); }
function boundedToken(value: string, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-z][0-9a-z.+_-]{0,79}$/i.test(value)) throw new Error(`${label} must be a bounded token.`);
  return value;
}
function newestFirst(a: LocalFrameworkDiagnosticRecord, b: LocalFrameworkDiagnosticRecord): number {
  return Date.parse(b.recordedAt) - Date.parse(a.recordedAt);
}

function clip(value: string, max: number): string {
  const suffix = "\n[truncated]";
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - suffix.length))}${suffix.slice(0, max)}`;
}

function fitRecord(record: LocalFrameworkDiagnosticRecord): LocalFrameworkDiagnosticRecord {
  record.truncated ||= record.error.truncated === true;
  if (Buffer.byteLength(JSON.stringify(record), "utf8") <= LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_BYTES) return record;
  const reduced: LocalFrameworkDiagnosticRecord = { ...record, error: {
    name: record.error.name,
    message: clip(record.error.message, 16 * 1_024),
    ...(record.error.stack ? { stack: clip(record.error.stack, 32 * 1_024) } : {}),
  }, truncated: true };
  return reduced;
}

function validateRecord(value: unknown): LocalFrameworkDiagnosticRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Diagnostic record is invalid.");
  const record = value as LocalFrameworkDiagnosticRecord;
  validateDiagnosticId(record.diagnosticId);
  if (record.schemaVersion !== 1 || !Number.isFinite(Date.parse(record.recordedAt)) || !record.error
    || typeof record.error.name !== "string" || typeof record.error.message !== "string"
    || !record.runtime || typeof record.runtime.nodeVersion !== "string" || typeof record.truncated !== "boolean") {
    throw new Error("Diagnostic record is invalid.");
  }
  return record;
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const source = JSON.stringify(value);
  if (Buffer.byteLength(source, "utf8") > LOCAL_FRAMEWORK_DIAGNOSTIC_MAX_BYTES) throw new Error("Diagnostic record exceeds 256 KiB.");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, source, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
