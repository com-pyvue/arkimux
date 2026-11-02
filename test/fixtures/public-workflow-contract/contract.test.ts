import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { definePortableWorkflowManifest, defineNativeWorkflowManifest, validateWorkflowManifestV1,
  effectiveWorkflowRequirements, workflowManifestDigest, workflowDeclarationV1Schema } from "./contracts.ts";
import fixtures from "./fixtures.json";

describe("public-workflow-declarations@1 frozen contract", () => {
  it("validates separate immutable portable and native manifests", () => {
    const portable = definePortableWorkflowManifest(fixtures.weather);
    expect(Object.isFrozen(portable.executionRequirements.run)).toBe(true);
    expect(defineNativeWorkflowManifest(fixtures.native).workflowMode).toBe("native-runtime-bound");
    expect(() => defineNativeWorkflowManifest(fixtures.weather)).toThrow();
    expect(() => definePortableWorkflowManifest(fixtures.native)).toThrow();
    expect(validateWorkflowManifestV1(fixtures.vendor).workflowId).toBe("vendor-evaluation");
  });
  const invalid = [
    ["schema version", (m: any) => { m.schemaVersion = 2; }],
    ["mode", (m: any) => { m.workflowMode = "portable"; }],
    ["unknown field", (m: any) => { m.model = "x"; }],
    ["portable binding", (m: any) => { m.sourceBindings = fixtures.native.sourceBindings; }],
    ["unknown capability", (m: any) => { m.requiredCapabilities = ["unknown@1"]; }],
    ["duplicate capability", (m: any) => { m.requiredCapabilities = ["typed-results@1", "typed-results@1"]; }],
    ["operation deadline", (m: any) => { m.executionRequirements.run.maxDurationSeconds = 1; }],
    ["contradictory architecture", (m: any) => { m.executionRequirements.run.architectures = ["x64"]; m.executionRequirements.operations["read-weather"].architectures = ["arm64"]; }],
    ...["workspace", "shell", "childProcesses", "containerRuntime", "inboundService", "provider"].map(key =>
      [key, (m: any) => { m.executionRequirements.run[key] = true; }]),
    ...[0, -1, 1.5, Infinity, NaN].map(value => [String(value), (m: any) => { m.executionRequirements.run.resources = { minTemporaryDiskMiB: value }; }]),
    ...[["shell", "shell"], ["inbound-service"], ["incoming-network-listener"], ["shell", "child-processes"]].map(value =>
      [JSON.stringify(value), (m: any) => { m.executionRequirements.run.requiredFeatures = value; }]),
  ] as [string, (m: any) => void][];
  it.each(invalid)("rejects %s", (_, mutate) => {
    const manifest = structuredClone(fixtures.weather);
    mutate(manifest);
    expect(() => validateWorkflowManifestV1(manifest)).toThrow();
  });
  it("merges resources by max and features by union without allocating anything", () => {
    expect(effectiveWorkflowRequirements({ schemaVersion: 1,
      run: { maxDurationSeconds: 10, architectures: ["arm64", "x64"], resources: { minCpuMillis: 1000, minTemporaryDiskMiB: 10 } },
      operations: { a: { maxDurationSeconds: 9, resources: { minMemoryMiB: 512, minTemporaryDiskMiB: 100 }, requiredFeatures: ["shell"], architectures: ["arm64"] },
        b: { maxDurationSeconds: 9, requiredFeatures: ["child-processes"] } },
    })).toEqual({ maxDurationSeconds: 10, resources: { minCpuMillis: 1000, minMemoryMiB: 512, minTemporaryDiskMiB: 100 },
      requiredFeatures: ["child-processes", "shell"], architectures: ["arm64"] });
  });
  it("hashes independent of object-key insertion order", () => {
    const reverse = Object.fromEntries(Object.entries(fixtures.weather).reverse());
    expect(workflowManifestDigest(reverse)).toBe(workflowManifestDigest(fixtures.weather));
  });
  it("rejects path escapes, duplicate slots and secret metadata", () => {
    const declaration = { manifest: "workflows/weather-advisor/manifest.json", environment: "workflows/weather-advisor/environment.json",
      definition: { file: "workflows/weather-advisor/src/workflow.ts", export: "defineWeatherAdvisor" },
      inputValidator: { file: "workflows/weather-advisor/src/contract.ts", export: "weatherInputSchema" },
      resultValidator: { file: "workflows/weather-advisor/src/contract.ts", export: "weatherResultSchema" },
      result: { kind: "weather-advisor.result", schemaVersion: 1 }, effects: [], agentSlots: ["recommendation"] };
    expect(workflowDeclarationV1Schema.parse(declaration)).toEqual(declaration);
    for (const file of ["../secret", "/tmp/secret", ".env", "workflows/../secret", "workflows\\secret"]) {
      expect(() => workflowDeclarationV1Schema.parse({ ...declaration, manifest: file })).toThrow();
    }
    expect(() => workflowDeclarationV1Schema.parse({ ...declaration, agentSlots: ["recommendation", "recommendation"] })).toThrow();
    expect(() => workflowDeclarationV1Schema.parse({ ...declaration, apiKey: "not-a-real-key" })).toThrow();
  });
});
