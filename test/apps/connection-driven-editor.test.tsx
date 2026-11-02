// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDefaultAgentExecutionProviderEditorDescriptors, validateAgentRunPolicyProviderSchema } from "@com-pyvue/agent-execution-core";
import { StructuredRunConfigurationEditor } from "../../apps/packages/run-configuration/react/src/structuredRunConfigurationEditor.tsx";
import type { JsonObject } from "../../apps/packages/run-configuration/contract/src/index.ts";
import type { ExecutionProviderEditorDescriptorDto } from "../../apps/packages/agent-template/contract/src/index.ts";

afterEach(cleanup);
// All four candidate types are fixtures only. This does not admit unproven live sessions.
const providers = JSON.parse(JSON.stringify(createDefaultAgentExecutionProviderEditorDescriptors({ piModelCatalogs: {
  "openai-codex": [{ value: "codex-model", label: "Codex model" }],
  anthropic: [{ value: "claude-model", label: "Claude model" }],
} }).filter((provider) => provider.providerId !== "kimi-code-cli").map((provider) => ({
  ...provider, connectionDriven: true,
  authProviderOptions: provider.providerId === "pi-cli" ? [
    { value: "pi-codex", label: "Pi Codex", modelProvider: "openai-codex" },
    { value: "pi-anthropic-api-key", label: "Pi Claude API key", modelProvider: "anthropic" },
  ] : [{ value: provider.providerId, label: provider.displayName, modelProvider: provider.providerId === "codex-cli" ? "openai" : "anthropic" }],
})))) as ExecutionProviderEditorDescriptorDto[];

function Editor({ initialAuth = "codex-cli" }: { initialAuth?: string }) {
  const [definition, setDefinition] = useState<JsonObject>({ configurationId: "draft", agents: {
    author: { timeoutMs: 120_000, execution: { provider: "codex-cli", authProvider: initialAuth, parameters: { model: "gpt-5.6-luna", model_reasoning_effort: "high" } } },
    critic: { timeoutMs: 120_000, execution: { provider: "codex-cli", authProvider: "codex-cli", parameters: { model: "gpt-5.6-luna" } } },
  } });
  return <><StructuredRunConfigurationEditor definition={definition} agentSlots={[{ slotId: "author", title: "Author" }, { slotId: "critic", title: "Critic" }]}
    providers={providers} templates={[]} selectedTemplates={{}} comparisonConfigurationId="" comparisonDefinitions={[]}
    onComparisonConfigurationChange={() => {}} onTemplateChange={() => {}} onChange={setDefinition} /><output data-testid="draft">{JSON.stringify(definition)}</output></>;
}
function policy() { return JSON.parse(screen.getByTestId("draft").textContent!).agents.author; }

it("switches through all four Connection types with independent, schema-valid slot parameters", async () => {
  render(<Editor />);
  const select = screen.getByRole("combobox", { name: "Author Connection" });
  await userEvent.selectOptions(select, "pi-codex");
  expect(policy()).toEqual({ timeoutMs: 120_000, execution: { provider: "pi-cli", authProvider: "pi-codex", parameters: { provider: "openai-codex", model: "codex-model" } } });
  expect(screen.queryByLabelText("Author Reasoning effort")).toBeNull();
  expect(screen.getByLabelText("Author Thinking")).toBeTruthy();
  await userEvent.selectOptions(select, "pi-anthropic-api-key");
  expect(policy().execution.authProvider).toBe("pi-anthropic-api-key");
  expect(policy().execution.parameters).toEqual({ provider: "anthropic", model: "claude-model" });
  expect(within(screen.getByLabelText("Author Model")).getAllByRole("option").map((option) => option.textContent)).toEqual(["claude-model"]);
  await userEvent.selectOptions(select, "claude-code-cli");
  expect(policy().execution.parameters).toEqual({ model: "sonnet" });
  expect(screen.getByLabelText("Author Permission mode")).toBeTruthy();
  expect(screen.queryByLabelText("Author Thinking")).toBeNull();
  expect(() => validateAgentRunPolicyProviderSchema(policy(), providers, "author")).not.toThrow();
  await userEvent.selectOptions(select, "codex-cli");
  expect(policy().execution.parameters).toEqual({ model: "gpt-5.6-luna" });
  expect(() => validateAgentRunPolicyProviderSchema(policy(), providers, "author")).not.toThrow();
  expect(screen.getByLabelText("Critic Connection")).toHaveProperty("value", "codex-cli");
  expect(screen.getByLabelText("Author runtime provider")).toHaveProperty("disabled", true);
});

it("shows a stale Connection explicitly instead of pretending the first option is selected", () => {
  render(<Editor initialAuth="archived-connection" />);
  expect(screen.getByLabelText("Author Connection")).toHaveProperty("value", "");
  expect(screen.getByRole("alert").textContent).toContain("active compatible Connection");
  expect(policy().execution.authProvider).toBe("archived-connection");
});
