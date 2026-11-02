import { z } from "zod";

export const DECISION_BRIEF_RESULT_KIND = "decision-brief.result";

export const decisionBriefInputSchema = z.object({
  schemaVersion: z.literal(1),
  decision: z.string().min(1),
  constraints: z.array(z.string().min(1)).min(1),
  evidence: z.array(z.string().min(1)).min(1),
}).strict();

const namedExplanationSchema = z.object({
  name: z.string().min(1),
  explanation: z.string().min(1),
}).strict();

export const decisionBriefResultSchema = z.object({
  schemaVersion: z.literal(1),
  decision: z.string().min(1),
  recommendation: z.object({
    choice: z.string().min(1),
    rationale: z.string().min(1),
  }).strict(),
  alternatives: z.array(namedExplanationSchema).min(1),
  tradeoffs: z.array(namedExplanationSchema).min(1),
  risks: z.array(z.object({
    risk: z.string().min(1),
    mitigation: z.string().min(1),
  }).strict()).min(1),
  evidenceOrAssumptions: z.array(z.object({
    statement: z.string().min(1),
    kind: z.enum(["evidence", "assumption"]),
  }).strict()).min(1),
  nextSteps: z.array(z.string().min(1)).min(1),
}).strict();

export type DecisionBriefInput = z.infer<typeof decisionBriefInputSchema>;
export type DecisionBriefResult = z.infer<typeof decisionBriefResultSchema>;

export function validateDecisionBriefInput(value: unknown): DecisionBriefInput {
  return decisionBriefInputSchema.parse(value);
}

export function validateDecisionBriefResult(value: unknown): DecisionBriefResult {
  return decisionBriefResultSchema.parse(value);
}
