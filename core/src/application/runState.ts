import type { RunStateStore } from "./runLifecycle.ts";
import { isRunEventType, type RunEvent } from "./runEvent.ts";
import {
  canonicalTimestamp,
  record,
  requiredString,
  safeIdentifier,
} from "./recordValidation.ts";
import {
  validateRunManifestV2,
  validateRunManifestV3,
  validateRunManifestV5,
  type RunManifestV2,
  type RunManifestV3,
  type RunManifestV5,
} from "../domain/runManifest.ts";
import { assertExactKeys } from "../domain/validation.ts";

export type RunLifecycleStatus = "running" | "waiting_for_input" | "resume_queued" | "complete" | "failed" | "cancelled";

export type RunStatusProjection =
  | {
      kind: "status";
      status: "waiting_for_input" | "resume_queued";
      updatedAt: string;
      requestId: string;
      expiresAt: string;
      activeComputeMs: number;
    }
  | {
      kind: "status";
      status: "running";
      updatedAt: string;
      stageId?: string;
    }
  | {
      kind: "status";
      status: "complete";
      updatedAt: string;
    }
  | {
      kind: "status";
      status: "cancelled";
      updatedAt: string;
    }
  | {
      kind: "status";
      status: "failed";
      updatedAt: string;
      stageId?: string;
      message: string;
    };

export interface RunHeartbeatProjection {
  kind: "heartbeat";
  status: RunLifecycleStatus;
  lastEventType: RunEvent["type"];
  updatedAt: string;
  stageId?: string;
  logicalAgentId?: string;
  providerId?: string;
}

export type RunStateProjection = RunStatusProjection | RunHeartbeatProjection;

export interface RunState {
  manifest: RunManifestV2;
  status?: RunStatusProjection;
  heartbeat?: RunHeartbeatProjection;
}

export interface RunStateV3 {
  manifest: RunManifestV3;
  status?: RunStatusProjection;
  heartbeat?: RunHeartbeatProjection;
}

export interface RunStateV5 {
  manifest: RunManifestV5;
  status?: RunStatusProjection;
  heartbeat?: RunHeartbeatProjection;
}

export interface ReservableRunStateStore extends RunStateStore<
  RunManifestV2,
  RunStateProjection,
  RunState
> {
  reserve(): Promise<void>;
}

export interface ReservableRunStateV3Store extends RunStateStore<
  RunManifestV3,
  RunStateProjection,
  RunStateV3
> {
  reserve(): Promise<void>;
}

export interface ReservableRunStateV5Store extends RunStateStore<
  RunManifestV5,
  RunStateProjection,
  RunStateV5
> {
  reserve(): Promise<void>;
}

export function validateRunStateProjection(value: unknown): RunStateProjection {
  const projection = record(value, "Run state projection");
  if (projection.kind === "status") {
    if (projection.status === "waiting_for_input" || projection.status === "resume_queued") {
      assertExactKeys(projection, ["kind", "status", "updatedAt", "requestId", "expiresAt", "activeComputeMs"], "Run input-wait status");
      safeIdentifier(projection.requestId, "Run input request ID");
      canonicalTimestamp(projection.expiresAt, "Run input expiry");
      if (!Number.isSafeInteger(projection.activeComputeMs) || (projection.activeComputeMs as number) < 0) throw new Error("Run active compute must be a nonnegative safe integer.");
    } else if (projection.status === "running") {
      assertExactKeys(
        projection,
        ["kind", "status", "updatedAt"],
        "Run state projection",
        ["kind", "status", "updatedAt", "stageId"],
      );
    } else if (projection.status === "complete" || projection.status === "cancelled") {
      assertExactKeys(projection, ["kind", "status", "updatedAt"], "Run state projection");
    } else if (projection.status === "failed") {
      assertExactKeys(
        projection,
        ["kind", "status", "updatedAt", "message"],
        "Run state projection",
        ["kind", "status", "updatedAt", "message", "stageId"],
      );
      requiredString(projection.message, "Run state projection.message");
    } else {
      throw new Error("Run state projection.status is unsupported.");
    }
    canonicalTimestamp(projection.updatedAt, "Run state projection.updatedAt");
    if (projection.stageId !== undefined) safeIdentifier(projection.stageId, "Run state projection.stageId");
    return structuredClone(projection) as RunStatusProjection;
  }
  if (projection.kind !== "heartbeat") {
    throw new Error("Run state projection.kind must be status or heartbeat.");
  }
  assertExactKeys(
    projection,
    ["kind", "status", "lastEventType", "updatedAt"],
    "Run state projection",
    ["kind", "status", "lastEventType", "updatedAt", "stageId", "logicalAgentId", "providerId"],
  );
  lifecycleStatus(projection.status, "Run state projection.status");
  if (!isRunEventType(projection.lastEventType)) {
    throw new Error("Run state projection.lastEventType is unsupported.");
  }
  canonicalTimestamp(projection.updatedAt, "Run state projection.updatedAt");
  for (const [key, label] of [
    ["stageId", "Run state projection.stageId"],
    ["logicalAgentId", "Run state projection.logicalAgentId"],
    ["providerId", "Run state projection.providerId"],
  ] as const) {
    if (projection[key] !== undefined) safeIdentifier(projection[key], label);
  }
  return structuredClone(projection) as unknown as RunHeartbeatProjection;
}

export function validateRunState(value: unknown): RunState {
  const state = record(value, "Run state");
  assertExactKeys(
    state,
    ["manifest"],
    "Run state",
    ["manifest", "status", "heartbeat"],
  );
  return {
    manifest: validateRunManifestV2(state.manifest),
    ...(state.status === undefined ? {} : {
      status: validateStatusProjection(state.status),
    }),
    ...(state.heartbeat === undefined ? {} : {
      heartbeat: validateHeartbeatProjection(state.heartbeat),
    }),
  };
}

export function validateRunStateV3(value: unknown): RunStateV3 {
  const state = record(value, "Run state");
  assertExactKeys(
    state,
    ["manifest"],
    "Run state",
    ["manifest", "status", "heartbeat"],
  );
  return {
    manifest: validateRunManifestV3(state.manifest),
    ...(state.status === undefined ? {} : {
      status: validateStatusProjection(state.status),
    }),
    ...(state.heartbeat === undefined ? {} : {
      heartbeat: validateHeartbeatProjection(state.heartbeat),
    }),
  };
}

export function validateRunStateV5(value: unknown): RunStateV5 {
  const state = record(value, "Run state");
  assertExactKeys(
    state,
    ["manifest"],
    "Run state",
    ["manifest", "status", "heartbeat"],
  );
  return {
    manifest: validateRunManifestV5(state.manifest),
    ...(state.status === undefined ? {} : {
      status: validateStatusProjection(state.status),
    }),
    ...(state.heartbeat === undefined ? {} : {
      heartbeat: validateHeartbeatProjection(state.heartbeat),
    }),
  };
}

function validateStatusProjection(value: unknown): RunStatusProjection {
  const projection = validateRunStateProjection(value);
  if (projection.kind !== "status") throw new Error("Run state.status must be a status projection.");
  return projection;
}

function validateHeartbeatProjection(value: unknown): RunHeartbeatProjection {
  const projection = validateRunStateProjection(value);
  if (projection.kind !== "heartbeat") throw new Error("Run state.heartbeat must be a heartbeat projection.");
  return projection;
}

function lifecycleStatus(value: unknown, location: string): asserts value is RunLifecycleStatus {
  if (!["running", "waiting_for_input", "resume_queued", "complete", "failed", "cancelled"].includes(value as string)) {
    throw new Error(`${location} is unsupported.`);
  }
}
