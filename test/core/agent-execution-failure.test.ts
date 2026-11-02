import { expect, it } from "vitest";
import { AgentProviderFailure, AgentExecutionCancelledError } from "../../core/src/application/agentExecutionFailure.ts";
import { ExternalProviderError, getExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";
import { agentPreflightFailure } from "../../core/src/infrastructure/agents/connectionProbeDiagnostic.ts";
import type { AgentExecutionPreflightResult } from "../../core/src/application/agentProvider.ts";

it("keeps common failure codes separate from provider codes, text and HTTP status", () => {
  const error = new AgentProviderFailure("fixture", "Rejected opaque-credential at https://provider.example/fix: wait 43 seconds.", {
    code: "provider-quota-exceeded", httpStatus: 429, secretValues: ["opaque-credential"],
  });
  expect(error).toBeInstanceOf(ExternalProviderError);
  expect(error.failureCode).toBe("agent_provider_failed");
  expect(error.externalDiagnostic).toEqual({ origin: "external", provider: "fixture",
    message: "Rejected [redacted] at https://provider.example/fix: wait 43 seconds.", code: "provider-quota-exceeded", httpStatus: 429 });
});

it("classifies timeouts without changing the provider diagnostic", () => {
  const error = new AgentProviderFailure("fixture", "CLI timed out", { status: "timed-out", code: "ETIMEDOUT" });
  expect(error.failureCode).toBe("agent_timed_out");
  expect(error.externalDiagnostic.code).toBe("ETIMEDOUT");
  expect(new AgentProviderFailure("fixture", "Cancelled", { status: "failed", failureCode: "agent_cancelled" }).failureCode).toBe("agent_cancelled");
});

it("pre-dispatch cancellation carries no provider diagnostic or metrics", () => {
  const error = new AgentExecutionCancelledError();
  expect(error).toMatchObject({ failureCode: "agent_cancelled", message: "Agent execution was cancelled." });
  expect(getExternalErrorDiagnostic(error)).toBeUndefined();
  expect(error).not.toHaveProperty("metrics");
});

it("classifies external preflight failures but leaves internal setup errors separate", () => {
  const preflight: AgentExecutionPreflightResult = { providerId: "fixture", available: false,
    auth: { authProviderId: "fixture", kind: "environment", available: false, status: "unavailable" } };
  const internal = agentPreflightFailure(preflight, "Configure the CLI first.", {});
  expect(internal.message).toBe("Configure the CLI first.");
  expect(internal).not.toHaveProperty("failureCode");
  const external = new ExternalProviderError("fixture", "Account disabled.", { code: "account_disabled" }).externalDiagnostic;
  const failure = agentPreflightFailure({ ...preflight, externalDiagnostic: external }, "fallback", {});
  expect(failure).toMatchObject({ failureCode: "agent_provider_failed", externalDiagnostic: external });
});
