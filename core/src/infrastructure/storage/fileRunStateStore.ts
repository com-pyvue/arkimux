import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunStateStore } from "../../application/runLifecycle.ts";

export class RunStateAlreadyExistsError extends Error {
  constructor(readonly stateRoot: string) {
    super(`Run state already exists: ${stateRoot}`);
    this.name = "RunStateAlreadyExistsError";
  }
}

export class RunReservationAlreadyExistsError extends Error {
  constructor(readonly reservationPath: string) {
    super(`Run reservation already exists: ${reservationPath}`);
    this.name = "RunReservationAlreadyExistsError";
  }
}

export interface FileRunReservationOptions {
  root: string;
  key: string;
  value: unknown;
}

export interface FileRunStateProjectionCodec<TProjection, TState> {
  kind: string;
  fileName: string;
  encode(projection: TProjection): unknown;
  decode(value: unknown): TProjection;
  apply(state: TState, projection: TProjection): TState;
}

export interface FileRunStateStoreOptions<TManifest, TProjection, TState> {
  root: string;
  createState(manifest: TManifest): TState;
  projections: readonly FileRunStateProjectionCodec<TProjection, TState>[];
  manifestFileName?: string;
  encodeManifest?(manifest: TManifest): unknown;
  decodeManifest?(value: unknown): TManifest;
  projectionKind(projection: TProjection): string;
  reservation?: FileRunReservationOptions;
}

export class FileRunStateStore<TManifest, TProjection, TState>
implements RunStateStore<TManifest, TProjection, TState> {
  readonly root: string;
  private readonly manifestFileName: string;
  private readonly projections: ReadonlyMap<string, FileRunStateProjectionCodec<TProjection, TState>>;
  private readonly createState: (manifest: TManifest) => TState;
  private readonly encodeManifest: (manifest: TManifest) => unknown;
  private readonly decodeManifest: (value: unknown) => TManifest;
  private readonly projectionKind: (projection: TProjection) => string;
  private readonly reservation?: FileRunReservationOptions;

  constructor(options: FileRunStateStoreOptions<TManifest, TProjection, TState>) {
    this.root = path.resolve(options.root);
    this.manifestFileName = options.manifestFileName ?? "run-manifest.json";
    assertSafeFileName(this.manifestFileName, "Run-state manifest filename");
    this.projections = projectionCodecs(options.projections, this.manifestFileName);
    this.createState = options.createState;
    this.encodeManifest = options.encodeManifest ?? identity;
    this.decodeManifest = options.decodeManifest ?? unsafeIdentity;
    this.projectionKind = options.projectionKind;
    this.reservation = options.reservation;
    if (this.reservation) assertSafeFileName(this.reservation.key, "Run reservation key");
  }

  async reserve(): Promise<void> {
    if (!this.reservation) throw new Error("Run-state store does not have reservation configuration.");
    const reservationPath = path.join(path.resolve(this.reservation.root), this.reservation.key);
    await fs.mkdir(path.dirname(reservationPath), { recursive: true });
    try {
      await fs.writeFile(reservationPath, serialize(this.reservation.value), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RunReservationAlreadyExistsError(reservationPath);
      }
      throw error;
    }
  }

  async create(manifest: TManifest): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.writeFile(
        this.filePath(this.manifestFileName),
        serialize(this.encodeManifest(manifest)),
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RunStateAlreadyExistsError(this.root);
      }
      throw error;
    }
  }

  async update(projection: TProjection): Promise<void> {
    const kind = this.projectionKind(projection);
    const codec = this.projections.get(kind);
    if (!codec) throw new Error(`Run-state projection kind is unsupported: ${kind}.`);
    await this.replaceJson(codec.fileName, codec.encode(projection));
  }

  async get(): Promise<TState | undefined> {
    const storedManifest = await this.readJson(this.manifestFileName);
    if (storedManifest === undefined) return undefined;
    let state = this.createState(this.decodeManifest(storedManifest));
    for (const codec of this.projections.values()) {
      const storedProjection = await this.readJson(codec.fileName);
      if (storedProjection !== undefined) {
        state = codec.apply(state, codec.decode(storedProjection));
      }
    }
    return state;
  }

  private async replaceJson(name: string, value: unknown): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const temporaryPath = this.filePath(`.${name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, serialize(value), "utf8");
      await fs.rename(temporaryPath, this.filePath(name));
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async readJson(name: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(name), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private filePath(name: string): string {
    return path.join(this.root, name);
  }
}

function projectionCodecs<TProjection, TState>(
  codecs: readonly FileRunStateProjectionCodec<TProjection, TState>[],
  manifestFileName: string,
): ReadonlyMap<string, FileRunStateProjectionCodec<TProjection, TState>> {
  const result = new Map<string, FileRunStateProjectionCodec<TProjection, TState>>();
  const fileNames = new Set([manifestFileName]);
  for (const codec of codecs) {
    if (codec.kind.length === 0) throw new Error("Run-state projection kind must not be empty.");
    if (result.has(codec.kind)) throw new Error(`Duplicate run-state projection kind: ${codec.kind}.`);
    assertSafeFileName(codec.fileName, `Run-state projection ${codec.kind} filename`);
    if (fileNames.has(codec.fileName)) {
      throw new Error(`Duplicate run-state filename: ${codec.fileName}.`);
    }
    result.set(codec.kind, codec);
    fileNames.add(codec.fileName);
  }
  return result;
}

function assertSafeFileName(value: string, label: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || path.isAbsolute(value)
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be a single non-empty path segment.`);
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
