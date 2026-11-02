import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";

let entryBytes: Uint8Array;
beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../../cli/src/localServer.ts", import.meta.url))],
    bundle: true, platform: "node", target: "node22", format: "esm", write: false,
    plugins: [{ name: "fixture-host-dependencies", setup(builder) {
      builder.onResolve({ filter: /^(vite|typescript-parser|postcss)$/ }, async args => {
        if (args.pluginData?.resolved) return;
        const resolved = await builder.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, pluginData: { resolved: true } });
        return { path: resolved.path, external: true, errors: resolved.errors };
      });
    } }],
  });
  entryBytes = result.outputFiles[0].contents;
});

describe("private CLI server authorization", () => {
  it.each(["disconnect", "wrong-token", "terminate"])("exits before loading project code on %s", async mode => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "arkimux-private-server-")));
    const token = randomUUID();
    const entry = path.join(root, "local-server.mjs"); await writeFile(entry, entryBytes);
    const child = spawn(process.execPath, [entry,
      "--port", "29871", "--project-root", root, "--process-token", token], {
      cwd: root, env: { ...process.env, ARKIMUX_LOCAL_PROCESS_TOKEN: token }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    // The disconnect scenario deliberately closes IPC in the parent. Observe
    // process exit, not the aggregate stdio/IPC close event.
    const closed = once(child, "exit");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await Promise.race([once(child, "message"), closed.then(() => { throw new Error(`Server exited before handshake: ${stderr}`); })]);
      if (mode === "disconnect") child.disconnect();
      else if (mode === "terminate") child.kill("SIGTERM");
      else child.send({ kind: "arkimux-local-start-authorized", token: randomUUID(), pid: child.pid, projectRoot: root, url: "http://127.0.0.1:29871" });
      const [code, signal] = await closed;
      expect(code).toBe(1); expect(signal).toBeNull();
      expect(stderr).toMatch(/disconnected|does not match|stopped before startup/);
      expect(stderr).not.toContain("arkimux.workflows");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);
});
