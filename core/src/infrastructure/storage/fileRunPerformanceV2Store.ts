import {
  validateRunPerformance,
  type AgentAttemptPerformanceRecord,
  type RunPerformance,
  type RunPerformanceQueryStore,
  type RunPerformanceStore,
} from "../../application/runPerformance.ts";
import { validateRunRef, type RunRef } from "../../domain/runIdentity.ts";
import { FileRunPerformanceStore } from "./fileRunPerformanceStore.ts";

interface StoredPerformanceAttempt extends AgentAttemptPerformanceRecord {
  schemaVersion: 1;
  runRef: RunRef;
}

export class FileRunPerformanceV2Store
  extends FileRunPerformanceStore<AgentAttemptPerformanceRecord, RunPerformance, RunRef>
  implements RunPerformanceStore, RunPerformanceQueryStore {
  constructor(root: string, runRef: RunRef) {
    const validatedRef = validateRunRef(runRef);
    super({
      root,
      attemptFileName,
      encodeAttempt: (record): StoredPerformanceAttempt => ({
        schemaVersion: 1,
        runRef: validatedRef,
        ...record,
      }),
      encodeSummary: validateRunPerformance,
      decodeSummary: validateRunPerformance,
      matchesQuery: (query) => validateRunRef(query).executionId === validatedRef.executionId,
    });
  }
}

function attemptFileName(record: AgentAttemptPerformanceRecord): string {
  const attempt = record.metrics.attempt;
  if (attempt === undefined || !Number.isInteger(attempt) || attempt <= 0) {
    throw new Error("Performance attempt number must be a positive integer.");
  }
  return [
    safeSegment(record.stageId, "Performance stage ID"),
    safeSegment(record.logicalAgentId, "Performance logical agent ID"),
    safeSegment(record.metrics.providerId, "Performance provider ID"),
    attempt,
  ].join(".") + ".json";
}

function safeSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid: ${value}.`);
  }
  return value;
}
