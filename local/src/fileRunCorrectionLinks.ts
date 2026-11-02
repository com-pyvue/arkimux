import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runCorrectionLinkSchema,
  type RunCorrectionLinkDto,
} from "../../apps/packages/run/contract/src/index.ts";
import type { RunCorrectionLinks } from "../../apps/packages/run/api/src/index.ts";
import { validateRunRef, type RunRef } from "../../core/src/index.ts";

export class FileRunCorrectionLinks implements RunCorrectionLinks {
  constructor(private readonly root: string) {}

  async create(value: RunCorrectionLinkDto): Promise<RunCorrectionLinkDto> {
    const link = runCorrectionLinkSchema.parse(structuredClone(value));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = this.#file(link.correctedRunRef);
    try {
      await writeFile(file, `${JSON.stringify(link, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return link;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.getByCorrectedRun(link.correctedRunRef);
      if (existing && existing.priorRunRef.executionId === link.priorRunRef.executionId) return existing;
      throw new Error(`Run ${link.correctedRunRef.executionId} already has different correction lineage.`);
    }
  }

  async getByCorrectedRun(value: RunRef): Promise<RunCorrectionLinkDto | undefined> {
    const ref = validateRunRef(structuredClone(value));
    try {
      return runCorrectionLinkSchema.parse(JSON.parse(await readFile(this.#file(ref), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listByPriorRun(value: RunRef): Promise<RunCorrectionLinkDto[]> {
    const ref = validateRunRef(structuredClone(value));
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const links = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => (
      runCorrectionLinkSchema.parse(JSON.parse(await readFile(path.join(this.root, name), "utf8")))
    )));
    return links
      .filter(link => link.priorRunRef.executionId === ref.executionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.correctedRunRef.executionId.localeCompare(right.correctedRunRef.executionId));
  }

  #file(ref: RunRef): string {
    return path.join(this.root, `${validateRunRef(ref).executionId}.json`);
  }
}
