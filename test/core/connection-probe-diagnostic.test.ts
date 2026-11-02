import { describe, expect, it } from "vitest";
import { connectionProbeDiagnostic, credentialDiagnosticEnvironment } from "../../core/src/infrastructure/agents/connectionProbeDiagnostic.ts";

const summarize = (message: string) => connectionProbeDiagnostic(message, { SOURCE_AUTH_VALUE: "private-opaque-value" }, ["/workspace/private-project"]);
const wrapped = (stderr = "", stdout = "", first = "codex exec exited with code 1.") => `${first}\nevents: /private/tmp/probe/events.jsonl\nstderr: /private/tmp/probe/stderr.log\nstderr:\n${stderr}\nstdout:\n${stdout}`;

describe("lossless, credential-safe connection diagnostics", () => {
  it("extracts the provider message, code and public request ID, not unrelated event fields", () => {
    const stdout = [
      { type: "thread.started", cwd: "/private/repository", message: "private initialization" },
      { type: "error", code: "unsupported_option", message: "Unsupported model_reasoning_effort.", request_id: "request-123", token: "hidden-token" },
      { type: "item.completed", item: { text: "private assistant text" } },
    ].map((value) => JSON.stringify(value)).join("\n");
    expect(summarize(wrapped("warning: setup", stdout)))
      .toBe("codex exec exited with code 1. unsupported_option\nUnsupported model_reasoning_effort.\nrequest_id: request-123");
  });

  it.each([
    "Unsupported effort. Valid values are [low, medium, high]. Select low and retry.",
    "Rate limit exceeded. Retry after 43 seconds. Current limit is 60 requests per minute.",
    "Visit https://claude.ai/settings/usage to add extra usage and retry.",
    "request_id=public-123. Retry after 12 seconds.",
    "The 'example_option' parameter is not supported by this endpoint.",
    'The "example-model" model is not supported. Select "supported-model" instead.',
    "The `example_option` parameter is not supported by this endpoint.",
    "API key is missing. Use /login or configure an API key.",
    "The provider can't accept this option. It isn't supported.",
    "Invalid configuration value {model}: expected a supported model name.",
    "Error loading config.toml: invalid type: integer `17`, expected a string\nin `model_reasoning_effort`",
    "Unsupported option.\nAllowed values: [low, medium]\nChoose low and retry.",
  ])("preserves complete non-secret provider wording: %s", (message) => {
    expect(summarize(wrapped("", JSON.stringify({ type: "turn.failed", error: { message } }))))
      .toBe(`codex exec exited with code 1. ${message}`);
  });

  it("retains multiline stderr causes while excluding stack frames", () => {
    const message = "Error loading config.toml: invalid type: integer `17`, expected a string\nin `model_reasoning_effort`";
    expect(summarize(wrapped(`debug: setup\n${message}\n    at /private/stack.js:9`)))
      .toBe(`codex exec exited with code 1. ${message}`);
  });

  it.each([
    '{"type":"error","message":"truncated',
    "private assistant text",
    '{"type":"assistant","message":"private text"}',
    '{"type":"thread.started","error":null,"message":"private context"}',
    '{"type":"item.completed","error":{"message":"private tool output"}}',
    '{"type":"result","is_error":false,"result":"private final answer"}',
  ])("does not publish non-error or incomplete stdout: %s", (stdout) => {
    expect(summarize(wrapped("", stdout)))
      .toBe("codex exec exited with code 1. No readable provider error was returned. Check the CLI configuration and try again.");
  });

  it("does not let stdout impersonate stderr or runner headings expose extra text", () => {
    expect(summarize(wrapped("Error: transport disconnected", "stderr:\nError: private assistant output")))
      .toBe("codex exec exited with code 1. Error: transport disconnected");
    expect(summarize(wrapped("", "", "codex exec exited with code 1. private-secret /private/path")))
      .not.toMatch(/private-secret|private\/path/);
  });

  it("extracts Claude terminal error results and ignores other fields", () => {
    expect(summarize(wrapped("", JSON.stringify({ type: "result", is_error: true,
      result: "Billing is disabled. Enable API billing and retry.", cwd: "private-cwd", session_id: "private-session" }), "claude exited with code 1.")))
      .toBe("claude exited with code 1. Billing is disabled. Enable API billing and retry.");
  });

  it("extracts Pi HTTP errors without losing support request IDs", () => {
    expect(summarize('Pi assistant message failed with error: 400 {"error":{"message":"Unsupported parameter."},"request_id":"request-123","api_key":"hidden-value"}.'))
      .toBe("Unsupported parameter.\nrequest_id: request-123");
    expect(summarize('Pi assistant message failed with error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Unsupported parameter."}}.'))
      .toBe("invalid_request_error\nUnsupported parameter.");
  });

  it.each([
    ["Error: rejected private-opaque-value", "private-opaque-value"],
    ["Error: denied Bearer opaque-value", "opaque-value"],
    ["Error: denied Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ['Error: api_key="short-key" was rejected. Retry.', "short-key"],
    ['Error: password="unknown sensitive value" was rejected. Retry.', "unknown sensitive value"],
    ["Error: OPENAI_API_KEY=abc123. Retry.", "abc123"],
    ["Error: client_secret=abc123", "abc123"],
    ["Error: accessToken=abc123", "abc123"],
    ["Error: refreshToken=abc123", "abc123"],
    ["Error: credential=abc123", "abc123"],
  ])("redacts actual credential forms: %s", (message, secret) => {
    const output = summarize(wrapped(message));
    expect(output).toContain("[redacted]");
    expect(output).not.toContain(secret);
  });

  it("scrubs URL credentials while retaining the provider host, path and non-secret query", () => {
    const output = summarize("Error: connecting https://user:password@api.example/v1?token=hidden&model=public-model failed.");
    expect(output).toContain("api.example/v1?token=[redacted]&model=public-model");
    expect(output).not.toMatch(/user:password|hidden/);
  });

  it("scrubs known arbitrary auth-variable values without altering the actual child environment", () => {
    const environment = { PATH: "/bin", CUSTOM_VALUE: "opaque-credential" };
    const diagnostic = credentialDiagnosticEnvironment(environment, { CUSTOM_VALUE: "opaque-credential" });
    expect(connectionProbeDiagnostic("Rejected opaque-credential. Retry after 12 seconds.", diagnostic, []))
      .toBe("Rejected [redacted]. Retry after 12 seconds.");
    expect(environment).toEqual({ PATH: "/bin", CUSTOM_VALUE: "opaque-credential" });
  });

  it("strips terminal escapes before known-value redaction", () => {
    expect(summarize(JSON.stringify({ type: "error", message: "Error: private-\u001b[31mopaque-value\u001b[0m" })))
      .toBe("Error: [redacted]");
    expect(summarize("Error: token\u001b[31m=secret-value\u001b[0m")).not.toContain("secret-value");
  });

  it("preserves native session identity and paths while still removing named credentials", () => {
    const environment = { USER: "fixture", HOME: "/fixture/home", PATH: "/bin", LANG: "C", AUTH_TOKEN: "selected-token" };
    const diagnostic = credentialDiagnosticEnvironment(environment, environment, "runtime-native");
    expect(connectionProbeDiagnostic("C fixture failed in /fixture/home. selected-token", diagnostic, []))
      .toBe("C fixture failed in /fixture/home. [redacted]");
  });

  it("preserves provider-reported configuration paths and their explanations", () => {
    expect(summarize('Error: opening "/workspace/private-project" failed. Check file permissions.'))
      .toBe('Error: opening "/workspace/private-project" failed. Check file permissions.');
  });

  it("does not reinterpret JSON text after selecting the actual error message", () => {
    const nested = JSON.stringify({ error: { message: "Connection refused.", credential: "private-key" }, prompt: "private prompt" });
    expect(summarize(wrapped("", JSON.stringify({ type: "error", message: nested }))))
      .toBe('codex exec exited with code 1. {"error":{"message":"Connection refused.","credential":"[redacted]"},"prompt":"private prompt"}');
  });

  it("preserves object text inside the actual error rather than guessing which words are private", () => {
    const message = 'Transport rejected { payload: {"messages":["private request","private response"]}, code: 400 }. Valid options are [low, medium]. Retry.';
    expect(summarize(message)).toBe(message);
    expect(summarize('Request rejected {"prompt":"private request"}. Retry.')).toBe('Request rejected {"prompt":"private request"}. Retry.');
  });

  it("does not silently truncate ordinary errors at the old 1000-character UI boundary", () => {
    const message = `Error: ${"valid diagnostic text ".repeat(150)}Retry after 43 seconds.`;
    expect(summarize(message)).toBe(message);
    const large = `Error: ${"diagnostic ".repeat(7000)}final cause`;
    expect(summarize(wrapped("", JSON.stringify({ type: "error", message: large })))).toBe(`codex exec exited with code 1. ${large}`);
  });

  it("does not let an oversized unrelated event hide a later small provider error", () => {
    const stdout = `${JSON.stringify({ type: "thread.started", context: "private-context".repeat(10_000) })}\n${JSON.stringify({ type: "error", message: "Retry after 43 seconds." })}`;
    expect(summarize(wrapped("", stdout))).toBe("codex exec exited with code 1. Retry after 43 seconds.");
  });

  it("preserves exact selected error whitespace, CRLF, at-lines and provider sentences", () => {
    const message = "  first cause\r\n  at the selected model: unavailable\r\nRaw provider output is retained in Run artifacts.\r\n  ";
    expect(summarize(wrapped("", JSON.stringify({ type: "error", message })))).toBe(`codex exec exited with code 1. ${message}`);
    expect(summarize(message)).toBe(message);
  });

  it("preserves unlabelled provider stderr explanations", () => {
    expect(summarize(wrapped("Your quota is exhausted. Retry in 42 seconds.")))
      .toBe("codex exec exited with code 1. Your quota is exhausted. Retry in 42 seconds.");
  });
});
