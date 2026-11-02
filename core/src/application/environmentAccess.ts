import {
  validateEnvironmentPlacement,
  validateEnvironmentRef,
  validateOrganizationRef,
  type EnvironmentPlacement,
  type EnvironmentRef,
  type OrganizationRef,
} from "../domain/platformResource.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";
import { canonicalTimestamp, requiredString } from "./recordValidation.ts";

export interface HybridEnvironmentAccessV1 {
  schemaVersion: 1;
  organization: OrganizationRef;
  environment: EnvironmentRef;
  placement: EnvironmentPlacement;
  adapterContracts: {
    runState: string;
    runArtifacts: string;
    runPerformance: string;
    publishedResults: string;
  };
  aws: {
    region: string;
    stateTableName?: string;
    artifactBucketName?: string;
    resultBucketName?: string;
    dispatchTopicArn?: string;
    dataApiBaseUrl: string;
  };
  platformBaseUrl: string;
  generatedAt: string;
}

export function validateHybridEnvironmentAccessV1(value: unknown): HybridEnvironmentAccessV1 {
  if (!isRecord(value)) throw new Error("Hybrid environment access must be an object.");
  assertExactKeys(
    value,
    ["schemaVersion", "organization", "environment", "placement", "adapterContracts", "aws", "platformBaseUrl", "generatedAt"],
    "Hybrid environment access",
  );
  if (value.schemaVersion !== 1) throw new Error("Hybrid environment access.schemaVersion must be 1.");
  if (!isRecord(value.adapterContracts)) {
    throw new Error("Hybrid environment access.adapterContracts must be an object.");
  }
  const contractKeys = ["runState", "runArtifacts", "runPerformance", "publishedResults"];
  assertExactKeys(value.adapterContracts, contractKeys, "Hybrid environment access.adapterContracts");
  const contracts = Object.fromEntries(contractKeys.map((key) => {
    const contract = value.adapterContracts as Record<string, unknown>;
    requiredString(contract[key], `Hybrid environment access.adapterContracts.${key}`);
    return [key, contract[key]];
  })) as HybridEnvironmentAccessV1["adapterContracts"];
  if (!isRecord(value.aws)) throw new Error("Hybrid environment access.aws must be an object.");
  const awsRequired = ["region", "dataApiBaseUrl"];
  const awsOptional = ["stateTableName", "artifactBucketName", "resultBucketName", "dispatchTopicArn"];
  assertExactKeys(value.aws, awsRequired, "Hybrid environment access.aws", [...awsRequired, ...awsOptional]);
  const aws: HybridEnvironmentAccessV1["aws"] = {
    region: requireNonSecretString(value.aws.region, "Hybrid environment access.aws.region"),
    dataApiBaseUrl: requireUrl(value.aws.dataApiBaseUrl, "Hybrid environment access.aws.dataApiBaseUrl"),
  };
  for (const key of awsOptional) {
    const nested = value.aws[key];
    if (nested !== undefined) {
      aws[key as keyof typeof aws] = requireNonSecretString(
        nested,
        `Hybrid environment access.aws.${key}`,
      );
    }
  }
  const platformBaseUrl = requireUrl(value.platformBaseUrl, "Hybrid environment access.platformBaseUrl");
  canonicalTimestamp(value.generatedAt, "Hybrid environment access.generatedAt");
  assertNoCredentialKeys(value);
  return {
    schemaVersion: 1,
    organization: validateOrganizationRef(value.organization),
    environment: validateEnvironmentRef(value.environment),
    placement: validateEnvironmentPlacement(value.placement),
    adapterContracts: contracts,
    aws,
    platformBaseUrl,
    generatedAt: value.generatedAt,
  };
}

function requireNonSecretString(value: unknown, location: string): string {
  requiredString(value, location);
  return value;
}

function requireUrl(value: unknown, location: string): string {
  const text = requireNonSecretString(value, location);
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${location} must be an HTTP(S) URL.`);
  }
  return text;
}

function assertNoCredentialKeys(value: unknown, path = "Hybrid environment access"): void {
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoCredentialKeys(nested, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:secret|token|password|credential|accessKey|sessionKey|authorization)/i.test(key)) {
      throw new Error(`${path} contains prohibited credential field ${key}.`);
    }
    assertNoCredentialKeys(nested, `${path}.${key}`);
  }
}
