import {
  validateRunState,
  validateRunStateProjection,
  type ReservableRunStateStore,
  type RunHeartbeatProjection,
  type RunState,
  type RunStateProjection,
  type RunStatusProjection,
} from "../../application/runState.ts";
import { validateRunManifestV2, type RunManifestV2 } from "../../domain/runManifest.ts";
import type { RunRef } from "../../domain/runIdentity.ts";
import {
  FileRunStateStore,
  type FileRunStateProjectionCodec,
} from "./fileRunStateStore.ts";

const projections: readonly FileRunStateProjectionCodec<RunStateProjection, RunState>[] = [
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

export interface FileRunStateV2StoreOptions {
  root: string;
  reservationRoot: string;
  runRef: RunRef;
}

export class FileRunStateV2Store
  extends FileRunStateStore<RunManifestV2, RunStateProjection, RunState>
  implements ReservableRunStateStore {
  constructor(options: FileRunStateV2StoreOptions) {
    super({
      root: options.root,
      createState: (manifest) => ({ manifest: validateRunManifestV2(manifest) }),
      encodeManifest: validateRunManifestV2,
      decodeManifest: validateRunManifestV2,
      projections,
      projectionKind: (projection) => validateRunStateProjection(projection).kind,
      reservation: {
        root: options.reservationRoot,
        key: `${options.runRef.executionId}.json`,
        value: { schemaVersion: 1, runRef: options.runRef },
      },
    });
  }

  override async get(): Promise<RunState | undefined> {
    const state = await super.get();
    return state === undefined ? undefined : validateRunState(state);
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
