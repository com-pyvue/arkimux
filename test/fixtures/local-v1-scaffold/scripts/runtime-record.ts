import { readFile } from "node:fs/promises";
import path from "node:path";

export interface LocalRuntimeRecord {
  schemaVersion: 1;
  projectRoot: string;
  pid: number;
  roleId: string;
  url: string;
}

export async function readLocalRuntimeRecord(repositoryRoot: string): Promise<LocalRuntimeRecord> {
  const file = path.join(repositoryRoot, ".arkimux/local/processes/local-server.json");
  const value = JSON.parse(await readFile(file, "utf8")) as LocalRuntimeRecord;
  if (value.schemaVersion !== 1 || value.projectRoot !== repositoryRoot || !value.roleId || !value.url) {
    throw new Error("The ArkiMux local process record is invalid. Run arkimux local stop, then start it again.");
  }
  return value;
}
