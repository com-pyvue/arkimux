import { createHash } from "node:crypto";
import type { AgentRunPolicy } from "./agentProvider.ts";
import { validateAgentRunPolicy } from "./runConfiguration.ts";
import { assertRunConfigurationId } from "../domain/runConfigurationReference.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";

export type AgentTemplateOrigin = "platform" | "custom";

export interface AgentTemplateProviderSchemaRef {
  executionProvider: string;
  schemaVersion: number;
}

export interface AgentTemplateDefinition {
  schemaVersion: 1;
  templateId: string;
  title: string;
  description?: string;
  origin: AgentTemplateOrigin;
  providerSchema: AgentTemplateProviderSchemaRef;
  policy: AgentRunPolicy;
}

export interface ResolvedAgentTemplate<
  TTemplate extends AgentTemplateDefinition = AgentTemplateDefinition,
> {
  template: TTemplate;
  contentHash: string;
}

export interface AgentTemplateProvenance {
  templateId: string;
  templateContentHash: string;
}

export function assertAgentTemplateId(value: string): void {
  assertRunConfigurationId(value);
}

export function validateAgentTemplateDefinition(
  value: unknown,
  expectedTemplateId?: string,
): AgentTemplateDefinition {
  if (!isRecord(value)) throw new Error("Agent Template definition must be an object.");
  assertExactKeys(
    value,
    ["schemaVersion", "templateId", "title", "origin", "providerSchema", "policy"],
    "Agent Template definition",
    ["schemaVersion", "templateId", "title", "description", "origin", "providerSchema", "policy"],
  );
  if (value.schemaVersion !== 1) throw new Error("Agent Template schemaVersion must be 1.");
  if (typeof value.templateId !== "string") throw new Error("Agent Template templateId must be a versioned ID.");
  assertAgentTemplateId(value.templateId);
  if (expectedTemplateId !== undefined && value.templateId !== expectedTemplateId) {
    throw new Error(`Agent Template ID mismatch: expected ${expectedTemplateId}, found ${value.templateId}.`);
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    throw new Error("Agent Template title must be a non-empty string.");
  }
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.trim().length === 0)) {
    throw new Error("Agent Template description must be a non-empty string when supplied.");
  }
  if (value.origin !== "platform" && value.origin !== "custom") {
    throw new Error("Agent Template origin must be platform or custom.");
  }
  if (!isRecord(value.providerSchema)) throw new Error("Agent Template providerSchema must be an object.");
  assertExactKeys(value.providerSchema, ["executionProvider", "schemaVersion"], "Agent Template providerSchema");
  if (typeof value.providerSchema.executionProvider !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.providerSchema.executionProvider)) {
    throw new Error("Agent Template providerSchema.executionProvider must be a lowercase provider ID.");
  }
  if (!Number.isInteger(value.providerSchema.schemaVersion) || Number(value.providerSchema.schemaVersion) <= 0) {
    throw new Error("Agent Template providerSchema.schemaVersion must be a positive integer.");
  }
  const policy = validateAgentRunPolicy(value.policy, "Agent Template policy");
  if (policy.execution.provider !== value.providerSchema.executionProvider) {
    throw new Error("Agent Template policy provider must match providerSchema.executionProvider.");
  }
  return {
    schemaVersion: 1,
    templateId: value.templateId,
    title: value.title,
    ...(value.description === undefined ? {} : { description: value.description }),
    origin: value.origin,
    providerSchema: {
      executionProvider: value.providerSchema.executionProvider,
      schemaVersion: Number(value.providerSchema.schemaVersion),
    },
    policy,
  };
}

export function agentTemplateContentHash(template: unknown): string {
  return createHash("sha256").update(canonicalJson(template)).digest("hex");
}

export const defaultAgentTemplateDefinitions: readonly AgentTemplateDefinition[] = [
  {
    schemaVersion: 1,
    templateId: "codex-cli-default-v1",
    title: "Codex CLI default",
    description: "Platform starting values for a Codex CLI Agent Slot.",
    origin: "platform",
    providerSchema: { executionProvider: "codex-cli", schemaVersion: 1 },
    policy: {
      timeoutMs: 900_000,
      execution: {
        provider: "codex-cli",
        authProvider: "codex-native-session",
        parameters: { model: "gpt-5.6-luna", model_reasoning_effort: "high" },
      },
    },
  },
  {
    schemaVersion: 1,
    templateId: "pi-cli-default-v1",
    title: "Pi CLI default",
    description: "Platform starting values for a Pi CLI Agent Slot.",
    origin: "platform",
    providerSchema: { executionProvider: "pi-cli", schemaVersion: 1 },
    policy: {
      timeoutMs: 900_000,
      execution: {
        provider: "pi-cli",
        authProvider: "pi-openai-codex-session",
        parameters: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      },
    },
  },
  {
    schemaVersion: 1,
    templateId: "claude-code-cli-default-v2",
    title: "Claude Code CLI default",
    description: "Platform starting values for a Claude Code CLI Agent Slot.",
    origin: "platform",
    providerSchema: { executionProvider: "claude-code-cli", schemaVersion: 1 },
    policy: {
      timeoutMs: 900_000,
      execution: {
        provider: "claude-code-cli",
        authProvider: "claude-code-native-session",
        parameters: { model: "sonnet", effort: "high", "permission-mode": "auto" },
      },
    },
  },
  {
    schemaVersion: 1,
    templateId: "kimi-code-cli-default-v2",
    title: "Kimi Code CLI default",
    description: "Platform starting values for a Kimi Code CLI Agent Slot.",
    origin: "platform",
    providerSchema: { executionProvider: "kimi-code-cli", schemaVersion: 1 },
    policy: {
      timeoutMs: 900_000,
      execution: {
        provider: "kimi-code-cli",
        authProvider: "kimi-code-native-session",
        parameters: { model: "kimi-k2.5", "provider-type": "kimi", "thinking-effort": "high" },
      },
    },
  },
];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
