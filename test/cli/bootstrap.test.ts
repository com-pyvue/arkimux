import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../../bootstrap/src/index.js";

describe("create-arkimux bootstrap", () => {
  it("delegates project creation and the caller's directory to the public CLI", async () => {
    const runCli = vi.fn(async () => ({ kind: "create" as const, message: "Created my-agent-app." }));
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await main(["my-agent-app"], "/tmp/arkimux-bootstrap-parent", {
      runCli, stdout, stderr, nodeVersion: "24.0.0",
    });

    expect(runCli).toHaveBeenCalledExactlyOnceWith(["create", "my-agent-app"], "/tmp/arkimux-bootstrap-parent");
    expect(stdout).toHaveBeenCalledExactlyOnceWith("Created my-agent-app.");
    expect(stderr).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("passes all generator arguments unchanged instead of implementing their behavior", async () => {
    const runCli = vi.fn(async () => ({ kind: "create" as const, message: "Created." }));
    await main(["my-agent-app", "--unknown"], "/tmp/arkimux-bootstrap-parent", {
      runCli, stdout: vi.fn(), stderr: vi.fn(), nodeVersion: "24.0.0",
    });

    expect(runCli).toHaveBeenCalledExactlyOnceWith(
      ["create", "my-agent-app", "--unknown"],
      "/tmp/arkimux-bootstrap-parent",
    );
  });

  it.each([[], ["help"], ["--help"], ["-h"]])("prints help without loading or invoking the generator: %j", async (...args) => {
    const runCli = vi.fn();
    const stdout = vi.fn();
    const stderr = vi.fn();
    const exitCode = await main(args, "/tmp/arkimux-bootstrap-parent", {
      runCli, stdout, stderr, nodeVersion: "24.0.0",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("npm create arkimux@latest <project-name>"));
    expect(stderr).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it("returns a failing exit code and preserves actionable generator errors", async () => {
    const runCli = vi.fn(async () => { throw new Error("Target directory /tmp/my-agent-app is not empty."); });
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await main(["my-agent-app"], "/tmp", {
      runCli, stdout, stderr, nodeVersion: "24.0.0",
    });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith("create-arkimux: Target directory /tmp/my-agent-app is not empty.");
  });

  it.each(["20.20.0", "23.11.1", "invalid"])("rejects unsupported Node %s before invoking the generator", async (nodeVersion) => {
    const runCli = vi.fn();
    const stderr = vi.fn();
    const exitCode = await main(["my-agent-app"], "/tmp", {
      runCli, stdout: vi.fn(), stderr, nodeVersion,
    });

    expect(exitCode).toBe(1);
    expect(runCli).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Upgrade Node.js and retry."));
  });

  it("ships source and selects one exact ArkiMux generator dependency", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("bootstrap/package.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "create-arkimux",
      version: "0.1.0-alpha.2",
      license: "Apache-2.0",
      type: "module",
      bin: { "create-arkimux": "./src/cli.js" },
      engines: { node: ">=24.0.0" },
    });
    const cli = JSON.parse(await readFile(path.resolve("cli/package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@com-pyvue/arkimux": cli.version });
    expect(manifest.files).toContain("src");
    expect(manifest.scripts).toBeUndefined();
    expect(cli.exports["./create"].import).toBe("./dist/create.js");
    expect(cli.files).toContain("npm-shrinkwrap.json");
    const shrinkwrap = JSON.parse(await readFile(path.resolve("cli/npm-shrinkwrap.json"), "utf8"));
    expect(shrinkwrap.version).toBe(cli.version);
    expect(shrinkwrap.packages["node_modules/@rollup/rollup-darwin-arm64"]?.optional).toBe(true);
  });
});
