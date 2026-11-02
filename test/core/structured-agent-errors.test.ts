import { describe, expect, it } from "vitest";
import { ExternalProviderError } from "../../core/src/application/externalError.ts";
import { runStructuredAgent } from "../../core/src/application/structuredAgent.ts";
import type { RunEvent } from "../../core/src/application/runEvent.ts";

describe("structured agent public failure events", () => {
  it.each([false, true])("publishes only the classified diagnostic, external=%s", async external => {
    const failure = external
      ? new ExternalProviderError("fixture", "Quota exceeded [model]. Retry after 42 seconds. opaque-key-value", { secretValues: ["opaque-key-value"] })
      : new TypeError("Internal path /private/provider-runtime opaque-key-value");
    const events: RunEvent[] = [];
    await expect(runStructuredAgent({
      executionProviders: { get: () => ({ providerId: "codex-cli", preflight: async () => { throw Error("No preflight in this test"); },
        run: async () => { throw failure; } }) },
      events: { emit: async event => { events.push(event); } },
    }, { stageId: "draft", logicalAgentId: "author", label: "Author", cwd: "/unused", prompt: "test",
      artifactPrefix: "/unused/artifact", policy: { timeoutMs: 1000,
        execution: { provider: "codex-cli", authProvider: "fixture-session", parameters: {} } } })).rejects.toBe(failure);
    const terminal = events.find(event => event.type === "agent-failed");
    expect(terminal).toMatchObject({ type: "agent-failed", message: external ? failure.message
      : "The agent request failed. Inspect its runtime diagnostics before retrying." });
    expect(JSON.stringify(events)).not.toMatch(/opaque-key-value|private\/provider-runtime|TypeError/);
  });
});
