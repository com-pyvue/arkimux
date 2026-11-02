import { promises as fs } from "node:fs";
import path from "node:path";
import {
  platformConfigurationContentHash,
  validateAgentExecutionPlatformConfigurationV1,
  validateAgentExecutionPlatformConfigurationV2,
  validateAgentExecutionPlatformConfigurationV3,
  validateAgentExecutionPlatformConfigurationV4,
  type PlatformConfigurationContext,
  type PlatformConfigurationProvider,
  type ResolvedPlatformConfiguration,
} from "../../application/platformConfiguration.ts";

export interface FilePlatformConfigurationProviderOptions {
  configurationDirectory: string;
}

export class FilePlatformConfigurationProvider implements PlatformConfigurationProvider {
  private readonly configurationDirectory: string;
  private readonly resolvedHashes = new Map<string, string>();

  constructor(options: FilePlatformConfigurationProviderOptions) {
    this.configurationDirectory = path.resolve(options.configurationDirectory);
  }

  async resolve(
    configurationId: string,
    _context: PlatformConfigurationContext,
  ): Promise<ResolvedPlatformConfiguration> {
    const filePath = path.join(this.configurationDirectory, `${configurationId}.json`);
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `Platform configuration ${configurationId} could not be read from ${filePath}: ${(error as Error).message}`,
      );
    }
    const configuration = typeof value === "object" && value !== null && "schemaVersion" in value
      && value.schemaVersion === 4
      ? validateAgentExecutionPlatformConfigurationV4(value, configurationId)
      : typeof value === "object" && value !== null && "schemaVersion" in value
      && value.schemaVersion === 3
      ? validateAgentExecutionPlatformConfigurationV3(value, configurationId)
      : typeof value === "object" && value !== null && "schemaVersion" in value
        && value.schemaVersion === 2
        ? validateAgentExecutionPlatformConfigurationV2(value, configurationId)
        : validateAgentExecutionPlatformConfigurationV1(value, configurationId);
    const contentHash = platformConfigurationContentHash(configuration);
    const previousHash = this.resolvedHashes.get(configurationId);
    if (previousHash !== undefined && previousHash !== contentHash) {
      throw new Error(`Platform configuration ${configurationId} changed after it was resolved by this process.`);
    }
    this.resolvedHashes.set(configurationId, contentHash);
    return { configuration, contentHash };
  }
}
