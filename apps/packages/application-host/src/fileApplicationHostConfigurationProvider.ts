import { promises as fs } from "node:fs";
import path from "node:path";
import {
  applicationHostConfigurationContentHash,
  assertApplicationHostConfigurationId,
  validateApplicationHostConfiguration,
  type ApplicationHostConfigurationContext,
  type ApplicationHostConfigurationProvider,
  type ResolvedApplicationHostConfiguration,
} from "./configuration.ts";

export class FileApplicationHostConfigurationProvider implements ApplicationHostConfigurationProvider {
  readonly configurationDirectory: string;
  readonly #resolvedHashes = new Map<string, string>();

  constructor(configurationDirectory: string) {
    this.configurationDirectory = path.resolve(configurationDirectory);
  }

  async resolve(
    configurationId: string,
    _context: ApplicationHostConfigurationContext,
  ): Promise<ResolvedApplicationHostConfiguration> {
    assertApplicationHostConfigurationId(configurationId);
    const filePath = path.join(this.configurationDirectory, `${configurationId}.json`);
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Application-host configuration ${configurationId} could not be read: ${(error as Error).message}`);
    }
    const configuration = validateApplicationHostConfiguration(value, configurationId);
    const contentHash = applicationHostConfigurationContentHash(configuration);
    const previousHash = this.#resolvedHashes.get(configurationId);
    if (previousHash !== undefined && previousHash !== contentHash) {
      throw new Error(`Application-host configuration ${configurationId} changed after process resolution.`);
    }
    this.#resolvedHashes.set(configurationId, contentHash);
    return { configuration, contentHash };
  }
}
