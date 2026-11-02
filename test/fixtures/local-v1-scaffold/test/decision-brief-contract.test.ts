import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedResultDtoSchema } from "@com-pyvue/agent-execution-run-contract";
import {
  DECISION_BRIEF_RESULT_KIND,
  validateDecisionBriefInput,
  validateDecisionBriefResult,
} from "../workflows/decision-brief/src/contract.js";
import { decisionBriefPrompt } from "../workflows/decision-brief/src/prompt.js";
import { validateDecisionBriefRunConfiguration } from "../workflows/decision-brief/src/run-configuration.js";

test("accepts the complete Decision Brief input and builds a bounded prompt", () => {
  const input = validateDecisionBriefInput(validInput());
  const prompt = decisionBriefPrompt(input);
  assert.match(prompt, /Return exactly one JSON object/);
  assert.match(prompt, /Choose a runtime/);
});

test("rejects malformed input", () => {
  assert.throws(() => validateDecisionBriefInput({ ...validInput(), constraints: [] }));
  assert.throws(() => validateDecisionBriefInput({ ...validInput(), unknown: true }));
});

test("accepts a complete typed result and public envelope", () => {
  const payload = validateDecisionBriefResult(validResult());
  const envelope = publishedResultDtoSchema.parse({
    resultId: "decision-brief.result.json",
    envelopeSchemaVersion: 1,
    resultKind: DECISION_BRIEF_RESULT_KIND,
    runRef: { executionId: "decision-brief-contract-test" },
    payload,
  });
  assert.deepEqual(validateDecisionBriefResult(envelope.payload), payload);
});

test("rejects malformed results and envelopes", () => {
  assert.throws(() => validateDecisionBriefResult({ ...validResult(), alternatives: [] }));
  assert.throws(() => publishedResultDtoSchema.parse({
    resultId: "decision-brief.result.json",
    envelopeSchemaVersion: 2,
    resultKind: DECISION_BRIEF_RESULT_KIND,
    runRef: { executionId: "decision-brief-contract-test" },
    payload: validResult(),
  }));
});

test("accepts only the frozen Local V1 Codex Native configuration", () => {
  assert.equal(validateDecisionBriefRunConfiguration(validConfiguration()).configurationId, "decision-brief-codex-native-v1");
  assert.throws(() => validateDecisionBriefRunConfiguration({
    ...validConfiguration(),
    agents: { "decision-author": { ...validConfiguration().agents["decision-author"], execution: {
      provider: "pi-cli",
      authProvider: "pi-openai-codex-session",
      parameters: {},
    } } },
  }));
});

function validInput() {
  return {
    schemaVersion: 1 as const,
    decision: "Choose a runtime",
    constraints: ["Keep the result stable"],
    evidence: ["The public contract is versioned"],
  };
}

function validResult() {
  return {
    schemaVersion: 1 as const,
    decision: "Choose a runtime",
    recommendation: { choice: "Start locally", rationale: "It minimizes deployment risk." },
    alternatives: [{ name: "Managed", explanation: "Use it later." }],
    tradeoffs: [{ name: "Control", explanation: "Local operation requires a workstation." }],
    risks: [{ risk: "Runtime drift", mitigation: "Pin the runtime." }],
    evidenceOrAssumptions: [{ statement: "The contract is versioned.", kind: "evidence" as const }],
    nextSteps: ["Run the clean fixture."],
  };
}

function validConfiguration() {
  return {
    schemaVersion: 1 as const,
    configurationId: "decision-brief-codex-native-v1",
    workflow: { kind: "decision-brief", version: 1 },
    agents: {
      "decision-author": {
        timeoutMs: 600_000,
        execution: {
          provider: "codex-cli",
          authProvider: "codex-native-session",
          parameters: { model: "gpt-5.6-luna", model_reasoning_effort: "high" },
        },
      },
    },
  };
}
