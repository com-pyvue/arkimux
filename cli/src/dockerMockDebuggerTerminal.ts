import { readExternalErrorDiagnostic, redactExternalSecrets, type ExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";
import { compareExpectations, isHeadlessJson, sanitizeEvidence, type HeadlessComparisonResult,
  type HeadlessExpectation } from "../../local/src/headlessDebuggerContracts.ts";
import type { DockerMockDebuggerJson } from "./dockerMockDebuggerBridgeContracts.ts";

export type DockerMockDebuggerWorkerOutcome =
  | { kind: "result"; result: unknown }
  | { kind: "error"; externalDiagnostic?: unknown }
  | { kind: "exit" };

export interface DockerMockDebuggerCaseResult {
  readonly schemaVersion: 1;
  readonly kind: "arkimux-mock-debugger-case-result";
  readonly simulated: true;
  readonly caseId: string;
  readonly status: "passed" | "mismatch" | "failed" | "sandbox_unavailable";
  readonly comparison: HeadlessComparisonResult;
  readonly output?: DockerMockDebuggerJson;
  readonly failure?: { readonly code: string; readonly message: string; readonly provider?: string };
}

function unavailableComparison(expectations: readonly HeadlessExpectation[]): HeadlessComparisonResult {
  return compareExpectations(expectations, { terminal: true, runStatus: null, resultAvailable: false, unavailable: true });
}

function safeFailure(value: unknown): DockerMockDebuggerCaseResult["failure"] {
  const diagnostic: ExternalErrorDiagnostic | undefined = readExternalErrorDiagnostic(value);
  if (!diagnostic) return { code: "simulated_workflow_failed", message: "Simulated workflow execution failed." };
  const code = typeof diagnostic.code === "string" && /^[a-z0-9][a-z0-9._-]{0,199}$/.test(diagnostic.code)
    ? diagnostic.code : "simulated_dependency_failed";
  const message = redactExternalSecrets(diagnostic.message).slice(0, 4096) || "Simulated dependency failed.";
  return { code, message, provider: diagnostic.provider.slice(0, 200) };
}

export function dockerMockDebuggerCaseResult(
  caseId: string,
  expectations: readonly HeadlessExpectation[],
  outcome: DockerMockDebuggerWorkerOutcome,
): DockerMockDebuggerCaseResult {
  if (outcome.kind === "exit") return { schemaVersion: 1, kind: "arkimux-mock-debugger-case-result",
    simulated: true, caseId, status: "sandbox_unavailable", comparison: unavailableComparison(expectations),
    failure: { code: "debugger_unavailable", message: "The simulated workflow worker stopped without a terminal result." } };
  if (outcome.kind === "error") {
    const comparison = compareExpectations(expectations, { terminal: true, runStatus: "failed", resultAvailable: false });
    return { schemaVersion: 1, kind: "arkimux-mock-debugger-case-result", simulated: true, caseId,
      status: expectations.length > 0 && comparison.comparison === "pass" ? "passed" : "failed",
      comparison, failure: safeFailure(outcome.externalDiagnostic) };
  }
  const retained = outcome.result && typeof outcome.result === "object" && !Array.isArray(outcome.result)
    ? outcome.result as Record<string, unknown> : undefined;
  if (retained?.status !== "completed" || !Object.hasOwn(retained, "output")) return {
    schemaVersion: 1, kind: "arkimux-mock-debugger-case-result", simulated: true, caseId,
    status: "sandbox_unavailable", comparison: unavailableComparison(expectations),
    failure: { code: "unsupported_simulated_outcome", message: "The simulated workflow did not return a completed result." },
  };
  const result = retained.output;
  if (!isHeadlessJson(result)) return { schemaVersion: 1, kind: "arkimux-mock-debugger-case-result",
    simulated: true, caseId, status: "sandbox_unavailable", comparison: unavailableComparison(expectations),
    failure: { code: "invalid_simulated_result", message: "The simulated workflow returned an unsupported result." } };
  const output = sanitizeEvidence(result, { payload: true }).value;
  const comparison = compareExpectations(expectations, { terminal: true, runStatus: "complete", resultAvailable: true, resultPayload: result });
  return { schemaVersion: 1, kind: "arkimux-mock-debugger-case-result", simulated: true, caseId,
    status: comparison.comparison === "mismatch" ? "mismatch" : "passed", comparison, output };
}
