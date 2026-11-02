// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentTemplateApiClient } from "../../apps/packages/agent-template/contract/src/index.ts";
import { AgentTemplateFeature } from "../../apps/packages/agent-template/react/src/index.ts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Agent Template React feature", () => {
  it("copies a platform preset into an editable custom template and soft-deletes it", async () => {
    vi.stubGlobal("scrollTo", vi.fn());
    const fixture = clientForApi();
    renderWithQueries(<AgentTemplateFeature client={fixture.client} />);

    expect(await screen.findByText("Pi CLI default")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(screen.getByLabelText("Template ID")).toHaveProperty("value", "pi-cli-default-custom-v1");
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Fast Pi");
    await userEvent.selectOptions(screen.getByLabelText("Authentication provider"), "arkimux-dev-key");
    expect(screen.getByLabelText("Model provider")).toHaveProperty("value", "openai");
    expect(screen.getByLabelText("Model")).toHaveProperty("value", "gpt-4.1-mini");
    await userEvent.selectOptions(screen.getByLabelText("Authentication provider"), "pi-openai-codex-session");
    await userEvent.selectOptions(screen.getByLabelText("Model"), "gpt-5.3-codex-spark");
    await userEvent.click(screen.getByRole("button", { name: "Publish template" }));

    expect(await screen.findByText("Fast Pi")).toBeTruthy();
    expect(fixture.templates.find(({ templateId }) => templateId === "pi-cli-default-custom-v1"))
      .toMatchObject({
        origin: "custom",
        policy: { execution: { parameters: { model: "gpt-5.3-codex-spark" } } },
      });
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitForMissing(() => screen.queryByText("Fast Pi"));
    await userEvent.click(screen.getByLabelText("Show archived custom templates"));
    expect(await screen.findByText("Fast Pi")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });
});

function clientForApi() {
  const templates: Array<Record<string, unknown>> = [platformTemplate()];
  const statuses = new Map<string, "active" | "archived">();
  const client = new AgentTemplateApiClient({
    baseUrl: "http://templates.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/editor-metadata")) return json({ executionProviders: [piDescriptor] });
      if (url.pathname === "/api/v1/agent-templates" && (init?.method ?? "GET") === "GET") {
        const requested = url.searchParams.get("lifecycleStatus") ?? "active";
        return json({
          items: templates.flatMap((template) => {
            const templateId = String(template.templateId);
            const lifecycleStatus = statuses.get(templateId) ?? "active";
            if (requested !== "all" && requested !== lifecycleStatus) return [];
            return [dto(template, lifecycleStatus)];
          }),
          pagination: {},
        });
      }
      if (url.pathname === "/api/v1/agent-templates" && init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as { definition: Record<string, unknown> };
        templates.push(structuredClone(request.definition));
        return json({ definition: dto(request.definition, "active") }, 201);
      }
      const lifecycle = /^\/api\/v1\/agent-templates\/([^/]+)\/(archive|restore)$/.exec(url.pathname);
      if (lifecycle && init?.method === "POST") {
        const templateId = decodeURIComponent(lifecycle[1]!);
        const status = lifecycle[2] === "archive" ? "archived" : "active";
        statuses.set(templateId, status);
        return json({ definition: dto(templates.find((template) => template.templateId === templateId)!, status) });
      }
      return json({ error: { code: "not-found", message: `No fixture for ${url.pathname}.` } }, 404);
    },
  });
  return { client, templates };
}

const piDescriptor = {
  providerId: "pi-cli",
  schemaVersion: 1,
  displayName: "Pi CLI",
  defaultAuthProviderId: "pi-openai-codex-session",
  authProviderOptions: [{ value: "pi-openai-codex-session", label: "Pi OpenAI Codex session", modelProvider: "openai-codex" }, { value: "arkimux-dev-key", label: "ArkiMux development key", modelProvider: "openai" }],
  allowsCustomAuthProvider: false,
  allowsAdditionalParameters: false,
  fields: [
    { key: "provider", label: "Model provider", kind: "string", required: true, defaultValue: "openai-codex", allowsCustomValue: false, suggestions: [{ value: "openai-codex", label: "OpenAI Codex" }, { value: "openai", label: "OpenAI" }] },
    { key: "model", label: "Model", kind: "string", required: true, allowsCustomValue: false, conditionalSuggestions: [{ parameterKey: "provider", parameterValue: "openai-codex", options: ["gpt-5.3-codex-spark", "gpt-5.6-luna"].map((value) => ({ value, label: value })) }, { parameterKey: "provider", parameterValue: "openai", options: [{ value: "gpt-4.1-mini", label: "gpt-4.1-mini" }] }] },
    { key: "thinking", label: "Thinking", kind: "enum", required: false, options: [{ value: "high", label: "high" }] },
  ],
};

function platformTemplate() {
  return {
    schemaVersion: 1,
    templateId: "pi-cli-default-v1",
    title: "Pi CLI default",
    origin: "platform",
    providerSchema: { executionProvider: "pi-cli", schemaVersion: 1 },
    policy: {
      timeoutMs: 900_000,
      execution: {
        provider: "pi-cli",
        authProvider: "pi-openai-codex-session",
        parameters: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      },
    },
  };
}

function dto(template: Record<string, unknown>, lifecycleStatus: "active" | "archived") {
  return {
    templateId: template.templateId,
    title: template.title,
    origin: template.origin,
    lifecycleStatus,
    contentHash: template.origin === "platform" ? "a".repeat(64) : "b".repeat(64),
    redactedDefinition: template,
  };
}

function renderWithQueries(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

async function waitForMissing(query: () => Element | null): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (query() === null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(query()).toBeNull();
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
