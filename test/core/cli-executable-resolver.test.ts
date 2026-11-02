import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeCliExecutable,
  resolveCliExecutable,
} from "../../core/src/infrastructure/agents/cliExecutableResolver.ts";
import { loadPiCliModelOptions, loadPiCliOpenAiCodexModelOptions, loadPiCliProbeModels } from "../../core/src/infrastructure/agents/piCliModelCatalog.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("CLI executable resolution", () => {
  it("prefers an explicit command over repository-local and PATH commands", async () => {
    const root = await temporaryDirectory();
    const explicit = await executable(path.join(root, "explicit", "agent"));
    await executable(path.join(root, "node_modules", ".bin", "agent"));
    await executable(path.join(root, "path-bin", "agent"));

    await expect(resolveCliExecutable(explicit, root, {
      PATH: path.join(root, "path-bin"),
    })).resolves.toEqual({ command: explicit, source: "explicit" });
  });

  it("prefers a repository-local command over PATH", async () => {
    const root = await temporaryDirectory();
    const local = await executable(path.join(root, "node_modules", ".bin", "agent"));
    await executable(path.join(root, "path-bin", "agent"));

    await expect(resolveCliExecutable("agent", root, {
      PATH: path.join(root, "path-bin"),
    })).resolves.toEqual({ command: local, source: "repository-local" });
  });

  it("falls back to PATH and reports missing commands", async () => {
    const root = await temporaryDirectory();
    const fromPath = await executable(path.join(root, "path-bin", "agent"));
    const environment = { PATH: path.dirname(fromPath) };

    await expect(resolveCliExecutable("agent", root, environment))
      .resolves.toEqual({ command: fromPath, source: "path" });
    await expect(resolveCliExecutable("missing-agent", root, environment)).resolves.toBeUndefined();
  });

  it("probes whether the resolved executable can actually start", async () => {
    const root = await temporaryDirectory();
    const working = await executable(path.join(root, "working-agent"));
    const broken = path.join(root, "broken-agent");
    await fs.writeFile(broken, "#!/bin/sh\necho incompatible runtime >&2\nexit 1\n", "utf8");
    await fs.chmod(broken, constants.S_IRUSR | constants.S_IWUSR | constants.S_IXUSR);

    await expect(probeCliExecutable(working, root, { PATH: process.env.PATH }))
      .resolves.toEqual({ available: true });
    await expect(probeCliExecutable(broken, root, { PATH: process.env.PATH }))
      .resolves.toEqual(expect.objectContaining({
        available: false,
        message: expect.stringContaining("incompatible runtime"),
      }));
  });

  it("loads the OpenAI Codex model catalog from the repository-local Pi installation", async () => {
    const root = await temporaryDirectory();
    const piPackage = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const piAiPackage = path.join(piPackage, "node_modules", "@earendil-works", "pi-ai");
    const piExecutable = await executable(path.join(piPackage, "dist", "cli.js"));
    await fs.mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await fs.symlink(piExecutable, path.join(root, "node_modules", ".bin", "pi"));
    await fs.mkdir(path.join(piAiPackage, "dist", "providers", "data"), { recursive: true });
    await fs.writeFile(path.join(piAiPackage, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      main: "dist/index.js",
    }), "utf8");
    await fs.writeFile(path.join(piAiPackage, "dist", "index.js"), "export {};\n", "utf8");
    await fs.writeFile(
      path.join(piAiPackage, "dist", "providers", "data", "openai-codex.json"),
      JSON.stringify({
        api: {
          luna: { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai-codex" },
          ignored: { id: "gpt-other", name: "Other", provider: "openai" },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(piAiPackage, "dist", "providers", "data", "openai.json"),
      JSON.stringify({
        responses: {
          mini: { id: "gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openai" },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(piAiPackage, "dist", "providers", "data", "moonshotai.json"),
      JSON.stringify({
        completions: {
          kimi: { id: "kimi-k2.5", name: "Kimi K2.5", provider: "moonshotai", cost: { input: 1, output: 1 } },
          expensive: { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", provider: "moonshotai", cost: { input: 2, output: 2 } },
          preview: { id: "kimi-k2-0711-preview", name: "Kimi K2 Preview", provider: "moonshotai", cost: { input: 0, output: 0 } },
        },
      }),
      "utf8",
    );

    await expect(loadPiCliOpenAiCodexModelOptions({ cwd: root, environment: { PATH: "" } }))
      .resolves.toEqual([{ value: "gpt-5.6-luna", label: "GPT-5.6 Luna" }]);
    await expect(loadPiCliModelOptions({ cwd: root, environment: { PATH: "" }, modelProvider: "openai" }))
      .resolves.toEqual([{ value: "gpt-4.1-mini", label: "GPT-4.1 mini" }]);
    await expect(loadPiCliModelOptions({ cwd: root, environment: { PATH: "" }, modelProvider: "moonshotai" }))
      .resolves.toEqual([
        { value: "kimi-k2-0711-preview", label: "Kimi K2 Preview" },
        { value: "kimi-k2.5", label: "Kimi K2.5" },
        { value: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
      ]);
    await expect(loadPiCliProbeModels({ cwd: root, environment: { PATH: "" }, modelProvider: "moonshotai" }))
      .resolves.toEqual(["kimi-k2.5", "kimi-k2.7-code", "kimi-k2-0711-preview"]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-cli-resolver-"));
  directories.push(directory);
  return directory;
}

async function executable(file: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(file, constants.S_IRUSR | constants.S_IWUSR | constants.S_IXUSR);
  return file;
}
