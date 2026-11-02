import { describe, expect, it } from "vitest";
import { ExternalProviderError, getExternalErrorDiagnostic, getFailureRetryability, readExternalErrorDiagnostic,
  publicErrorMessage, redactExternalSecrets } from "../../core/src/application/externalError.ts";

describe("public external error boundary", () => {
  it("preserves provider explanations and formatting without truncating", () => {
    const message = 'Invalid option [model].\nChoose {"model":"small"}. Help: https://provider.example/help\nrequest_id=public-123\n' + "details ".repeat(1000);
    const error = new ExternalProviderError("fixture", message, { code: "invalid_model" });
    expect(publicErrorMessage(error, "Internal failure")).toBe(message);
    expect(readExternalErrorDiagnostic(JSON.parse(JSON.stringify(error.externalDiagnostic)))).toEqual(error.externalDiagnostic);
  });
  it("does not publish arbitrary internal errors or evaluate diagnostic getters", () => {
    expect(publicErrorMessage(new TypeError("private implementation"), "Please try again.")).toBe("Please try again.");
    const value = { get externalDiagnostic(): never { throw new Error("must not execute"); } };
    expect(getExternalErrorDiagnostic(value)).toBeUndefined();
    expect(readExternalErrorDiagnostic({ origin: "external", provider: "fixture", get message(): never { throw new Error(); } })).toBeUndefined();
  });
  it("uses only explicit adapter retryability and defaults every other failure to unknown", () => {
    const retryable = new ExternalProviderError("fixture", "Try again.", { retryability: "retryable" });
    expect(getFailureRetryability(retryable)).toBe("retryable");
    expect(getFailureRetryability(new ExternalProviderError("fixture", "HTTP 503."))).toBe("unknown");
    expect(getFailureRetryability({ httpStatus: 503, message: "retry later" })).toBe("unknown");
    expect(getFailureRetryability({ get retryability(): never { throw new Error("must not execute"); } })).toBe("unknown");
  });
  it("does not mistake provider explanations for credential assignments", () => {
    for (const message of ["Authorization: denied by organization policy.", "API key: project is disabled.", "Token: insufficient permissions."]) {
      expect(redactExternalSecrets(message)).toBe(message);
    }
  });
  it("redacts quoted JSON credentials and provider codes too", () => {
    expect(redactExternalSecrets('{"api_key":"opaque-fixture-credential","message":"quota exceeded"}'))
      .toBe('{"api_key":"[redacted]","message":"quota exceeded"}');
    expect(redactExternalSecrets('{"password":"opaque\\\"secret","message":"try again"}'))
      .toBe('{"password":"[redacted]","message":"try again"}');
    expect(new ExternalProviderError("fixture", "Try again.", { code: "token=opaque-fixture-credential", secretValues: ["opaque-fixture-credential"] }).externalDiagnostic.code).toBe("token=[redacted]");
  });
  it("removes only credentials and their escaped forms from diagnostics", () => {
    const secret = 'opaque+key/"value';
    const text = `${secret}\n${encodeURIComponent(secret)}\n${JSON.stringify(secret)}\nRetry after 12 seconds. request_id=public-123`;
    expect(redactExternalSecrets(text, [secret])).toBe('[redacted]\n[redacted]\n"[redacted]"\nRetry after 12 seconds. request_id=public-123');
    expect(redactExternalSecrets("See https://provider.example/help?token=hidden&section=billing")).toBe("See https://provider.example/help?token=[redacted]&section=billing");
    expect(redactExternalSecrets("Authorization: Bearer opaque-token. Retry after 12 seconds.")).not.toContain("opaque-token");
    expect(redactExternalSecrets('password="unknown secret value" was rejected. request_id=public-123')).toBe('password="[redacted]" was rejected. request_id=public-123');
    expect(redactExternalSecrets("opaque\u001b[31m-secret\u001b[0m failed", ["opaque-secret"])).toBe("[redacted] failed");
    expect(redactExternalSecrets("OPENAI_API_KEY=abc123 failed, client_secret=def456 rejected")).toBe("OPENAI_API_KEY=[redacted] failed, client_secret=[redacted] rejected");
  });
});
