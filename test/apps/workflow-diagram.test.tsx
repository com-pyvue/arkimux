// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowDiagram } from "../../apps/packages/run/react/src/workflowDiagram.tsx";
import { defineGraphInvocationWorkflow } from "../../cli/scaffold/workflows/graph-invocation/src/workflow.ts";
import { describeGraphV1, describeGraphEntryV1, describeGraphEntryPresentationV1 } from "@com-pyvue/agent-execution-core";
import { graphDescriptionSchema } from "../../apps/packages/run/contract/src/graphDescription.ts";
import { workflowInvocationEntrySchema } from "../../apps/packages/run/contract/src/inputRequests.ts";

afterEach(cleanup);

it("labels data destinations, whole inputs and ordering arrows with full accessible paths", async () => {
  const graph = graphDescriptionSchema.parse(describeGraphV1(defineGraphInvocationWorkflow()));
  const [source, target] = graph.nodes.filter(node => node.scopeId === graph.rootScopeId);
  graph.nodes = [source, target];
  graph.edges = [
    { id: "named", scopeId: graph.rootScopeId, source: source.id, target: target.id, kind: "data", sourcePort: "output", sourcePath: ["forecast", 0], targetPath: ["weather"] },
    { id: "nested", scopeId: graph.rootScopeId, source: source.id, target: target.id, kind: "data", sourcePort: "input", sourcePath: ["a.b"], targetPath: ["items", 0, "city"] },
    { id: "whole", scopeId: graph.rootScopeId, source: source.id, target: target.id, kind: "data", sourcePort: "output", sourcePath: [], targetPath: [] },
    { id: "order", scopeId: graph.rootScopeId, source: source.id, target: target.id, kind: "order", sourcePort: "output", sourcePath: [], targetPath: [] },
    { id: "long", scopeId: graph.rootScopeId, source: source.id, target: target.id, kind: "data", sourcePort: "output", sourcePath: [], targetPath: ["anExceptionallyLongDestinationPropertyNameForTheWorkflow"] },
  ];
  render(<WorkflowDiagram graph={graph} />);
  const named = await screen.findByRole("img", { name: /output.forecast\[0\] → .* input.weather$/ });
  expect(named.querySelector("text")?.textContent).toBe("weather");
  expect(named.querySelector("rect")?.getAttribute("fill")).toBe("var(--background)");
  expect(named.querySelector("text")?.getAttribute("fill")).toBe("var(--foreground)");
  expect(named.classList.contains("workflow-graph-edge")).toBe(true);
  const nested = screen.getByRole("img", { name: /input\["a.b"\] → .* input.items\[0\].city$/ });
  expect(nested.querySelector("text")?.textContent).toBe("items[0].city");
  expect(screen.getByText("Whole input").tagName).toBe("text");
  const order = screen.getByRole("img", { name: /runs after .* No data is supplied/ });
  expect(order.querySelector("text")?.textContent).toBe("After");
  expect(order.querySelector("path")?.getAttribute("stroke-dasharray")).toBe("5 4");
  expect(named.querySelector("path")?.hasAttribute("stroke-dasharray")).toBe(false);
  const long = screen.getByRole("img", { name: /input.anExceptionallyLongDestinationPropertyNameForTheWorkflow$/ });
  expect(long.querySelector("text")?.textContent).toHaveLength(40);
  expect(long.querySelector("title")?.textContent).toContain("anExceptionallyLongDestinationPropertyNameForTheWorkflow");
  for (const edge of [named, nested, order, long]) {
    const label = edge.querySelector("text")!.parentElement!;
    expect(label.getAttribute("transform")).toMatch(/^translate\([\d.]+ [\d.]+\)$/);
    expect(Number(label.querySelector("rect")!.getAttribute("width"))).toBeGreaterThan(0);
  }
}, 20_000);

it("shows scoped entry, skipped steps, nested bodies, and the source of every supplied value", async () => {
  const definition = defineGraphInvocationWorkflow();
  const graph = graphDescriptionSchema.parse(describeGraphV1(definition));
  const declaration = definition.invocationEntries!.find(entry => entry.id === "map-item-1")!;
  const entry = workflowInvocationEntrySchema.parse({ ...declaration, nodeKind: "step",
    requirements: describeGraphEntryV1(definition, declaration.entry).requirements,
    presentation: describeGraphEntryPresentationV1(definition, declaration.entry) });
  const onRequirement = vi.fn();
  const view = render(<WorkflowDiagram graph={graph} entry={entry} onRequirement={onRequirement} />);
  expect(await screen.findByRole("button", { name: "Step 1, step, Skipped" })).toBeTruthy();
  const skipped = screen.getByRole("button", { name: "Step 1, step, Skipped" });
  expect(skipped.getAttribute("data-state")).toBe("Skipped");
  expect(skipped.getAttribute("data-kind")).toBe("step");
  expect(skipped.querySelector(".workflow-graph-node-frame")).toBeTruthy();
  expect(skipped.querySelector(".workflow-graph-node-halo")).toBeTruthy();
  expect(skipped.querySelector("text")?.getAttribute("fill")).toBe("var(--card-foreground)");
  expect(skipped.querySelector("rect[opacity]")).toBeNull();
  expect(await screen.findByRole("button", { name: "Map item, step, Starting here" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reduce, reduce, Continuation" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Earlier map outputs", exact: true }));
  expect(onRequirement).toHaveBeenCalledWith("control/map@map=1/completed");
  view.rerender(<WorkflowDiagram graph={graph} entry={entry} onRequirement={onRequirement} focusedRequirementId="control/map@map=1/completed" />);
  expect(screen.getByRole("status").textContent).toContain("those items will not be rerun");
  expect(screen.getByRole("button", { name: "Map, map, Continuation" }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Loop, loop, Continuation" }));
  // Controlled focus is cleared by the parent when the callback fires.
  view.rerender(<WorkflowDiagram graph={graph} entry={entry} onRequirement={onRequirement} />);
  await userEvent.click(screen.getByRole("button", { name: "Expand Loop body" }));
  expect(await screen.findByRole("button", { name: "Loop item, step, Body definition" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Loop item, step, Body definition" }));
  const panel = screen.getByRole("region", { name: "Workflow diagram" });
  expect(within(panel).getByText("Input schema")).toBeTruthy();
  expect(within(panel).getByText("Output schema")).toBeTruthy();
}, 20_000);
