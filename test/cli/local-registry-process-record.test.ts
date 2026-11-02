import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateLocalRegistryRole, waitForLocalRegistryRecordUrl } from "../../cli/src/localRegistryProcessRecord.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "registry-role-")); roots.push(projectRoot);
  const owner = { projectRoot, pid: process.pid, token: "owned-token" };
  const file = path.join(projectRoot, ".arkimux/local/processes/local-server.json");
  await mkdir(path.dirname(file), { recursive: true });
  const record = { schemaVersion: 1, ...owner, roleId: "arkimux-workflow-developer-v1", url: "http://127.0.0.1:1234", command: "unchanged" };
  await writeFile(file, JSON.stringify(record));
  return { owner, file, record };
}
it("updates only the owning record role and preserves address and command", async () => {
  const f = await fixture();
  await updateLocalRegistryRole(f.owner, "arkimux-workflow-developer-v2");
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({ ...f.record, roleId: "arkimux-workflow-developer-v2" });
  await updateLocalRegistryRole(f.owner, f.record.roleId);
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual(f.record);
});
it("does not overwrite a different owner or accept an arbitrary role", async () => {
  const f = await fixture();
  await expect(updateLocalRegistryRole({ ...f.owner, token: "different" }, "arkimux-workflow-developer-v2")).rejects.toThrow("ownership");
  await expect(updateLocalRegistryRole(f.owner, "administrator")).rejects.toThrow("Invalid Local workflow role");
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual(f.record);
});
it("rejects a symbolic process record without changing the target", async () => {
  const f = await fixture(), original = `${f.file}.original`;
  await writeFile(original, JSON.stringify(f.record)); await rm(f.file); await symlink(original, f.file);
  await expect(updateLocalRegistryRole(f.owner, "arkimux-workflow-developer-v2")).rejects.toThrow("Invalid Local process record");
  expect(JSON.parse(await readFile(original, "utf8"))).toEqual(f.record);
});
it("waits for the parent address write without changing the active role", async () => {
  const f = await fixture();
  await updateLocalRegistryRole(f.owner, "arkimux-workflow-developer-v2");
  const url = "http://127.0.0.1:5678";
  const waiting = waitForLocalRegistryRecordUrl(f.owner, url, () => false);
  const current = JSON.parse(await readFile(f.file, "utf8"));
  await writeFile(f.file, JSON.stringify({ ...current, url }));
  await waiting;
  expect(JSON.parse(await readFile(f.file, "utf8"))).toMatchObject({ url, roleId: "arkimux-workflow-developer-v2" });
});
it("stops waiting when shutdown starts", async () => {
  const f = await fixture();
  await expect(waitForLocalRegistryRecordUrl(f.owner, "http://127.0.0.1:5678", () => true)).rejects.toThrow("stopped");
});
