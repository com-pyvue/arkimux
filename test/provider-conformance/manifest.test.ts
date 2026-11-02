import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  providerCapabilities,
  providerEvidence,
  providerExecutionCombinations,
  providerGaps,
  providerIds,
  renderProviderCapabilityMatrix,
  renderProviderEvidenceTable,
  renderProviderExecutionCombinationMatrix,
  renderProviderGapTable,
  type CapabilityStatus,
  type ProviderExecutionCombination,
  type ProductStatus,
  type TestLevel,
} from "./provider-capabilities.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const capabilityStatuses = new Set<CapabilityStatus>([
  "supported",
  "partial",
  "unsupported",
  "experimental",
  "not-applicable",
]);
const productStatuses = new Set<ProductStatus>(["candidate", "experimental"]);
const testLevels = new Set<TestLevel>(["contract", "adapter", "live-provider", "managed-host"]);
const identifierPattern = /^[a-z][a-z0-9-]*$/;

describe("agent-provider capability manifest", () => {
  it("has stable unique provider, capability, combination, evidence, and gap identities", () => {
    expect(providerIds).toEqual(["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"]);
    expectUnique(providerIds, "provider IDs");
    expectUnique(providerCapabilities.map(({ capabilityId }) => capabilityId), "capability IDs");
    expectUnique(providerExecutionCombinations.map(({ combinationId }) => combinationId), "combination IDs");
    expectUnique(providerEvidence.map(({ evidenceId }) => evidenceId), "evidence IDs");
    expectUnique(providerGaps.map(({ trackingId }) => trackingId), "gap tracking IDs");

    for (const identifier of [
      ...providerIds,
      ...providerCapabilities.map(({ capabilityId }) => capabilityId),
      ...providerExecutionCombinations.map(({ combinationId }) => combinationId),
    ]) {
      expect(identifier, `Invalid stable identifier ${identifier}`).toMatch(identifierPattern);
    }
    for (const { evidenceId } of providerEvidence) {
      expect(evidenceId, `Invalid evidence identifier ${evidenceId}`).toMatch(/^APC-E\d{3}$/);
    }
    for (const { trackingId } of providerGaps) {
      expect(trackingId, `Invalid gap identifier ${trackingId}`).toMatch(/^APC-GAP-\d{3}$/);
    }
  });

  it("defines an explicit status and traceable evidence or gap for every provider capability", () => {
    const evidenceIds = new Set(providerEvidence.map(({ evidenceId }) => evidenceId));
    const trackingIds = new Set(providerGaps.map(({ trackingId }) => trackingId));

    for (const capability of providerCapabilities) {
      expect(capability.category.trim()).not.toBe("");
      expect(capability.title.trim()).not.toBe("");
      expect(capability.description.trim()).not.toBe("");
      expect(Object.keys(capability.providers).sort()).toEqual([...providerIds].sort());

      for (const providerId of providerIds) {
        const cell = capability.providers[providerId];
        const location = `${capability.capabilityId}.${providerId}`;
        expect(capabilityStatuses.has(cell.status), `${location} has invalid status ${cell.status}`).toBe(true);
        expect(cell.note.trim(), `${location} must explain its status`).not.toBe("");
        expectUnique(cell.evidenceIds, `${location} evidence references`);
        expectUnique(cell.trackingIds, `${location} tracking references`);
        expectReferences(cell.evidenceIds, evidenceIds, `${location} evidence`);
        expectReferences(cell.trackingIds, trackingIds, `${location} tracking`);

        if (cell.status === "supported") {
          expect(cell.evidenceIds.length, `${location} supported behavior needs evidence`).toBeGreaterThan(0);
        } else if (cell.status === "partial") {
          expect(cell.evidenceIds.length, `${location} partial behavior needs positive evidence`).toBeGreaterThan(0);
          expect(cell.trackingIds.length, `${location} partial behavior needs a tracked gap`).toBeGreaterThan(0);
        } else if (cell.status === "unsupported") {
          expect(cell.trackingIds.length, `${location} unsupported behavior needs a tracked gap`).toBeGreaterThan(0);
        } else if (cell.status === "experimental") {
          expect(
            cell.evidenceIds.length + cell.trackingIds.length,
            `${location} experimental behavior needs evidence or a tracked gap`,
          ).toBeGreaterThan(0);
        } else {
          expect(cell.evidenceIds, `${location} not-applicable behavior must not claim evidence`).toEqual([]);
          expect(cell.trackingIds, `${location} not-applicable behavior must not claim a gap`).toEqual([]);
        }
      }
    }
  });

  it("keeps execution combinations explicit, traceable, and inside the provider catalog", () => {
    const evidenceIds = new Set(providerEvidence.map(({ evidenceId }) => evidenceId));
    const trackingIds = new Set(providerGaps.map(({ trackingId }) => trackingId));

    for (const manifestCombination of providerExecutionCombinations) {
      const combination: ProviderExecutionCombination = manifestCombination;
      const location = combination.combinationId;
      expect(providerIds).toContain(combination.executionProviderId);
      expect(productStatuses.has(combination.productStatus), `${location} has invalid product status`).toBe(true);
      expect(capabilityStatuses.has(combination.supportStatus), `${location} has invalid support status`).toBe(true);
      expect(combination.modelProvider.trim()).not.toBe("");
      expect(combination.authenticationKind.trim()).not.toBe("");
      expect(combination.authenticationReferenceKind.trim()).not.toBe("");
      expect(combination.authenticationReference.trim()).not.toBe("");
      expect(combination.journey.trim()).not.toBe("");
      expect(combination.notes.trim()).not.toBe("");
      expectUnique(combination.evidenceIds, `${location} evidence references`);
      expectUnique(combination.trackingIds, `${location} tracking references`);
      expectReferences(combination.evidenceIds, evidenceIds, `${location} evidence`);
      expectReferences(combination.trackingIds, trackingIds, `${location} tracking`);

      if (combination.supportStatus === "supported") {
        expect(combination.evidenceIds.length, `${location} supported combination needs evidence`).toBeGreaterThan(0);
      } else if (combination.supportStatus === "partial") {
        expect(combination.evidenceIds.length, `${location} partial combination needs positive evidence`).toBeGreaterThan(0);
        expect(combination.trackingIds.length, `${location} partial combination needs a tracked gap`).toBeGreaterThan(0);
      } else if (combination.supportStatus === "unsupported") {
        expect(combination.trackingIds.length, `${location} unsupported combination needs a tracked gap`).toBeGreaterThan(0);
      } else if (combination.supportStatus === "experimental") {
        expect(combination.productStatus, `${location} experimental support cannot be a release candidate`).toBe("experimental");
        expect(combination.evidenceIds.length + combination.trackingIds.length).toBeGreaterThan(0);
      }
    }
  });

  it("points every evidence record and tracked gap at valid providers and repository files", async () => {
    for (const evidence of providerEvidence) {
      expect(testLevels.has(evidence.level), `${evidence.evidenceId} has invalid test level`).toBe(true);
      expect(evidence.providerIds.length, `${evidence.evidenceId} must name at least one provider`).toBeGreaterThan(0);
      expectUnique(evidence.providerIds, `${evidence.evidenceId} provider references`);
      for (const providerId of evidence.providerIds) expect(providerIds).toContain(providerId);
      expect(evidence.testName.trim()).not.toBe("");
      expect(evidence.notes.trim()).not.toBe("");
      const sourcePath = path.resolve(repositoryRoot, evidence.sourcePath);
      await expect(access(sourcePath)).resolves.toBeUndefined();
      await expect(readFile(sourcePath, "utf8")).resolves.toContain(evidence.testName);
    }

    for (const gap of providerGaps) {
      expect(gap.title.trim()).not.toBe("");
      expect(gap.status.trim()).not.toBe("");
      expect(gap.description.trim()).not.toBe("");
      expect(gap.affectedProviderIds.length, `${gap.trackingId} must name affected providers`).toBeGreaterThan(0);
      expectUnique(gap.affectedProviderIds, `${gap.trackingId} provider references`);
      for (const providerId of gap.affectedProviderIds) expect(providerIds).toContain(providerId);
    }
  });
});

describe("agent-provider capability document", () => {
  it("contains the exact generated capability, combination, evidence, and gap tables", async () => {
    const document = await readFile(
      path.join(repositoryRoot, "docs/agent-provider-compatibility.md"),
      "utf8",
    );
    const generatedSections = [
      ["PROVIDER_CAPABILITY_MATRIX", renderProviderCapabilityMatrix()],
      ["PROVIDER_EXECUTION_COMBINATION_MATRIX", renderProviderExecutionCombinationMatrix()],
      ["PROVIDER_EVIDENCE_TABLE", renderProviderEvidenceTable()],
      ["PROVIDER_GAP_TABLE", renderProviderGapTable()],
    ] as const;

    for (const [sectionId, rendered] of generatedSections) {
      expect(generatedSection(document, sectionId), `${sectionId} drifted from its manifest`).toBe(rendered);
    }
  });

  it("renders deterministically without generated-section control markers", () => {
    for (const rendered of [
      renderProviderCapabilityMatrix(),
      renderProviderExecutionCombinationMatrix(),
      renderProviderEvidenceTable(),
      renderProviderGapTable(),
    ]) {
      expect(rendered).not.toContain("<!-- BEGIN GENERATED:");
      expect(rendered).not.toContain("<!-- END GENERATED:");
      expect(rendered).toBe(`${rendered.trimEnd()}\n`);
    }
  });
});

function expectUnique(values: readonly string[], label: string): void {
  expect(new Set(values).size, `${label} must be unique`).toBe(values.length);
}

function expectReferences(values: readonly string[], known: ReadonlySet<string>, label: string): void {
  for (const value of values) expect(known.has(value), `${label} references unknown ID ${value}`).toBe(true);
}

function generatedSection(document: string, sectionId: string): string {
  const begin = `<!-- BEGIN GENERATED:${sectionId} -->`;
  const end = `<!-- END GENERATED:${sectionId} -->`;
  const beginIndex = document.indexOf(begin);
  const contentStart = beginIndex + begin.length + 1;
  const endIndex = document.indexOf(end, contentStart);
  expect(beginIndex, `Missing ${begin}`).toBeGreaterThanOrEqual(0);
  expect(document.slice(beginIndex + begin.length, contentStart), `${begin} must end with one newline`).toBe("\n");
  expect(endIndex, `Missing ${end}`).toBeGreaterThan(contentStart);
  expect(document.indexOf(begin, contentStart), `Duplicate ${begin}`).toBe(-1);
  expect(document.indexOf(end, endIndex + end.length), `Duplicate ${end}`).toBe(-1);
  return document.slice(contentStart, endIndex);
}
