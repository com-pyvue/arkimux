import { assertExactKeys, isRecord } from "./validation.ts";

const configurationIdPattern = /^[a-z][a-z0-9-]*-v[1-9][0-9]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export interface RunConfigurationReference {
  configurationId: string;
  contentHash: string;
}

export function assertRunConfigurationId(configurationId: unknown): asserts configurationId is string {
  if (typeof configurationId !== "string" || !configurationIdPattern.test(configurationId)) {
    throw new Error("Run configuration ID must be a lowercase versioned ID ending in -v<number>.");
  }
}

export function validateRunConfigurationReference(value: unknown): RunConfigurationReference {
  if (!isRecord(value)) throw new Error("Run configuration reference must be an object.");
  assertExactKeys(value, ["configurationId", "contentHash"], "Run configuration reference");
  assertRunConfigurationId(value.configurationId);
  if (typeof value.contentHash !== "string" || !sha256Pattern.test(value.contentHash)) {
    throw new Error("Run configuration reference.contentHash must be a lowercase SHA-256 digest.");
  }
  return {
    configurationId: value.configurationId,
    contentHash: value.contentHash,
  };
}
