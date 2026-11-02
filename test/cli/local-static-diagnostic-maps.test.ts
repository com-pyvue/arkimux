import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { Hono } from "hono";
import { mountLocalWebApplication } from "../../local/src/staticWeb.ts";

it("serves the interface but never its private diagnostic maps, including encoded paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-private-maps-"));
  try {
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "<html>Local</html>");
    await writeFile(path.join(root, "assets/index.js"), "// public bundle");
    await writeFile(path.join(root, "assets/index.js.map"), "PRIVATE_MAP");
    const app = mountLocalWebApplication(new Hono(), root);
    expect((await app.request("http://local/assets/index.js")).status).toBe(200);
    for (const file of ["/assets/index.js.map", "/assets/index.js%2Emap", "/assets%2Findex.js.map"]) {
      const response = await app.request(`http://local${file}`);
      expect(response.status).toBe(404); expect(await response.text()).not.toContain("PRIVATE_MAP");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
