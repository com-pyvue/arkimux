/** Local V2 minimal-setup admission, not full provider conformance or release approval.
 * Source: docs/journeys/local-journey@2/evidence/pi-anthropic-key-setup-confirmed.json.
 */
export const localApiKeyConnectionPresets = [
  { presetId: "pi-anthropic-api-key", label: "Pi CLI with Anthropic API key", executionProviderId: "pi-cli", modelProvider: "anthropic", targetVariable: "ANTHROPIC_API_KEY", requiredVersion: "0.84.3" },
] as const;

export const localApiKeySetupEvidence = [
  { presetId: "pi-anthropic-api-key", requiredVersion: "0.84.3", checkedAt: "2026-09-06T04:11:37.781Z" },
] as const;

export function admittedLocalApiKeyPresets(config: { executionProviders: Record<string, { requiredVersion?: string }> } | undefined) {
  return localApiKeyConnectionPresets.filter(preset =>
    config?.executionProviders[preset.executionProviderId]?.requiredVersion === preset.requiredVersion
    && localApiKeySetupEvidence.some(record => record.presetId === preset.presetId && record.requiredVersion === preset.requiredVersion));
}
