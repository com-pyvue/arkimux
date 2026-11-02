/** Local V2 setup candidates. Version pins are not a full provider-conformance claim. */
export const nativeConnectionPresets = [
  { presetId: "codex-native", label: "Codex Native Session", executionProviderId: "codex-cli", modelProvider: "openai", requiredVersion: "0.145.0", loginInstruction: "Requires login to Codex CLI. Run codex login. Account and model access are checked by Test connection." },
  { presetId: "claude-native", label: "Claude Native Session", executionProviderId: "claude-code-cli", modelProvider: "anthropic", requiredVersion: "2.1.241", loginInstruction: "Requires login to Claude Code. Run /login inside Claude Code. Account and model access are checked by Test connection." },
  { presetId: "pi-codex", label: "Pi Codex Session", executionProviderId: "pi-cli", modelProvider: "openai-codex", requiredVersion: "0.84.3", loginInstruction: "Requires a Codex session inside Pi CLI. Run pi, then /login and choose OpenAI Codex. Logging into Codex CLI alone does not log into Pi." },
  { presetId: "pi-claude", label: "Pi Claude Session", executionProviderId: "pi-cli", modelProvider: "anthropic", requiredVersion: "0.84.3", loginInstruction: "Requires an Anthropic session inside Pi CLI. Run pi, then /login and choose Anthropic. Logging into Claude Code alone does not log into Pi." },
] as const;
