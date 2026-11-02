import type { DecisionBriefInput } from "./contract.js";

export function decisionBriefPrompt(input: DecisionBriefInput): string {
  return [
    "Create a concise, evidence-aware decision brief from the supplied input.",
    "Do not inspect or modify the repository. Use only the input below.",
    "Return exactly one JSON object and no prose or Markdown fences.",
    "The JSON must have this exact shape:",
    JSON.stringify({
      schemaVersion: 1,
      decision: "string",
      recommendation: { choice: "string", rationale: "string" },
      alternatives: [{ name: "string", explanation: "string" }],
      tradeoffs: [{ name: "string", explanation: "string" }],
      risks: [{ risk: "string", mitigation: "string" }],
      evidenceOrAssumptions: [{ statement: "string", kind: "evidence or assumption" }],
      nextSteps: ["string"],
    }, null, 2),
    "Decision input:",
    JSON.stringify(input, null, 2),
  ].join("\n\n");
}
