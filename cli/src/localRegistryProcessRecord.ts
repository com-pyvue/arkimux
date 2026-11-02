import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The parent finishes recording an OS-selected port after the ready handshake.
 * Do not start child-owned reload writes until that one parent write is finished. */
export async function waitForLocalRegistryRecordUrl(options: { projectRoot: string; pid: number; token: string }, url: string,
  stopped: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  const file = path.join(options.projectRoot, ".arkimux/local/processes/local-server.json");
  while (!stopped()) {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.pid !== options.pid || value.token !== options.token || value.projectRoot !== options.projectRoot) {
      throw new Error("Local process ownership changed during startup.");
    }
    if (value.url === url) return;
    if (Date.now() >= deadline) throw new Error("The CLI did not finish recording the Local server address.");
    await delay(10);
  }
  throw new Error("Local server stopped before registry watching started.");
}

/** Keep generated CLI helpers on the active role. Only the owning child may edit
 * its record; a changed owner is never overwritten or cleaned up here. */
export async function updateLocalRegistryRole(options: { projectRoot: string; pid: number; token: string }, roleId: string): Promise<void> {
  if (!/^arkimux-workflow-developer-v[1-9][0-9]*$/.test(roleId)) throw new Error("Invalid Local workflow role.");
  const file = path.join(options.projectRoot, ".arkimux/local/processes/local-server.json");
  const readOwned = async () => {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Invalid Local process record.");
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.schemaVersion !== 1 || value.pid !== options.pid || value.token !== options.token || value.projectRoot !== options.projectRoot) {
      throw new Error("Local process ownership changed.");
    }
    return value as Record<string, unknown>;
  };
  const previous = await readOwned();
  if (previous.roleId === roleId) return;
  const writeOwned = async (value: Record<string, unknown>) => {
    const temporary = `${file}.registry-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await readOwned();
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  };
  try { await writeOwned({ ...previous, roleId }); }
  catch (error) {
    try { await writeOwned(previous); }
    catch { throw Object.assign(new Error("The Local process role could not be restored. Restart the Local server."), { restartRequired: true }); }
    throw error;
  }
}
