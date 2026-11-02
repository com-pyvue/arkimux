import { describe, expect, it } from "vitest";
import { runStatusSchema, runListQuerySchema } from "../../apps/packages/run/contract/src/schemas.ts";
import { runStatusLabel, runStatusVariant } from "../../apps/packages/run/react/src/runStatus.ts";
import { runDetailRefetchInterval } from "../../apps/packages/run/react/src/queries.ts";
import { validateRunStateProjection } from "@com-pyvue/agent-execution-core/internal/application/runState.ts";

describe("waiting Run status is part of the existing contract", () => {
  const updatedAt = "2026-09-08T12:00:00.000Z", expiresAt = "2027-09-08T12:00:00.000Z";
  it.each(["waiting_for_input", "resume_queued"] as const)("validates and displays %s as nonterminal", status => {
    const projection = { kind: "status" as const, status, updatedAt, requestId: "input-1", expiresAt, activeComputeMs: 123 };
    expect(validateRunStateProjection(projection)).toEqual(runStatusSchema.parse(projection));
    expect(runListQuerySchema.parse({ status }).status).toBe(status);
    expect(runStatusLabel(status)).toBe(status === "waiting_for_input" ? "Waiting for input" : "Resume queued");
    expect(runStatusVariant(status)).toBe(status === "waiting_for_input" ? "warning" : "primary");
    expect(runDetailRefetchInterval(status)).not.toBe(false);
    for (const invalid of [{ ...projection, activeComputeMs: -1 }, { ...projection, requestId: undefined },
      { ...projection, expiresAt: "tomorrow" }, { ...projection, message: "not a failure" }]) {
      expect(() => validateRunStateProjection(invalid)).toThrow();
      expect(() => runStatusSchema.parse(invalid)).toThrow();
    }
  });
});
