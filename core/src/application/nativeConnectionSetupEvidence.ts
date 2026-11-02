/** Minimal setup admission only, not LJ2-011 provider conformance or release approval.
 * Sources: docs/journeys/local-journey@2/evidence/connections-native-setup.json
 * and docs/journeys/local-journey@2/evidence/claude-native-setup-confirmed.json.
 * Admit a tuple only after its exact CLI pin passes a live minimal inference.
 */
export const nativeConnectionSetupEvidence = [
  { presetId: "codex-native", requiredVersion: "0.145.0", checkedAt: "2026-09-05T09:30:56.753Z" },
  { presetId: "claude-native", requiredVersion: "2.1.241", checkedAt: "2026-09-05T15:05:23.107Z" },
  { presetId: "pi-codex", requiredVersion: "0.84.3", checkedAt: "2026-09-05T09:31:09.696Z" },
] as const;
