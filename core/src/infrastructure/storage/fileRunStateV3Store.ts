import {
  validateRunStateProjection,
  validateRunStateV3,
  type ReservableRunStateV3Store,
  type RunHeartbeatProjection,
  type RunStateProjection,
  type RunStateV3,
  type RunStatusProjection,
} from "../../application/runState.ts";
import { validateRunManifestV3, type RunManifestV3 } from "../../domain/runManifest.ts";
import type { RunRef } from "../../domain/runIdentity.ts";
import {
  FileRunStateStore,
  type FileRunStateProjectionCodec,
} from "./fileRunStateStore.ts";

const projections: readonly FileRunStateProjectionCodec<RunStateProjection, RunStateV3>[] = [
  {
    kind: "status",
    fileName: "run-status.json",
    encode: withoutKind,
    decode: (value) => statusProjection({ kind: "status", ...record(value) }),
    apply: (state, projection) => ({ ...state, status: statusProjection(projection) }),
  },
  {
    kind: "heartbeat",
    fileName: "run-heartbeat.json",
    encode: withoutKind,
    decode: (value) => heartbeatProjection({ kind: "heartbeat", ...record(value) }),
    apply: (state, projection) => ({ ...state, heartbeat: heartbeatProjection(projection) }),
  },
];

export interface FileRunStateV3StoreOptions {
  root: string;
  reservationRoot: string;
  runRef: RunRef;
}

export class FileRunStateV3Store
  extends FileRunStateStore<RunManifestV3, RunStateProjection, RunStateV3>
  implements ReservableRunStateV3Store {
  constructor(options: FileRunStateV3StoreOptions) {
    super({
      root: options.root,
      createState: (manifest) => ({ manifest: validateRunManifestV3(manifest) }),
      encodeManifest: validateRunManifestV3,
      decodeManifest: validateRunManifestV3,
      projections,
      projectionKind: (projection) => validateRunStateProjection(projection).kind,
      reservation: {
        root: options.reservationRoot,
        key: `${options.runRef.executionId}.json`,
        value: { schemaVersion: 1, runRef: options.runRef },
      },
    });
  }

  override async get(): Promise<RunStateV3 | undefined> {
    const state = await super.get();
    return state === undefined ? undefined : validateRunStateV3(state);
  }
}

function withoutKind(projection: RunStateProjection): Omit<RunStateProjection, "kind"> {
  const validated = validateRunStateProjection(projection);
  const { kind: _kind, ...stored } = validated;
  return stored;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored run-state projection must be an object.");
  }
  return value as Record<string, unknown>;
}

function statusProjection(value: unknown): RunStatusProjection {
  const projection = validateRunStateProjection(value);
  if (projection.kind !== "status") throw new Error("Stored projection must be status.");
  return projection;
}

function heartbeatProjection(value: unknown): RunHeartbeatProjection {
  const projection = validateRunStateProjection(value);
  if (projection.kind !== "heartbeat") throw new Error("Stored projection must be heartbeat.");
  return projection;
}
