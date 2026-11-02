import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureLocalDebugger, withoutDebuggerEnvironment } from "../../local/src/localDebugger.ts";
import { retainedDebugCode } from "../../local/src/retainedDebugCode.ts";

describe("private debugger boundary", () => {
  it("requires an IDE preload and rejects arbitrary flags and network listeners", () => {
    for (const NODE_OPTIONS of [undefined, "--inspect=0.0.0.0:9229", "--require /tmp/user-script.js", "--require /missing/ms-vscode.js-debug/src/bootloader.js --inspect"]) {
      expect(() => captureLocalDebugger({ NODE_OPTIONS })).toThrow();
    }
  });
  it("passes only the explicit IDE settings and removes them from provider environments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkimux-debug-env-"));
    try {
      const helper = path.join(root, "ms-vscode.js-debug/src/bootloader.js");
      await mkdir(path.dirname(helper), { recursive: true }); await writeFile(helper, "");
      const env = { NODE_OPTIONS: `--require ${JSON.stringify(helper)}`, VSCODE_INSPECTOR_OPTIONS: "fixture", SECRET: "never-forward", PATH: "keep" };
      expect(captureLocalDebugger(env).environment).toEqual({ NODE_OPTIONS: env.NODE_OPTIONS, VSCODE_INSPECTOR_OPTIONS: "fixture" });
      expect(withoutDebuggerEnvironment(env)).toEqual({ SECRET: "never-forward", PATH: "keep" });
      expect(env.NODE_OPTIONS).toContain(helper);
      expect(captureLocalDebugger({ ...env, NODE_OPTIONS: `  --require ${helper}  --inspect-publish-uid=http` }).environment.NODE_OPTIONS)
        .toBe(`--require ${JSON.stringify(helper)} --inspect-publish-uid=http`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("uses matching editor source, but retained source for edited or deleted files", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "arkimux-debug-source-")));
    try {
      await mkdir(path.join(root, "src"));
      const file = path.join(root, "src/workflow.ts"), source = "export const value: number = 1;";
      await writeFile(file, source);
      const map = { version: 3, sources: ["arkimux-source:///src/workflow.ts"], sourcesContent: [source], mappings: "AAAA", names: [] };
      const code = `export const value = 1;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
      const hash = "a".repeat(64);
      const decode = (value: string) => JSON.parse(Buffer.from(/sourceMappingURL=data:application\/json;base64,([^\s]+)/.exec(value)![1], "base64").toString());
      const matching = await retainedDebugCode(code, hash, root);
      expect(decode(matching).sources).toEqual([pathToFileURL(file).href]);
      await writeFile(file, "export const value = 99;");
      const edited = await retainedDebugCode(code, hash, root);
      expect(decode(edited).sources).toEqual([`arkimux-retained://${hash}/src/workflow.ts`]);
      expect(decode(edited).sourcesContent).toEqual([source]);
      expect(edited).toContain("export const value = 1;");
      await rm(file);
      expect(await retainedDebugCode(code, hash, root)).toBe(edited);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("ships automatic child attachment and the proven source-map pause in the IDE launch config", async () => {
    const config = JSON.parse(await readFile("cli/scaffold/.vscode/launch.json", "utf8")).configurations[0];
    expect(config).toMatchObject({ type: "node", request: "launch", args: ["local", "debug"], autoAttachChildProcesses: true,
      sourceMaps: true, pauseForSourceMap: true, resolveSourceMapLocations: null });
  });
});
