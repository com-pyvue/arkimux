import {
  runCorrectionLinkSchema,
  type RunCorrectionLinkDto,
} from "@com-pyvue/agent-execution-run-contract";
import type { RunRef } from "@com-pyvue/agent-execution-core";

/** Immutable Run lineage. Execution manifests and checkpoints do not contain
 * correction metadata, so a correction cannot rewrite retained execution. */
export interface RunCorrectionLinks {
  create(link: RunCorrectionLinkDto): Promise<RunCorrectionLinkDto>;
  getByCorrectedRun(ref: RunRef): Promise<RunCorrectionLinkDto | undefined>;
  listByPriorRun(ref: RunRef): Promise<RunCorrectionLinkDto[]>;
}

export function validateRunCorrectionLink(value: unknown): RunCorrectionLinkDto {
  return runCorrectionLinkSchema.parse(value);
}
