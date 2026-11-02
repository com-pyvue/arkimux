import { describe, expect, it } from "vitest";
import {
  createDefaultCodeCapabilityAdapterRegistry,
} from "../../../agent-input/code/src/index.ts";

describe("code capability adapter registry", () => {
  it("resolves, validates, creates, and preflights installed adapters", async () => {
    const registry = createDefaultCodeCapabilityAdapterRegistry();
    const snapshotFactory = registry.resolve("code-snapshot", "git-code-snapshot@1");
    const repositoryToolsFactory = registry.resolve(
      "repository-tools",
      "guarded-repository-tools@1",
    );

    expect(snapshotFactory.validateConfig({})).toEqual({});
    expect(repositoryToolsFactory.validateConfig({})).toEqual({});

    const snapshot = await snapshotFactory.create({ options: {} });
    const repositoryTools = await repositoryToolsFactory.create({ options: {} });
    await expect(snapshotFactory.preflight(snapshot)).resolves.toMatchObject({
      adapterId: "git-code-snapshot@1",
      role: "code-snapshot",
      available: true,
    });
    await expect(repositoryToolsFactory.preflight(repositoryTools)).resolves.toMatchObject({
      adapterId: "guarded-repository-tools@1",
      role: "repository-tools",
      available: true,
    });
  });

  it("rejects unknown adapter and role combinations", () => {
    const registry = createDefaultCodeCapabilityAdapterRegistry();

    expect(() => registry.resolve("repository-tools", "git-code-snapshot@1")).toThrow(
      "Unknown code capability adapter: repository-tools/git-code-snapshot@1.",
    );
    expect(() => registry.resolve("code-snapshot", "missing@1")).toThrow(
      "Unknown code capability adapter: code-snapshot/missing@1.",
    );
  });

  it("rejects unsupported adapter options", () => {
    const registry = createDefaultCodeCapabilityAdapterRegistry();
    const factory = registry.resolve("code-snapshot", "git-code-snapshot@1");

    expect(() => factory.validateConfig({ command: "custom-git" })).toThrow(
      "does not support options [command]",
    );
  });
});
