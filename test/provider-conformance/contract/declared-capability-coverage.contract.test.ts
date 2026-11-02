import { describe, expect, it } from "vitest";
import {
  providerCapabilities,
  providerEvidence,
  providerIds,
  type ProviderCapabilityCell,
  type ProviderEvidenceDefinition,
  type ProviderId,
} from "../provider-capabilities.ts";

const evidenceById: ReadonlyMap<string, ProviderEvidenceDefinition> = new Map(
  providerEvidence.map((evidence) => [evidence.evidenceId, evidence]),
);

for (const capability of providerCapabilities) {
  describe(`declared capability: ${capability.capabilityId}`, () => {
    for (const providerId of providerIds) {
      const cell: ProviderCapabilityCell = capability.providers[providerId];
      const title = `${providerId} [${cell.status}]`;
      const reason = [cell.note, ...cell.trackingIds].join(" ");

      if (mustRun(cell)) {
        it(title, () => {
          expect(cell.evidenceIds.length).toBeGreaterThan(0);
          for (const evidenceId of cell.evidenceIds) {
            const evidence = evidenceById.get(evidenceId);
            expect(evidence, `${title} references missing evidence ${evidenceId}`).toBeDefined();
            expect(
              evidence?.providerIds.includes(providerId as ProviderId),
              `${evidenceId} does not cover ${providerId}`,
            ).toBe(true);
          }
        });
      } else {
        it.skip(`${title} — ${reason}`, () => undefined);
      }
    }
  });
}

function mustRun(cell: ProviderCapabilityCell): boolean {
  return cell.status === "supported"
    || cell.status === "partial"
    || (cell.status === "experimental" && cell.evidenceIds.length > 0);
}
