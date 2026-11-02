// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentTemplateApiClient } from "../../apps/packages/agent-template/contract/src/index.ts";
import { RunApiClient } from "../../apps/packages/run/contract/src/index.ts";
import { RunConfigurationApiClient } from "../../apps/packages/run-configuration/contract/src/index.ts";
import {
  newestRunConfigurationsFirst,
  RunConfigurationFeature,
} from "../../apps/packages/run-configuration/react/src/index.ts";
import { ResultRendererRegistry } from "../../apps/packages/result-presentation/src/index.ts";
import { WorkflowDetailFeature } from "../../apps/packages/run/react/src/workflowCatalogFeature.tsx";

afterEach(cleanup);

it("orders Run Configurations by creation time descending", () => {
  expect(newestRunConfigurationsFirst([
    { configurationId: "middle-v1", createdAt: "2026-08-20T10:00:00.000Z" },
    { configurationId: "newest-v1", createdAt: "2026-08-21T10:00:00.000Z" },
    { configurationId: "legacy-v1" },
    { configurationId: "oldest-v1", createdAt: "2026-08-19T10:00:00.000Z" },
  ]).map(({ configurationId }) => configurationId)).toEqual([
    "newest-v1",
    "middle-v1",
    "oldest-v1",
    "legacy-v1",
  ]);
});

const workflow = {
  workflow: { kind: "fixture.workflow", version: 1 },
  title: "Fixture workflow",
  inputExample: {},
  agentSlots: [
    { slotId: "researcher", title: "Researcher" },
    { slotId: "reviewer", title: "Reviewer" },
  ],
  runConfigurationBase: {
    schemaVersion: 3,
    agentTemplateProvenance: {},
    stores: {},
    workflowStores: {},
    capabilities: {},
  },
  allowedRoleIds: ["runner"],
};

describe("workflow-owned Run Configuration feature", () => {
  it("copies template defaults without replacing the chosen Connection or creating a template", async () => {
    let published: Record<string, unknown> | undefined;
    const runClient = new RunConfigurationApiClient({ baseUrl: "http://run-config.test", fetch: async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") return json({ items: [], pagination: {} });
      published = JSON.parse(String(init?.body)).definition;
      return json({ definition: dto(published!) });
    } });
    renderWithQueries(<RunConfigurationFeature client={runClient} agentTemplateClient={templateClient(true)} workflow={workflow} />);
    await userEvent.click(screen.getByRole("button", { name: "Create configuration" }));
    await userEvent.selectOptions(await screen.findByLabelText("Researcher Connection"), "arkimux-dev-key");
    await userEvent.selectOptions(screen.getByLabelText("Researcher Agent Template"), "pi-cli-default-v1");
    expect(screen.getByLabelText("Researcher Connection")).toHaveProperty("value", "arkimux-dev-key");
    expect(screen.getByLabelText("Researcher Model provider")).toHaveProperty("value", "openai");
    expect(screen.getByLabelText("Researcher Model")).toHaveProperty("value", "gpt-4.1-mini");
    await userEvent.click(screen.getByRole("button", { name: "Publish immutable configuration" }));
    await vi.waitFor(() => expect(published).toMatchObject({ agents: { researcher: { execution: { provider: "pi-cli", authProvider: "arkimux-dev-key", parameters: { provider: "openai", model: "gpt-4.1-mini", thinking: "high" } } } } }));
  });

  it("copies one reusable Agent Template per slot and publishes independently tuned providers", async () => {
    let published: Record<string, unknown> | undefined;
    const runClient = new RunConfigurationApiClient({
      baseUrl: "http://run-config.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if ((init?.method ?? "GET") === "GET") return json({ items: [], pagination: {} });
        const body = JSON.parse(String(init?.body)) as { definition: Record<string, unknown> };
        if (init?.method === "POST" && url.pathname.endsWith("/run-configurations")) published = body.definition;
        return json({ definition: dto(body.definition) });
      },
    });
    renderWithQueries(<RunConfigurationFeature client={runClient} agentTemplateClient={templateClient()} workflow={workflow} />);

    await userEvent.click(screen.getByRole("button", { name: "Create configuration" }));
    expect(screen.getByRole("dialog").className).toContain("96rem");
    const selectors = await screen.findAllByRole("combobox", { name: /Agent Template/ });
    expect(selectors[0]).toHaveProperty("value", "codex-cli-default-v1");
    expect(selectors[1]).toHaveProperty("value", "codex-cli-default-v1");
    await userEvent.selectOptions(selectors[0]!, "pi-cli-default-v1");
    expect(screen.getByLabelText("Researcher runtime provider")).toHaveProperty("value", "Pi CLI");
    expect(screen.getByLabelText("Researcher runtime provider")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Reviewer runtime provider")).toHaveProperty("value", "Codex CLI");
    expect(screen.getByLabelText("Researcher authentication").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Researcher Model provider").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Researcher Model").tagName).toBe("SELECT");
    expect(within(screen.getByLabelText("Researcher Model")).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(within(screen.getByLabelText("Researcher authentication")).queryByRole("option", { name: "Custom…" })).toBeNull();
    expect(within(screen.getByLabelText("Researcher Model provider")).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["openai-codex"]);
    await userEvent.selectOptions(screen.getByLabelText("Researcher authentication"), "arkimux-dev-key");
    expect(screen.getByLabelText("Researcher Model provider")).toHaveProperty("value", "openai");
    expect(within(screen.getByLabelText("Researcher Model provider")).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["openai"]);
    expect(within(screen.getByLabelText("Researcher Model")).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["gpt-4.1-mini"]);
    await userEvent.selectOptions(screen.getByLabelText("Reviewer Model"), "gpt-5.6-sol");
    await userEvent.click(screen.getByRole("button", { name: "Publish immutable configuration" }));

    await vi.waitFor(() => expect(published).toBeDefined());
    expect(published).toMatchObject({
      configurationId: "fixture-workflow-v1",
      workflow: { kind: "fixture.workflow", version: 1 },
      agents: {
        researcher: { execution: { provider: "pi-cli" } },
        reviewer: { execution: { provider: "codex-cli", parameters: { model: "gpt-5.6-sol" } } },
      },
      agentTemplateProvenance: {
        researcher: { templateId: "pi-cli-default-v1" },
        reviewer: { templateId: "codex-cli-default-v1" },
      },
    });
  });

  it("keeps slot tuning independent and compares the draft with an existing configuration", async () => {
    const existing = dto({
      ...workflow.runConfigurationBase,
      configurationId: "fixture-workflow-v1",
      workflow: workflow.workflow,
      agents: {
        researcher: { timeoutMs: 900_000, execution: { provider: "codex-cli", authProvider: "codex-native-session", parameters: { model: "gpt-5.6-sol", model_reasoning_effort: "high" } } },
        reviewer: { timeoutMs: 900_000, execution: { provider: "codex-cli", authProvider: "codex-native-session", parameters: { model: "gpt-5.6-luna", model_reasoning_effort: "high" } } },
      },
      agentTemplateProvenance: {
        researcher: { templateId: "codex-cli-default-v1", templateContentHash: "b".repeat(64) },
        reviewer: { templateId: "codex-cli-default-v1", templateContentHash: "b".repeat(64) },
      },
    });
    const runClient = new RunConfigurationApiClient({
      baseUrl: "http://run-config.test",
      fetch: async () => json({ items: [existing], pagination: {} }),
    });
    renderWithQueries(<RunConfigurationFeature client={runClient} agentTemplateClient={templateClient()} workflow={workflow} />);

    await userEvent.click(screen.getByRole("button", { name: "Create configuration" }));
    expect(screen.queryByLabelText("Copy setup from")).toBeNull();
    expect(screen.queryByText("Changes from the base version")).toBeNull();
    await userEvent.selectOptions(await screen.findByLabelText("Compare with existing configuration"), "fixture-workflow-v1");

    const researcherComparison = screen.getByLabelText("Researcher comparison");
    expect(within(researcherComparison).getByText("Compared with fixture-workflow-v1")).toBeTruthy();
    expect(screen.getByLabelText("Researcher compared Model").textContent).toContain("gpt-5.6-sol");
    expect(screen.getByLabelText("Researcher compared Model").getAttribute("data-different")).toBe("true");
    expect(within(screen.getByLabelText("Researcher compared Model")).getByText("Draft: gpt-5.6-luna")).toBeTruthy();
    expect(screen.getByLabelText("Researcher compared Agent Template").getAttribute("data-different")).toBeNull();
    expect(within(screen.getByLabelText("Reviewer comparison")).getByText("Matches draft")).toBeTruthy();
  });

  it("renders published configurations as a table with independently expandable Agent Slot details", async () => {
    const existing = dto({
      ...workflow.runConfigurationBase,
      configurationId: "fixture-workflow-v1",
      workflow: workflow.workflow,
      agents: { researcher: { execution: { provider: "codex-cli" } }, reviewer: { execution: { provider: "pi-cli" } } },
    });
    const runClient = new RunConfigurationApiClient({ baseUrl: "http://run-config.test", fetch: async () => json({ items: [existing], pagination: {} }) });
    renderWithQueries(<RunConfigurationFeature client={runClient} agentTemplateClient={templateClient()} workflow={workflow} />);

    expect(await screen.findByRole("table", { name: "Published run configurations" })).toBeTruthy();
    const configuration = await screen.findByRole("button", { name: /fixture-workflow-v1/ });
    expect(configuration.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(configuration);
    expect(configuration.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText((_, element) => element?.tagName === "SUMMARY" && element.textContent?.includes("Researcher") === true)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(configuration.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(configuration.getAttribute("aria-expanded")).toBe("true");
    expect([...document.querySelectorAll("details")].every((detail) => detail.open)).toBe(true);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  });

  it("selects and archives multiple immutable workflow configurations", async () => {
    const definitions = ["fixture-workflow-v1", "fixture-workflow-v2"].map((configurationId) => dto({
      ...workflow.runConfigurationBase,
      configurationId,
      workflow: workflow.workflow,
      agents: { researcher: { execution: { provider: "codex-cli" } }, reviewer: { execution: { provider: "pi-cli" } } },
    }));
    const archived: string[] = [];
    const runClient = new RunConfigurationApiClient({
      baseUrl: "http://run-config.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const match = /\/run-configurations\/([^/]+)\/archive$/.exec(url.pathname);
        if (match && init?.method === "POST") {
          archived.push(match[1]!);
          return json({ definition: { ...definitions.find(({ configurationId }) => configurationId === match[1])!, lifecycleStatus: "archived" } });
        }
        return json({ items: definitions, pagination: {} });
      },
    });
    renderWithQueries(<RunConfigurationFeature client={runClient} agentTemplateClient={templateClient()} workflow={workflow} />);

    await screen.findByText("fixture-workflow-v1");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all active configurations" }));
    await userEvent.click(screen.getByRole("button", { name: "Archive selected (2)" }));
    await vi.waitFor(() => expect(archived.sort()).toEqual(["fixture-workflow-v1", "fixture-workflow-v2"]));
  });

  it("does not create a run configuration until the user explicitly publishes it", async () => {
    const publish = vi.fn();
    const runClient = new RunConfigurationApiClient({
      baseUrl: "http://run-config.test",
      fetch: async (input, init) => {
        if (init?.method === "POST") publish();
        return json({ items: [], pagination: {} });
      },
    });
    renderWithQueries(<RunConfigurationFeature client={runClient} agentTemplateClient={templateClient()} workflow={workflow} />);
    await screen.findByText("No configurations.");
    expect(publish).not.toHaveBeenCalled();
  });

  it("lets a workflow-owned schema omit optional template provenance", async () => {
    let published: Record<string, unknown> | undefined;
    const runClient = new RunConfigurationApiClient({
      baseUrl: "http://run-config.test",
      fetch: async (input, init) => {
        if ((init?.method ?? "GET") === "GET") return json({ items: [], pagination: {} });
        const body = JSON.parse(String(init?.body)) as { definition: Record<string, unknown> };
        published = body.definition;
        return json({ definition: dto(body.definition) });
      },
    });
    renderWithQueries(<RunConfigurationFeature
      client={runClient}
      agentTemplateClient={templateClient()}
      workflow={{ ...workflow, runConfigurationBase: { schemaVersion: 1 } }}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Create configuration" }));
    const selectors = await screen.findAllByRole("combobox", { name: /Agent Template/ });
    await userEvent.selectOptions(selectors[0]!, "pi-cli-default-v1");
    await userEvent.click(screen.getByRole("button", { name: "Publish immutable configuration" }));
    await vi.waitFor(() => expect(published).toBeDefined());
    expect(published).toMatchObject({ schemaVersion: 1 });
    expect(published).not.toHaveProperty("agentTemplateProvenance");
  });

  it("adds a newly published configuration to the workflow invocation dropdown", async () => {
    const definitions: ReturnType<typeof dto>[] = [];
    const listRequests: URL[] = [];
    const runConfigurationClient = new RunConfigurationApiClient({
      baseUrl: "http://run-config.test",
      fetch: async (input, init) => {
        if ((init?.method ?? "GET") === "GET") { listRequests.push(new URL(String(input))); return json({ items: definitions, pagination: {} }); }
        const body = JSON.parse(String(init?.body)) as { definition: Record<string, unknown> };
        const published = dto(body.definition);
        definitions.push(published);
        return json({ definition: published });
      },
    });
    const runClient = new RunApiClient({
      baseUrl: "http://runs.test",
      fetch: async (input) => new URL(String(input)).pathname.endsWith("/preflight")
        ? json({ available: true, agents: [] })
        : json({ items: [workflow] }),
    });
    renderWithQueries(<WorkflowDetailFeature
      runClient={runClient}
      runConfigurationClient={runConfigurationClient}
      agentTemplateClient={templateClient()}
      workflowKind={workflow.workflow.kind}
      workflowVersion={workflow.workflow.version}
      resultRenderers={new ResultRendererRegistry()}
      onRunSubmitted={vi.fn()}
    />);

    expect(await screen.findByText("Create a Run Configuration before invoking this workflow.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Fixture workflow" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Run Configurations" }).getAttribute("aria-selected")).toBe("true");
    expect(listRequests.length).toBeGreaterThan(0);
    expect(listRequests.every(url => url.pathname.includes("fixture.workflow") && url.pathname.includes("/1/"))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Create configuration" }));
    const selectors = await screen.findAllByRole("combobox", { name: /Agent Template/ });
    await userEvent.selectOptions(selectors[0]!, "pi-cli-default-v1");
    await userEvent.click(screen.getByRole("button", { name: "Publish immutable configuration" }));

    await userEvent.click(screen.getByRole("button", { name: "Invoke Workflow" }));
    const invocation = await screen.findByRole("combobox", { name: "Run configuration" });
    expect(invocation).toHaveProperty("value", "fixture-workflow-v1");
    expect(screen.getByRole("option", { name: "fixture-workflow-v1" })).toBeTruthy();
  });

  it("uses declared graph entry labels and schema help instead of internal boundary names", async () => {
    const submitted: unknown[] = [];
    const graphWorkflow = { ...workflow, invocationModel: "graph-entry" as const };
    const definition = dto({ configurationId: "fixture-workflow-v1", workflow: graphWorkflow.workflow,
      schemaVersion: 1, agents: {} });
    const runConfigurationClient = new RunConfigurationApiClient({ baseUrl: "http://run-config.test",
      fetch: async () => json({ items: [definition], pagination: {} }) });
    const mapInput = { item: 2, index: 1, context: { offset: 22 } };
    const entries = [
      { id: "step1", label: "Step 1", nodeKind: "step", entry: { kind: "default" }, requirements: [{
        id: "entry", role: "entry-input", contractVersion: "1", schema: { type: "number" }, provenance: "caller-supplied",
      }] },
      { id: "step2", label: "Step 2", nodeKind: "step", entry: { kind: "selected", address: { schemaVersion: 1, path: [{ nodeId: "step2" }] } }, requirements: [{
        id: "entry", role: "entry-input", contractVersion: "1", schema: { type: "number" }, provenance: "caller-supplied",
      }] },
      { id: "map-item-1", label: "Map item 2", nodeKind: "step", entry: { kind: "selected", address: { schemaVersion: 1, path: [
        { nodeId: "map", occurrence: { kind: "map", index: 1 } }, { nodeId: "map-item" },
      ] } }, requirements: [{ id: "entry", role: "entry-input", contractVersion: "1", provenance: "caller-supplied", schema: {
        type: "object", title: "Map item input", description: "The item, position, and shared context for the selected map execution.",
        examples: [mapInput], properties: {
          item: { type: "integer", description: "Value at the selected position in the map input." },
          index: { type: "integer", description: "Zero-based position of this value." },
          context: { type: "object", description: "Shared values supplied to every map item.", properties: {
            offset: { type: "integer", description: "Branch result added to every mapped value." },
          }, required: ["offset"] },
        }, required: ["item", "index", "context"],
      } }] },
    ];
    const runClient = new RunApiClient({ baseUrl: "http://runs.test", fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/preflight")) return json({ available: true, agents: [] });
      if (path.endsWith("/invocation-options")) return json({ model: "graph-entry", entries });
      if (path.endsWith("/runs") && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return json({ runRef: { executionId: "graph-run" } }, 202);
      }
      return json({ items: [graphWorkflow] });
    } });
    const onRunSubmitted = vi.fn();
    renderWithQueries(<WorkflowDetailFeature runClient={runClient} runConfigurationClient={runConfigurationClient}
      agentTemplateClient={templateClient()} workflowKind={graphWorkflow.workflow.kind}
      workflowVersion={graphWorkflow.workflow.version} resultRenderers={new ResultRendererRegistry()}
      onRunSubmitted={onRunSubmitted} />);

    await userEvent.click(await screen.findByRole("button", { name: "Invoke Workflow" }));
    const entry = await screen.findByRole("combobox", { name: "Starting step" });
    expect(within(entry).getAllByRole("option").map(option => option.textContent)).toEqual(["Step 1", "Step 2", "Map item 2"]);
    await userEvent.selectOptions(entry, "map-item-1");
    const editor = await screen.findByRole("textbox", { name: /Map item input/ });
    expect(screen.getByText("The item, position, and shared context for the selected map execution.")).toBeTruthy();
    await userEvent.click(screen.getByText("Example input"));
    await userEvent.click(screen.getByRole("button", { name: "Use example" }));
    expect(editor).toHaveProperty("value", JSON.stringify(mapInput, null, 2));
    await userEvent.click(screen.getByText("Input fields"));
    expect(screen.getByText("Value at the selected position in the map input.")).toBeTruthy();
    expect(screen.getByText("Branch result added to every mapped value.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Invoke" }));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ input: { acquisition: "supplied", values: { entry: mapInput } } });
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Invoke Fixture workflow" })).toBeNull());
    expect(onRunSubmitted).toHaveBeenCalledWith("graph-run");
  });

  it("shows unavailable Agent Slots and disables run submission", async () => {
    const definition = dto({
      configurationId: "fixture-workflow-v1",
      workflow: workflow.workflow,
      schemaVersion: 1,
      agents: {},
    });
    const runConfigurationClient = new RunConfigurationApiClient({
      baseUrl: "http://run-config.test",
      fetch: async () => json({ items: [definition], pagination: {} }),
    });
    const runClient = new RunApiClient({
      baseUrl: "http://runs.test",
      fetch: async (input) => new URL(String(input)).pathname.endsWith("/preflight")
        ? json({ available: false, agents: [{
            slotId: "researcher",
            providerId: "pi-cli",
            authProviderId: "pi-openai-codex-session",
            available: false,
            status: "unavailable",
            reason: "provider-unavailable",
            message: "Agent execution provider pi-cli could not find command pi.",
          }] })
        : json({ items: [workflow] }),
    });
    renderWithQueries(<WorkflowDetailFeature
      runClient={runClient}
      runConfigurationClient={runConfigurationClient}
      agentTemplateClient={templateClient()}
      workflowKind={workflow.workflow.kind}
      workflowVersion={workflow.workflow.version}
      resultRenderers={new ResultRendererRegistry()}
      onRunSubmitted={vi.fn()}
    />);

    await userEvent.click(await screen.findByRole("button", { name: "Invoke Workflow" }));
    expect(await screen.findByText(/could not find command pi/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invoke" })).toHaveProperty("disabled", true);
  });

  it("shows advisory Claude plan readiness without blocking invocation", async () => {
    const definition = dto({
      configurationId: "fixture-workflow-v1",
      workflow: workflow.workflow,
      schemaVersion: 1,
      agents: {},
    });
    const runConfigurationClient = new RunConfigurationApiClient({
      baseUrl: "http://run-config.test",
      fetch: async () => json({ items: [definition], pagination: {} }),
    });
    const runClient = new RunApiClient({
      baseUrl: "http://runs.test",
      fetch: async (input) => new URL(String(input)).pathname.endsWith("/preflight")
        ? json({ available: true, agents: [{
            slotId: "researcher",
            providerId: "claude-code-cli",
            authProviderId: "claude-code-native-session",
            available: true,
            status: "indeterminate",
            reason: "unknown",
            identity: { accountEmail: "developer@example.com", reportedPlan: "free" },
            remediation: [
              { kind: "upgrade", label: "Review Claude Code plan eligibility" },
              { kind: "configure-api-key", label: "Configure an Anthropic API key" },
            ],
            message: "Claude reports a Free session. Claude Code eligibility will be confirmed when execution starts.",
          }] })
        : json({ items: [workflow] }),
    });
    renderWithQueries(<WorkflowDetailFeature
      runClient={runClient}
      runConfigurationClient={runConfigurationClient}
      agentTemplateClient={templateClient()}
      workflowKind={workflow.workflow.kind}
      workflowVersion={workflow.workflow.version}
      resultRenderers={new ResultRendererRegistry()}
      onRunSubmitted={vi.fn()}
    />);

    await userEvent.click(await screen.findByRole("button", { name: "Invoke Workflow" }));
    expect(await screen.findByText(/Eligibility unconfirmed via claude-code-cli/)).toBeTruthy();
    expect(screen.getByText(/plan free/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invoke" })).toHaveProperty("disabled", false);
  });
});

function templateClient(connectionDriven = false): AgentTemplateApiClient {
  return new AgentTemplateApiClient({
    baseUrl: "http://templates.test",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/editor-metadata")) return json({ executionProviders: providers.map((provider) => ({ ...provider, ...(connectionDriven ? { connectionDriven } : {}) })) });
      return json({ items: [
        template("pi-cli-default-v1", "Pi", "pi-cli", { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" }),
        template("codex-cli-default-v1", "Codex CLI Default", "codex-cli", { model: "gpt-5.6-luna", model_reasoning_effort: "high" }),
      ], pagination: {} });
    },
  });
}

const providers = [
  { providerId: "codex-cli", schemaVersion: 1, displayName: "Codex CLI", defaultAuthProviderId: "codex-native-session", authProviderOptions: [{ value: "codex-native-session", label: "Codex native session" }], allowsCustomAuthProvider: false, allowsAdditionalParameters: true, fields: [
    { key: "model", label: "Model", kind: "string", required: true, allowsCustomValue: true, suggestions: ["gpt-5.6-luna", "gpt-5.6-sol"].map((value) => ({ value, label: value })) },
    { key: "model_reasoning_effort", label: "Reasoning effort", kind: "enum", required: false, options: [{ value: "high", label: "high" }] },
  ] },
  { providerId: "pi-cli", schemaVersion: 1, displayName: "Pi CLI", defaultAuthProviderId: "pi-openai-codex-session", authProviderOptions: [{ value: "pi-openai-codex-session", label: "Pi OpenAI Codex session", modelProvider: "openai-codex" }, { value: "arkimux-dev-key", label: "ArkiMux development key", modelProvider: "openai" }], allowsCustomAuthProvider: false, allowsAdditionalParameters: false, fields: [
    { key: "provider", label: "Model provider", kind: "string", required: true, defaultValue: "openai-codex", allowsCustomValue: false, suggestions: [{ value: "openai-codex", label: "openai-codex" }, { value: "openai", label: "openai" }] },
    { key: "model", label: "Model", kind: "string", required: true, allowsCustomValue: false, conditionalSuggestions: [{ parameterKey: "provider", parameterValue: "openai-codex", options: ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"].map((value) => ({ value, label: value })) }, { parameterKey: "provider", parameterValue: "openai", options: [{ value: "gpt-4.1-mini", label: "gpt-4.1-mini" }] }] },
    { key: "thinking", label: "Thinking", kind: "enum", required: false, options: [{ value: "high", label: "high" }] },
  ] },
];

function template(templateId: string, title: string, provider: "pi-cli" | "codex-cli", parameters: Record<string, string>) {
  const policy = { timeoutMs: 900_000, execution: { provider, authProvider: provider === "pi-cli" ? "pi-openai-codex-session" : "codex-native-session", parameters } };
  return { templateId, title, origin: "platform", lifecycleStatus: "active", contentHash: provider === "pi-cli" ? "a".repeat(64) : "b".repeat(64), redactedDefinition: { schemaVersion: 1, templateId, title, origin: "platform", providerSchema: { executionProvider: provider, schemaVersion: 1 }, policy } };
}

function dto(definition: Record<string, unknown>) {
  return { configurationId: definition.configurationId, workflow: definition.workflow, lifecycleStatus: "active", contentHash: "c".repeat(64), redactedDefinition: definition };
}
function renderWithQueries(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
