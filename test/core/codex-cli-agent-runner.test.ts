import { describe, expect, it } from "vitest";
import {
  codexExecutionFailureMessage,
  summarizeCodexEvents,
} from "../../core/src/infrastructure/agents/codexCliAgentRunner.ts";

describe("Codex CLI agent event normalization", () => {
  it("projects comparable usage and shell-command metrics", () => {
    const events = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "rg -n Stack stack && sed -n '1,80p' stack/bin/app.ts",
          aggregated_output: "fixture output\n",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 1_000,
          cached_input_tokens: 750,
          output_tokens: 120,
          reasoning_output_tokens: 45,
        },
      }),
    ].join("\n");

    expect(summarizeCodexEvents(events)).toEqual({
      toolMetrics: {
        nativeToolCalls: 1,
        toolCallUnit: "shell-command",
        repositorySearchCalls: 1,
        fileReadCalls: 1,
        repositoryResultBytes: Buffer.byteLength("fixture output\n"),
      },
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 750,
        outputTokens: 120,
        reasoningOutputTokens: 45,
      },
    });
  });

  it("ignores malformed diagnostics and leaves unavailable usage absent", () => {
    expect(summarizeCodexEvents("not-json\n")).toEqual({
      toolMetrics: {
        nativeToolCalls: 0,
        toolCallUnit: "shell-command",
        repositorySearchCalls: 0,
        fileReadCalls: 0,
        repositoryResultBytes: 0,
      },
    });
  });

  it("preserves the provider's model eligibility explanation without inventing advice", () => {
    const message = codexExecutionFailureMessage(
      `${JSON.stringify({ type: "error", message: "The selected model is not available on your plan" })}\n`,
      "",
      {
        authProviderId: "codex-native-session",
        kind: "runtime-native",
        available: true,
        status: "indeterminate",
        identity: { authMethod: "chatgpt" },
      },
      "gpt-5.6-luna",
    );

    expect(message).toBe("codex exec exited with code 1. The selected model is not available on your plan");
  });

  it("preserves billing error codes and provider wording", () => {
    const message = codexExecutionFailureMessage(
      `${JSON.stringify({ type: "turn.failed", error: { code: "insufficient_quota", message: "billing quota exceeded" } })}\n`,
      "",
      {
        authProviderId: "openai-api-key",
        kind: "runtime-native",
        available: true,
        status: "indeterminate",
        identity: { authMethod: "api-key" },
      },
      "gpt-5.6-luna",
    );

    expect(message).toBe("codex exec exited with code 1. insufficient_quota\nbilling quota exceeded");
    expect(message).not.toContain("ChatGPT account");
  });

  it("preserves unrelated explicit provider failures", () => {
    expect(codexExecutionFailureMessage(
      `${JSON.stringify({ type: "error", message: "repository file disappeared" })}\n`,
      "",
      {
        authProviderId: "codex-native-session",
        kind: "runtime-native",
        available: true,
        status: "indeterminate",
      },
    )).toBe("codex exec exited with code 1. repository file disappeared");
  });
});
