// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderWithToaster as render } from "./renderWithToaster.tsx";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunApiClient } from "../../apps/packages/run/contract/src/index.ts";
import {
  ResultRendererRegistry,
  type ResultReactPlugin,
} from "../../apps/packages/result-presentation/src/index.ts";
import {
  RunFeature,
  RunDetailPage,
  RunResultsView,
  runDetailRefetchInterval,
  runListRefetchInterval,
  workflowDevelopmentRunColumns,
} from "../../apps/packages/run/react/src/index.ts";

const timestamp = "2026-08-05T12:00:00.000Z";
const hash = "a".repeat(64);
const storage = new Map<string, string>();

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
});

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear(),
  });
});

afterEach(() => {
  cleanup();
  storage.clear();
  vi.unstubAllGlobals();
});

describe("Run React feature", () => {
  it("renders fetched results without a browser telemetry request or visibility requirement", async () => {
    const fetch = vi.fn(async () => { throw new Error("Unexpected browser request"); });
    vi.stubGlobal("fetch", fetch);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    renderWithQueries(<RunDetailPage client={clientForApi()}
      executionId="run-codex" registry={new ResultRendererRegistry()} />);
    await screen.findByText("fixture.workflow@1 · owner");
    await userEvent.click(screen.getByRole("tab", { name: "Results" }));
    await screen.findByRole("heading", { name: "Generic JSON result" });
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(document, new Event("visibilitychange"));
    expect(fetch).not.toHaveBeenCalled();
    visibility.mockRestore();
  });
  it("uses terminal-aware polling and requires an explicit bounded comparison", async () => {
    expect(runDetailRefetchInterval(undefined)).toBe(2_000);
    expect(runDetailRefetchInterval("running")).toBe(2_000);
    expect(runDetailRefetchInterval("complete")).toBe(false);
    expect(runDetailRefetchInterval("failed")).toBe(false);
    expect(runListRefetchInterval(["running", "complete"])).toBe(2_000);
    expect(runListRefetchInterval(["waiting_for_input"])).toBe(2_000);
    expect(runListRefetchInterval(["complete", "failed", "cancelled"])).toBe(false);

    const client = clientForApi();
    renderWithQueries(<RunFeature client={client} resultRenderers={new ResultRendererRegistry()} />);
    expect(await screen.findByText("run-codex")).toBeTruthy();
    expect(screen.getByText("run-pi")).toBeTruthy();
    const compare = screen.getByRole("button", { name: "Compare 0 runs" });
    expect((compare as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select run-codex" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select run-pi" }));
    const enabled = screen.getByRole("button", { name: "Compare 2 runs" });
    expect((enabled as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(enabled);
    expect(await screen.findByRole("table", { name: "Selected run comparison" })).toBeTruthy();
    expect(screen.getByText("gpt-5.6-luna")).toBeTruthy();
    expect(screen.getByText("gpt-5.3-codex-spark")).toBeTruthy();
  });

  it("refreshes a Runs table until its visible Run reaches a terminal status", async () => {
    let requests = 0;
    const client = new RunApiClient({ baseUrl: "http://run-api.test", fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/runs") {
        const status = requests++ === 0 ? "running" : "complete";
        return json({ items: [run("active-run", status)], pagination: {} });
      }
      return json({ error: { code: "not-found", message: "not found" } }, 404);
    } });
    renderWithQueries(<RunFeature client={client} resultRenderers={new ResultRendererRegistry()} />);

    const table = await screen.findByRole("table", { name: "Runs" });
    expect(await within(table).findByText("running")).toBeTruthy();
    expect(await within(table).findByText("complete", {}, { timeout: 4_000 })).toBeTruthy();
    expect(requests).toBe(2);
  });

  it("delegates run navigation and renders a standalone live detail page", async () => {
    const client = clientForApi();
    const registry = new ResultRendererRegistry();
    renderWithQueries(<RunFeature
      client={client}
      resultRenderers={registry}
      renderRunLink={(executionId, label) => <a href={`/runs/${executionId}`}>{label}</a>}
    />);
    expect((await screen.findByRole("link", { name: "run-codex" })).getAttribute("href")).toBe("/runs/run-codex");
    cleanup();
    renderWithQueries(<RunDetailPage
      client={client}
      executionId="run-codex"
      registry={registry}
      backLink={<a href="/runs">Back</a>}
    />);
    expect(await screen.findByRole("heading", { name: "Run details" })).toBeTruthy();
    expect(await screen.findByText("fixture.workflow@1 · owner")).toBeTruthy();
    expect(document.body.textContent).not.toContain("outputRoot");
    expect(document.body.textContent).not.toContain("adapterId");
  });

  it("starts a linked corrected Run from editable copied input and cancels an active original", async () => {
    const submitted: unknown[] = [];
    const opened: string[] = [];
    const client = new RunApiClient({ baseUrl: "http://run-api.test", fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/runs/active-run" && !init?.method) return json({ run: {
        runRef: { executionId: "active-run" }, workflow: { kind: "fixture.workflow", version: 1 },
        actor: { userId: "owner", roleId: "runner" }, createdAt: timestamp,
        runConfiguration: { configurationId: "fixture-v1", contentHash: hash },
        status: { kind: "status", status: "running", updatedAt: timestamp },
      }, correction: null, correctedRuns: [] });
      if (url.pathname === "/api/v1/runs/active-run/input") return json({ runRef: { executionId: "active-run" }, input: { city: "Dubai" } });
      if (url.pathname === "/api/v1/runs" && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return json({ runRef: { executionId: "corrected-run" }, correction: { schemaVersion: 1,
          priorRunRef: { executionId: "active-run" }, correctedRunRef: { executionId: "corrected-run" }, createdAt: timestamp } }, 202);
      }
      return json({ error: { code: "not-found", message: "not found" } }, 404);
    } });
    renderWithQueries(<RunDetailPage client={client} executionId="active-run" registry={new ResultRendererRegistry()}
      onRunSubmitted={executionId => opened.push(executionId)} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start corrected run" }));
    const dialog = await screen.findByRole("dialog", { name: "Start a corrected Run" });
    expect(dialog.textContent).toContain("accepted input and history stay unchanged");
    expect(dialog.textContent).toContain("active original Run will be cancelled first");
    const editor = await within(dialog).findByRole("textbox", { name: "New starting input" });
    expect((editor as HTMLTextAreaElement).value).toContain("Dubai");
    fireEvent.change(editor, { target: { value: JSON.stringify({ city: "Istanbul" }) } });
    const confirm = within(dialog).getByRole("button", { name: "Start corrected run" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toEqual({
      workflow: { kind: "fixture.workflow", version: 1 }, roleId: "runner",
      runConfigurationId: "fixture-v1", input: { city: "Istanbul" },
      correction: { priorRunRef: { executionId: "active-run" }, activeOriginal: "cancel",
        acknowledgement: "new-run-from-start-effects-not-undone" },
    });
    await vi.waitFor(() => expect(opened).toEqual(["corrected-run"]));
  });

  it("seeds an inputless graph Run correction from the workflow example", async () => {
    const submitted: unknown[] = [];
    const example = { schemaVersion: 1, value: 10, values: [1, 2, 3], mode: "double", loopUntil: 80 };
    const expected = {
      schemaVersion: 1,
      acquisition: "supplied",
      entry: { kind: "default" },
      values: { entry: example },
    };
    const client = new RunApiClient({ baseUrl: "http://run-api.test", fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/runs/inputless-run" && !init?.method) {
        return json({ run: correctionRun("inputless-run", "cancelled"), correction: null, correctedRuns: [] });
      }
      if (url.pathname === "/api/v1/runs/inputless-run/input") {
        return json({ runRef: { executionId: "inputless-run" }, input: null });
      }
      if (url.pathname === "/api/v1/workflows") {
        return json({ items: [{
          workflow: { kind: "fixture.workflow", version: 1 }, invocationModel: "graph-entry",
          title: "Fixture graph", inputExample: example, agentSlots: [], allowedRoleIds: ["runner"],
        }] });
      }
      if (url.pathname === "/api/v1/runs" && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return json({ runRef: { executionId: "corrected-inputless-run" } }, 202);
      }
      return json({ error: { code: "not-found", message: "not found" } }, 404);
    } });

    renderWithQueries(<RunDetailPage client={client} executionId="inputless-run" registry={new ResultRendererRegistry()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start corrected run" }));
    const dialog = await screen.findByRole("dialog", { name: "Start a corrected Run" });
    expect(await within(dialog).findByText(/This Run has no accepted starting input/)).toBeTruthy();
    const editor = within(dialog).getByRole("textbox", { name: "New starting input" });
    expect((editor as HTMLTextAreaElement).value).toBe("");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Use workflow example" }));
    expect((editor as HTMLTextAreaElement).value).toBe(JSON.stringify(expected, null, 2));
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start corrected run" }));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ input: expected, correction: {
      priorRunRef: { executionId: "inputless-run" }, activeOriginal: "reject",
    } });
  });

  it("requires effects acknowledgement to cancel and renders authorized correction links", async () => {
    const cancellations: unknown[] = [];
    let status: "running" | "cancelled" = "running";
    const client = new RunApiClient({ baseUrl: "http://run-api.test", fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/runs/prior-run/cancel" && init?.method === "POST") {
        cancellations.push(JSON.parse(String(init.body)));
        status = "cancelled";
        return json({ run: correctionRun("prior-run", status) });
      }
      if (url.pathname === "/api/v1/runs/prior-run") return json({ run: correctionRun("prior-run", status),
        correction: { schemaVersion: 1, priorRunRef: { executionId: "first-run" }, correctedRunRef: { executionId: "prior-run" }, createdAt: timestamp },
        correctedRuns: [{ schemaVersion: 1, priorRunRef: { executionId: "prior-run" }, correctedRunRef: { executionId: "next-run" }, createdAt: timestamp }],
      });
      return json({ error: { code: "not-found", message: "not found" } }, 404);
    } });
    renderWithQueries(<RunDetailPage client={client} executionId="prior-run" registry={new ResultRendererRegistry()}
      renderRunLink={(executionId, label) => <a href={`/runs/${executionId}`}>{label}</a>} />);
    expect((await screen.findByRole("link", { name: "first-run" })).getAttribute("href")).toBe("/runs/first-run");
    expect(screen.getByRole("link", { name: "next-run" }).getAttribute("href")).toBe("/runs/next-run");
    await userEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this Run?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel run" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(cancel);
    await vi.waitFor(() => expect(cancellations).toEqual([{ acknowledgement: "external-effects-not-undone" }]));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull());
  });

  it("shows a pending graph input request and submits its exact retained boundary", async () => {
    const submitted: unknown[] = [];
    let accepted = false;
    const client = new RunApiClient({ baseUrl: "http://run-api.test", fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/runs/waiting-run") return json({ run: {
        runRef: { executionId: "waiting-run" }, workflow: { kind: "fixture.workflow", version: 1 },
        actor: { userId: "owner", roleId: "runner" }, createdAt: timestamp,
        runConfiguration: { configurationId: "fixture-v1", contentHash: hash },
        status: { kind: "status", status: "waiting_for_input", requestId: "graph-request-1",
          updatedAt: timestamp, expiresAt: "2026-08-06T12:00:00.000Z", activeComputeMs: 250 },
      } });
      if (url.pathname === "/api/v1/runs/waiting-run/input-requests" && init?.method !== "POST") return json({
        schemaVersion: 1, runRef: { executionId: "waiting-run" }, items: [{ kind: "graph-entry", schemaVersion: 1,
          requestId: "graph-request-1", status: accepted ? "submitted" : "pending", revision: accepted ? 2 : 1, updatedAt: timestamp,
          entry: { schemaVersion: 1, path: [{ nodeId: "calculate" }] }, planSha256: "c".repeat(64),
          requirements: [{ id: "entry", role: "entry-input", contractVersion: "1", schema: {
            type: "number", title: "Calculation input", description: "Number the calculation should process.", examples: [10],
          }, provenance: "caller-supplied" }],
          createdAt: timestamp, expiresAt: "2026-08-06T12:00:00.000Z",
          ...(accepted ? { accepted: { acceptanceId: "answer-1", acceptedAt: timestamp, acceptedBodySha256: "d".repeat(64) } } : {}),
        }],
      });
      if (url.pathname.endsWith("/input-requests/graph-request-1/response") && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        accepted = true;
        return json({ schemaVersion: 1, runRef: { executionId: "waiting-run" }, kind: "graph-entry",
          accepted: { schemaVersion: 1, acceptanceId: "answer-1", requestId: "graph-request-1",
            acceptedAt: timestamp, acceptedBodySha256: "d".repeat(64) } }, 202);
      }
      return json({ error: { code: "not-found", message: "not found" } }, 404);
    } });
    renderWithQueries(<RunDetailPage client={client} executionId="waiting-run" registry={new ResultRendererRegistry()} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Input" }));
    expect(await screen.findByText("Calculation input required")).toBeTruthy();
    expect(screen.getByText("Waiting for a person does not consume active workflow compute.")).toBeTruthy();
    const editor = screen.getByRole("textbox", { name: /Calculation input/i });
    expect(screen.getByText("Number the calculation should process.")).toBeTruthy();
    await userEvent.click(screen.getByText("Example input"));
    await userEvent.click(screen.getByRole("button", { name: "Use example" }));
    expect(editor).toHaveProperty("value", "10");
    await userEvent.click(screen.getByRole("button", { name: "Submit input" }));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ expectedRevision: 1, response: {
      schemaVersion: 1, planSha256: "c".repeat(64), values: { entry: 10 },
    } });
    expect(await screen.findByText("Input accepted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit input" })).toBeNull();
  });

  it("explains terminal input requests without presenting an editable form", async () => {
    const client = new RunApiClient({ baseUrl: "http://run-api.test", fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/runs/terminal-input") return json({ run: {
        runRef: { executionId: "terminal-input" }, workflow: { kind: "fixture.workflow", version: 1 },
        actor: { userId: "owner", roleId: "runner" }, createdAt: timestamp,
        status: { kind: "status", status: "cancelled", updatedAt: timestamp },
      } });
      if (url.pathname.endsWith("/input-requests")) return json({ schemaVersion: 1,
        runRef: { executionId: "terminal-input" }, items: ["expired", "cancelled"].map((status, index) => ({
          kind: "graph-entry", schemaVersion: 1, requestId: `request-${index}`, status, revision: 2, updatedAt: timestamp,
          entry: { schemaVersion: 1, path: [{ nodeId: `step-${index}` }] }, planSha256: "c".repeat(64),
          requirements: [{ id: "entry", role: "entry-input", contractVersion: "1", schema: { type: "number" }, provenance: "caller-supplied" }],
          createdAt: timestamp, expiresAt: "2026-08-06T12:00:00.000Z",
        })) });
      return json({ error: { code: "not-found", message: "not found" } }, 404);
    } });
    renderWithQueries(<RunDetailPage client={client} executionId="terminal-input" registry={new ResultRendererRegistry()} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Input" }));
    expect(await screen.findByText("This input request is expired. It can no longer be submitted.")).toBeTruthy();
    expect(screen.getByText("This input request is cancelled. It can no longer be submitted.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit input" })).toBeNull();
  });

  it("uploads a declared scalar input file before submitting the same request", async () => {
    const submitted: unknown[] = [];
    const fileRef = { objectId: "object-1", mediaType: "text/plain", byteLength: 5, sha256: "e".repeat(64) };
    const client = new RunApiClient({ baseUrl: "http://run-api.test", fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/runs/file-wait") return json({ run: {
        runRef: { executionId: "file-wait" }, workflow: { kind: "fixture.workflow", version: 1 },
        actor: { userId: "owner", roleId: "runner" }, createdAt: timestamp,
        status: { kind: "status", status: "waiting_for_input", requestId: "request-files", updatedAt: timestamp,
          expiresAt: "2026-08-06T12:00:00.000Z", activeComputeMs: 100 },
      } });
      if (url.pathname.endsWith("/uploads")) return json({ schemaVersion: 1, runRef: { executionId: "file-wait" },
        requestId: "request-files", fieldId: "documents", uploadId: "upload-fixture", file: fileRef }, 201);
      if (url.pathname.endsWith("/response")) {
        submitted.push(JSON.parse(String(init?.body)));
        return json({ schemaVersion: 1, runRef: { executionId: "file-wait" }, receipt: { schemaVersion: 1,
          submissionId: "answer-1", requestId: "request-files", acceptedAt: timestamp,
          acceptedBodySha256: "f".repeat(64), resumeCommandId: "resume-1", responderId: "owner" } }, 202);
      }
      if (url.pathname.endsWith("/input-requests")) return json({ schemaVersion: 1, runRef: { executionId: "file-wait" }, items: [{
        definition: { schemaVersion: 1, requestId: "request-files", stepId: "collect", title: "Add documents",
          form: { schemaVersion: 1, id: "documents-form", version: "v1", fields: [{ id: "documents", label: "Documents",
            type: "files", required: true, maxFiles: 2, maxBytesPerFile: 100, mediaTypes: ["text/plain"] }] },
          formSha256: "a".repeat(64), executableBindingId: "binding-1", createdAt: timestamp, expiresAt: "2026-08-06T12:00:00.000Z" },
        status: "pending", revision: 1, updatedAt: timestamp,
      }] });
      return json({ error: { code: "not-found", message: "not found" } }, 404);
    } });
    renderWithQueries(<RunDetailPage client={client} executionId="file-wait" registry={new ResultRendererRegistry()} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Input" }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Expected the Documents file input.");
    await userEvent.upload(fileInput, new File(["hello"], "note.txt", { type: "text/plain" }));
    expect(await screen.findByText("1 file(s) uploaded.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Submit input" }));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ expectedRevision: 1, response: { files: { documents: [fileRef] } } });
  });

  it("pages through server cursors without treating one page as the full catalog", async () => {
    const requested: string[] = [];
    const client = new RunApiClient({
      baseUrl: "http://run-api.test",
      fetch: async (input) => {
        const url = new URL(String(input));
        requested.push(url.search);
        return url.searchParams.get("cursor") === "1"
          ? json({ items: [run("run-pi", "failed")], pagination: {} })
          : json({ items: [run("run-codex", "complete")], pagination: { nextCursor: "1" } });
      },
    });
    renderWithQueries(<RunFeature client={client} resultRenderers={new ResultRendererRegistry()} />);
    expect(await screen.findByText("run-codex")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("run-pi")).toBeTruthy();
    expect(requested.some((query) => new URLSearchParams(query).get("cursor") === "1")).toBe(true);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Rows per page" }), "50");
    expect(await screen.findByText("run-codex")).toBeTruthy();
    const resized = new URLSearchParams(requested.at(-1));
    expect(resized.get("pageSize")).toBe("50");
    expect(resized.has("cursor")).toBe(false);
    expect(screen.getByRole("button", { name: "Previous page" })).toHaveProperty("disabled", true);
  });

  it("requests selected aggregate columns and persists them per session", async () => {
    const requested: string[][] = [];
    renderWithQueries(
      <RunFeature
        client={clientForApi(requested)}
        resultRenderers={new ResultRendererRegistry()}
        columnPreferenceKey="session-a"
      />,
    );
    await screen.findByText("run-codex");
    await userEvent.click(screen.getByText("Choose table columns"));
    const inputTokens = screen.getByRole("checkbox", { name: "Input tokens" });
    expect((inputTokens as HTMLInputElement).checked).toBe(false);
    await userEvent.click(inputTokens);
    expect(await screen.findByRole("columnheader", { name: /Input tokens/ })).toBeTruthy();
    expect(requested.some((fields) => fields.includes("inputTokens"))).toBe(true);

    cleanup();
    renderWithQueries(
      <RunFeature
        client={clientForApi()}
        resultRenderers={new ResultRendererRegistry()}
        columnPreferenceKey="session-a"
      />,
    );
    await userEvent.click(await screen.findByText("Choose table columns"));
    expect((screen.getByRole("checkbox", { name: "Input tokens" }) as HTMLInputElement).checked).toBe(true);
  });

  it("uses provider, model, and total time as local-development defaults", async () => {
    const requested: string[][] = [];
    renderWithQueries(<RunFeature
      client={clientForApi(requested)}
      resultRenderers={new ResultRendererRegistry()}
      defaultColumns={workflowDevelopmentRunColumns}
      columnPreferenceKey="workflow-development"
    />);
    expect(await screen.findByRole("columnheader", { name: /Provider/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Model/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Total time/ })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /User/ })).toBeNull();
    expect(requested.some((fields) => ["provider", "model", "totalElapsedMs"].every((field) => fields.includes(field))))
      .toBe(true);
  });

  it("embeds the run catalog with an immutable backend workflow filter", async () => {
    const runQueries: URL[] = [];
    const client = new RunApiClient({
      baseUrl: "http://run-api.test",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/runs") { runQueries.push(url); return json({ items: [], pagination: {} }); }
        if (url.pathname === "/api/v1/runs/filter-options") return json({ providers: [], models: [], numericFields: [] });
        if (url.pathname === "/api/v1/workflows") return json({ items: [] });
        return json({ error: { code: "not-found", message: "not found" } }, 404);
      },
    });
    renderWithQueries(<RunFeature
      client={client}
      resultRenderers={new ResultRendererRegistry()}
      fixedWorkflow={{ kind: "fixture.workflow", version: 3 }}
      embedded
    />);

    expect(await screen.findByRole("table", { name: "Runs" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Workflow" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Catalog" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Show archived" })).toBeTruthy();
    expect(runQueries.some((url) => url.searchParams.get("workflowKind") === "fixture.workflow" && url.searchParams.get("workflowVersion") === "3")).toBe(true);
  });

  it("applies archived visibility through the backend and archives selected terminal runs", async () => {
    const requested: URL[] = [];
    const archived: string[] = [];
    const client = new RunApiClient({
      baseUrl: "http://run-api.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/runs") { requested.push(url); return json({ items: runs(), pagination: {} }); }
        if (url.pathname === "/api/v1/runs/filter-options") return json({ providers: [], models: [], numericFields: [] });
        if (url.pathname === "/api/v1/workflows") return json({ items: [] });
        const archiveMatch = /^\/api\/v1\/runs\/([^/]+)\/archive$/.exec(url.pathname);
        if (archiveMatch && init?.method === "POST") {
          archived.push(archiveMatch[1]!);
          return json({ run: { ...run(archiveMatch[1]!, archiveMatch[1] === "run-pi" ? "failed" : "complete"), lifecycleStatus: "archived", archivedAt: timestamp } });
        }
        return json({ error: { code: "not-found", message: "not found" } }, 404);
      },
    });
    renderWithQueries(<RunFeature client={client} resultRenderers={new ResultRendererRegistry()} />);
    await screen.findByText("run-codex");
    await userEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await vi.waitFor(() => expect(requested.some((url) => url.searchParams.get("lifecycleStatus") === "all")).toBe(true));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all runs" }));
    await userEvent.click(screen.getByRole("button", { name: "Archive selected (2)" }));
    await vi.waitFor(() => expect(archived.sort()).toEqual(["run-codex", "run-pi"]));
  });

  it("keeps the workflow renderer optional while exposing original JSON and run input", async () => {
    const renderer: ResultReactPlugin = {
      resultKind: "fixture.result",
      payloadSchemaVersion: 1,
      validatePayload: (payload) => payload as never,
      Component: ({ result }) => <p>Rendered output: {String((result.payload as { message: string }).message)}</p>,
    };
    renderWithQueries(<RunResultsView
      client={clientForApi()}
      executionId="run-codex"
      registry={new ResultRendererRegistry([renderer])}
    />);
    expect(await screen.findByText("Rendered output: workflow-owned data")).toBeTruthy();
    expect(await screen.findByText(/fixture input/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "View original JSON" }));
    expect(screen.getByText(/result.json/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "View rendered" })).toBeTruthy();
  });

  it("renders platform-owned overview, artifacts, performance, and configuration views", async () => {
    const client = clientForApi();
    const requests: string[] = [];
    const get = client.getRun.bind(client);
    vi.spyOn(client, "getRun").mockImplementation(async (id) => { requests.push(id); return get(id); });
    renderWithQueries(<RunDetailPage
      client={client}
      executionId="run-codex"
      registry={new ResultRendererRegistry()}
    />);
    expect(await screen.findByText("fixture.workflow@1 · owner")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View JSON" })).toBeTruthy();
    expect(requests).toEqual(["run-codex"]);
    for (const [label, value] of [["User", "owner"], ["Role", "runner"], ["Last update", new Date(timestamp).toLocaleString()], ["Current stage", "fixture-stage"], ["Provider", "codex-cli"]]) {
      expect(screen.getByText(label, { exact: true }).parentElement?.textContent).toContain(value);
    }
    await userEvent.click(screen.getByRole("tab", { name: "Results" }));
    expect(await screen.findByRole("heading", { name: "Generic JSON result" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download JSON" }).getAttribute("download")).toBe("result.json");

    await userEvent.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(await screen.findByRole("table", { name: "Run artifacts" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/fixture artifact/)).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: "Performance" }));
    expect(await screen.findByText("Stages")).toBeTruthy();
    expect(screen.getByText("Agent attempts")).toBeTruthy();
    const attempts = screen.getByRole("table", { name: "Agent attempt performance" });
    expect(within(attempts).getByRole("columnheader", { name: "Attempt" })).toBeTruthy();
    expect(within(attempts).getByRole("columnheader", { name: "Cached input" })).toBeTruthy();
    expect(within(attempts).getByText("321")).toBeTruthy();
    expect(within(attempts).getByText("123")).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByText("fixture-v1")).toBeTruthy();
  });

  it("uses the generic JSON fallback when no workflow renderer is installed", async () => {
    renderWithQueries(
      <RunResultsView client={clientForApi()} executionId="run-codex" registry={new ResultRendererRegistry()} />,
    );
    expect(await screen.findByRole("heading", { name: "Generic JSON result" })).toBeTruthy();
    expect(screen.getByText("No compatible result renderer is installed.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: "Download JSON" }).getAttribute("download")).toBe("result.json");
  });

  it("keeps renderer failure visible above JSON and removes it when the renderer returns", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = clientForApi();
    const view = (registry: ResultRendererRegistry) => <QueryClientProvider client={queryClient}><RunResultsView client={client} executionId="run-codex" registry={registry} /></QueryClientProvider>;
    const page = render(view(new ResultRendererRegistry([], { unavailableReason: "Renderer failed safely. Showing original JSON." })));
    const alert = await screen.findByRole("alert", { name: "Result renderer failed" });
    expect(alert.textContent).toContain("Renderer failed safely. Showing original JSON.");
    expect(alert.className).toContain("border-red-500");
    expect(screen.getByRole("link", { name: "Download JSON" })).toBeTruthy();
    page.rerender(view(new ResultRendererRegistry([], { unavailableReason: "Could not load the renderer.", unavailableTone: "warning" })));
    const warning = screen.getByRole("alert", { name: "Could not load renderer" });
    expect(warning.textContent).toContain("Could not load the renderer.");
    expect(warning.className).toContain("border-amber-500");
    page.rerender(view(new ResultRendererRegistry([{ resultKind: "fixture.result", payloadSchemaVersion: 1,
      validatePayload: () => ({ schemaVersion: 1 }), Component: () => <p>Repaired presentation</p> }])));
    expect(await screen.findByText("Repaired presentation")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the selected failed Run's failure and identity without substituting another Run", async () => {
    renderWithQueries(<RunDetailPage client={clientForApi()} executionId="run-pi" registry={new ResultRendererRegistry()} />);
    expect(await screen.findByText("failed fixture")).toBeTruthy();
    expect(screen.getByText("run-pi")).toBeTruthy();
    expect(screen.queryByText("run-codex")).toBeNull();
    expect(screen.getByText("Provider", { exact: true }).parentElement?.textContent).toContain("pi-cli");
  });

  it("falls back to JSON when a matching renderer rejects the payload", async () => {
    const invalid: ResultReactPlugin = {
      resultKind: "fixture.result",
      payloadSchemaVersion: 1,
      validatePayload: () => { throw new Error("fixture payload is invalid"); },
      Component: () => <p>must not render</p>,
    };
    renderWithQueries(
      <RunResultsView
        client={clientForApi()}
        executionId="run-codex"
        registry={new ResultRendererRegistry([invalid])}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Generic JSON result" })).toBeTruthy();
    expect(screen.getByText("Result validation failed: fixture payload is invalid")).toBeTruthy();
    expect(screen.queryByText("must not render")).toBeNull();
  });

  it("isolates a failed renderer from the surrounding run page", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: ResultReactPlugin = {
      resultKind: "fixture.result",
      payloadSchemaVersion: 1,
      validatePayload: (payload) => payload as never,
      Component: () => { throw new Error("fixture renderer crashed"); },
    };
    renderWithQueries(
      <section>
        <h2>Run shell remains available</h2>
        <RunResultsView
          client={clientForApi()}
          executionId="run-codex"
          registry={new ResultRendererRegistry([broken])}
        />
      </section>,
    );
    expect(await screen.findByText("Renderer failed: fixture renderer crashed")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Run shell remains available" })).toBeTruthy();
    consoleError.mockRestore();
  });
});

function renderWithQueries(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

function correctionRun(executionId: string, status: "running" | "cancelled") {
  return {
    runRef: { executionId }, workflow: { kind: "fixture.workflow", version: 1 },
    actor: { userId: "owner", roleId: "runner" }, createdAt: timestamp,
    runConfiguration: { configurationId: "fixture-v1", contentHash: hash },
    status: { kind: "status", status, updatedAt: timestamp },
  };
}

function clientForApi(requestedSummaryFields?: string[][]): RunApiClient {
  return new RunApiClient({
    baseUrl: "http://run-api.test",
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/runs") {
        const fields = url.searchParams.getAll("summaryField");
        requestedSummaryFields?.push(fields);
        return json({
          items: runs().map((item) => fields.length === 0 ? item : {
            ...item,
            summary: Object.fromEntries(fields.map((field) => [field, summaryValue(field)])),
          }),
          pagination: {},
        });
      }
      if (url.pathname === "/api/v1/run-comparisons") return json({ rows: comparisonRows() });
      const selectedRun = runs().find(run => url.pathname === `/api/v1/runs/${run.runRef.executionId}`);
      if (selectedRun) return json({ run: selectedRun });
      if (url.pathname === "/api/v1/runs/run-codex/results") return json({
        runRef: { executionId: "run-codex" },
        items: [{
          runRef: { executionId: "run-codex" },
          resultKind: "fixture.result",
          resultId: "result.json",
          payloadSchemaVersion: 1,
        }],
      });
      if (url.pathname === "/api/v1/runs/run-codex/results/result.json") return json({
        resultId: "result.json",
        envelopeSchemaVersion: 1,
        resultKind: "fixture.result",
        runRef: { executionId: "run-codex" },
        payload: { schemaVersion: 1, message: "workflow-owned data" },
      });
      if (url.pathname === "/api/v1/runs/run-codex/input") return json({
        runRef: { executionId: "run-codex" },
        input: { request: "fixture input" },
      });
      if (url.pathname === "/api/v1/runs/run-codex/artifacts") return json({
        runRef: { executionId: "run-codex" },
        items: [{ key: "artifacts/fixture.json", mediaType: "application/json", sizeBytes: 27, sha256: hash }],
      });
      if (url.pathname === "/api/v1/runs/run-codex/artifact-content") return json({
        runRef: { executionId: "run-codex" },
        artifact: { key: "artifacts/fixture.json", mediaType: "application/json", sizeBytes: 27, sha256: hash },
        encoding: "utf8",
        content: JSON.stringify({ message: "fixture artifact" }),
      });
      if (url.pathname === "/api/v1/runs/run-codex/performance") return json({
        runRef: { executionId: "run-codex" },
        performance: {
          schemaVersion: 1,
          runRef: { executionId: "run-codex" },
          workflow: { kind: "fixture.workflow", version: 1 },
          startedAt: timestamp,
          completedAt: "2026-08-05T12:00:01.000Z",
          totalElapsedMs: 1_000,
          stages: [{ stageId: "generate", status: "complete", elapsedMs: 1_000 }],
          agentAttempts: [{
            stageId: "generate",
            logicalAgentId: "writer",
            metrics: {
              providerId: "codex-cli",
              model: "gpt-5.6-luna",
              status: "complete",
              elapsedMs: 900,
              attempt: 2,
              usage: { inputTokens: 321, cachedInputTokens: 123, outputTokens: 45 },
              artifacts: {
                eventsPath: "events.jsonl",
                stderrPath: "stderr.log",
                lastMessagePath: "last-message.txt",
                heartbeatPath: "heartbeat.json",
              },
              nativeToolCalls: 2,
              toolCallUnit: "shell-command",
              repositorySearchCalls: 1,
            },
          }],
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      });
      if (url.pathname === "/api/v1/runs/run-codex/resolved-configuration") return json({
        runRef: { executionId: "run-codex" },
        resolvedConfiguration: {
          configurationId: "fixture-v1",
          workflow: { kind: "fixture.workflow", version: 1 },
          agents: { writer: { execution: { provider: "codex-cli" } } },
        },
      });
      return json({ error: { code: "not-found", message: `No fixture for ${url.pathname}.` } }, 404);
    },
  });
}

function runs() {
  return [
    run("run-codex", "complete"),
    run("run-pi", "failed"),
  ];
}

function run(executionId: string, status: "complete" | "failed" | "running") {
  return {
    runRef: { executionId },
    workflow: { kind: "fixture.workflow", version: 1 },
    actor: { userId: "owner", roleId: "runner" },
    createdAt: timestamp,
    runConfiguration: { configurationId: "fixture-v1", contentHash: hash },
    status: status === "failed"
      ? { kind: "status", status, updatedAt: timestamp, message: "failed fixture" }
      : { kind: "status", status, updatedAt: timestamp },
    heartbeat: { kind: "heartbeat", status, lastEventType: `run.${status}`, updatedAt: timestamp, stageId: "fixture-stage", providerId: executionId === "run-codex" ? "codex-cli" : "pi-cli" },
  };
}

function comparisonRows() {
  return [
    comparisonRow("run-codex", "codex-cli", "gpt-5.6-luna", 1_000),
    comparisonRow("run-pi", "pi-cli", "gpt-5.3-codex-spark", 600),
  ];
}

function comparisonRow(executionId: string, provider: string, model: string, durationMs: number) {
  return {
    runRef: { executionId },
    status: executionId === "run-codex" ? "complete" : "failed",
    userId: "owner",
    roleId: "runner",
    workflow: { kind: "fixture.workflow", version: 1 },
    target: null,
    runConfiguration: { configurationId: "fixture-v1", contentHash: hash },
    provider,
    model,
    reasoningEffort: "high",
    speed: null,
    durationMs,
    inputTokens: 100,
    cachedInputTokens: 50,
    outputTokens: 10,
    reasoningOutputTokens: null,
    costs: null,
    toolCalls: 3,
    searchCalls: 2,
  };
}

function summaryValue(field: string): unknown {
  if (field === "inputTokens") return 100;
  if (field === "provider") return "pi-cli";
  return null;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
