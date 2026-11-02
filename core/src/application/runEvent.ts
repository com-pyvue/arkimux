import type {
  AgentExecutionMetrics,
  AuthAvailability,
} from "./agentProvider.ts";
import {
  validateAgentExecutionMetrics,
  validateAuthAvailability,
} from "./agentMetrics.ts";
import {
  canonicalTimestamp,
  nonNegativeInteger,
  positiveInteger,
  record,
  requiredString,
  safeIdentifier,
} from "./recordValidation.ts";
import {
  validateRunManifestV2,
  validateRunManifestV3,
  type RunManifestV2,
  type RunManifestV3,
} from "../domain/runManifest.ts";
import { assertExactKeys } from "../domain/validation.ts";

export type RunEvent =
  | { type: "run-started"; at: string; manifest: RunManifestV2 | RunManifestV3 }
  | { type: "stage-started"; at: string; stageId: string }
  | { type: "stage-completed"; at: string; stageId: string; elapsedMs: number }
  | { type: "stage-failed"; at: string; stageId: string; elapsedMs: number; message: string }
  | {
      type: "agent-started";
      at: string;
      stageId: string;
      logicalAgentId: string;
      providerId: string;
      label: string;
      attempt: number;
    }
  | {
      type: "agent-preflight-completed";
      at: string;
      stageId: string;
      logicalAgentId: string;
      providerId: string;
      auth: AuthAvailability;
    }
  | {
      type: "agent-completed";
      at: string;
      stageId: string;
      logicalAgentId: string;
      providerId: string;
      metrics: AgentExecutionMetrics;
    }
  | {
      type: "agent-failed";
      at: string;
      stageId: string;
      logicalAgentId: string;
      providerId: string;
      message: string;
      metrics?: AgentExecutionMetrics;
    }
  | {
      type: "agent-timed-out";
      at: string;
      stageId: string;
      logicalAgentId: string;
      providerId: string;
      message: string;
      metrics: AgentExecutionMetrics;
    }
  | { type: "run-completed"; at: string }
  | { type: "run-failed"; at: string; message: string };

const eventTypes = new Set<RunEvent["type"]>([
  "run-started",
  "stage-started",
  "stage-completed",
  "stage-failed",
  "agent-started",
  "agent-preflight-completed",
  "agent-completed",
  "agent-failed",
  "agent-timed-out",
  "run-completed",
  "run-failed",
]);

export function isRunEventType(value: unknown): value is RunEvent["type"] {
  return typeof value === "string" && eventTypes.has(value as RunEvent["type"]);
}

export function validateRunEvent(value: unknown): RunEvent {
  const event = record(value, "Run event");
  requiredString(event.type, "Run event.type");
  canonicalTimestamp(event.at, "Run event.at");
  switch (event.type) {
    case "run-started":
      assertExactKeys(event, ["type", "at", "manifest"], "Run event");
      validateEventManifest(event.manifest);
      break;
    case "stage-started":
      assertExactKeys(event, ["type", "at", "stageId"], "Run event");
      safeIdentifier(event.stageId, "Run event.stageId");
      break;
    case "stage-completed":
      assertExactKeys(event, ["type", "at", "stageId", "elapsedMs"], "Run event");
      safeIdentifier(event.stageId, "Run event.stageId");
      nonNegativeInteger(event.elapsedMs, "Run event.elapsedMs");
      break;
    case "stage-failed":
      assertExactKeys(event, ["type", "at", "stageId", "elapsedMs", "message"], "Run event");
      safeIdentifier(event.stageId, "Run event.stageId");
      nonNegativeInteger(event.elapsedMs, "Run event.elapsedMs");
      requiredString(event.message, "Run event.message");
      break;
    case "agent-started":
      assertExactKeys(
        event,
        ["type", "at", "stageId", "logicalAgentId", "providerId", "label", "attempt"],
        "Run event",
      );
      validateAgentCoordinates(event);
      requiredString(event.label, "Run event.label");
      positiveInteger(event.attempt, "Run event.attempt");
      break;
    case "agent-preflight-completed":
      assertExactKeys(
        event,
        ["type", "at", "stageId", "logicalAgentId", "providerId", "auth"],
        "Run event",
      );
      validateAgentCoordinates(event);
      validateAuthAvailability(event.auth);
      break;
    case "agent-completed":
      assertExactKeys(
        event,
        ["type", "at", "stageId", "logicalAgentId", "providerId", "metrics"],
        "Run event",
      );
      validateAgentCoordinates(event);
      assertEventMetrics(validateAgentExecutionMetrics(event.metrics), event.providerId, "complete");
      break;
    case "agent-failed":
      assertExactKeys(
        event,
        ["type", "at", "stageId", "logicalAgentId", "providerId", "message"],
        "Run event",
        ["type", "at", "stageId", "logicalAgentId", "providerId", "message", "metrics"],
      );
      validateAgentCoordinates(event);
      requiredString(event.message, "Run event.message");
      if (event.metrics !== undefined) {
        assertEventMetrics(validateAgentExecutionMetrics(event.metrics), event.providerId, "failed");
      }
      break;
    case "agent-timed-out":
      assertExactKeys(
        event,
        ["type", "at", "stageId", "logicalAgentId", "providerId", "message", "metrics"],
        "Run event",
      );
      validateAgentCoordinates(event);
      requiredString(event.message, "Run event.message");
      assertEventMetrics(validateAgentExecutionMetrics(event.metrics), event.providerId, "timed-out");
      break;
    case "run-completed":
      assertExactKeys(event, ["type", "at"], "Run event");
      break;
    case "run-failed":
      assertExactKeys(event, ["type", "at", "message"], "Run event");
      requiredString(event.message, "Run event.message");
      break;
    default:
      throw new Error(`Run event.type is unsupported: ${JSON.stringify(event.type)}.`);
  }
  return structuredClone(event) as RunEvent;
}

function validateEventManifest(value: unknown): RunManifestV2 | RunManifestV3 {
  const manifest = record(value, "Run event.manifest");
  if (manifest.schemaVersion === 2) return validateRunManifestV2(manifest);
  if (manifest.schemaVersion === 3) return validateRunManifestV3(manifest);
  throw new Error("Run event.manifest.schemaVersion must be 2 or 3.");
}

function validateAgentCoordinates(event: Record<string, unknown>): void {
  safeIdentifier(event.stageId, "Run event.stageId");
  safeIdentifier(event.logicalAgentId, "Run event.logicalAgentId");
  safeIdentifier(event.providerId, "Run event.providerId");
}

function assertEventMetrics(
  metrics: AgentExecutionMetrics,
  providerId: unknown,
  status: AgentExecutionMetrics["status"],
): void {
  if (metrics.providerId !== providerId) {
    throw new Error("Run event metrics providerId must match the event providerId.");
  }
  if (metrics.status !== status) {
    throw new Error(`Run event metrics status must be ${status}.`);
  }
}
