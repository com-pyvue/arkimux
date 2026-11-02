// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ResultRendererErrorBoundary,
  ResultRendererRegistry,
  payloadSchemaVersion,
  resultRendererKey,
  type ResultReactPlugin,
} from "../../apps/packages/result-presentation/src/index.ts";
import {
  Button,
  Card,
  CardContent,
  CardTitle,
  cn,
} from "../../apps/packages/ui/src/index.ts";

const topologyPlugin: ResultReactPlugin = {
  resultKind: "system-model.stack-topology",
  payloadSchemaVersion: 2,
  Component: () => <div>Topology</div>,
  validatePayload: (payload) => payload as never,
};

describe("result renderer registry", () => {
  it("selects a renderer by result kind and payload schema version", () => {
    const registry = new ResultRendererRegistry([topologyPlugin]);
    expect(registry.resolve("system-model.stack-topology", 2)).toBe(topologyPlugin);
    expect(registry.resolve("system-model.stack-topology", 1)).toBeUndefined();
  });

  it("rejects duplicate registrations and invalid identities", () => {
    expect(() => new ResultRendererRegistry([topologyPlugin, topologyPlugin])).toThrow(/Duplicate/);
    expect(() => resultRendererKey("Stack Topology", 1)).toThrow(/Invalid result kind/);
    expect(() => resultRendererKey("stack-topology", 0)).toThrow(/Invalid payload schema version/);
  });

  it("reads only a positive integer top-level schema version", () => {
    expect(payloadSchemaVersion({ schemaVersion: 3, payload: {} })).toBe(3);
    expect(payloadSchemaVersion({ schemaVersion: "3" })).toBeUndefined();
    expect(payloadSchemaVersion({ schemaVersion: 0 })).toBeUndefined();
    expect(payloadSchemaVersion(null)).toBeUndefined();
  });

  it("isolates a failing workflow renderer", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function BrokenRenderer(): never {
      throw new Error("renderer failed");
    }
    render(
      <ResultRendererErrorBoundary fallback={(error) => <p>Unavailable: {error.message}</p>}>
        <BrokenRenderer />
      </ResultRendererErrorBoundary>,
    );
    expect(screen.getByText("Unavailable: renderer failed")).toBeTruthy();
    consoleError.mockRestore();
  });
});

describe("shared UI primitives", () => {
  it("merges utility classes and renders source-owned primitives", () => {
    expect(cn("px-2", false && "hidden", "px-4")).toBe("px-4");
    render(
      <Card>
        <CardTitle>Run result</CardTitle>
        <CardContent>
          <Button variant="outline">Open</Button>
        </CardContent>
      </Card>,
    );
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });
});
