import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installationDiagnostic } from "./installationDiagnostic.ts";

interface CandidatePackageIndex {
  schemaVersion: 1;
  packages: { name: string; version: string; file: string; integrity: string }[];
}

export interface CreatedProject {
  kind: "create";
  projectRoot: string;
  message: string;
}

/** The create path intentionally has no imports from the Local server or Vite. */
export async function createProject(input: {
  cwd: string;
  projectName: string;
  packageRoot: string;
  environment: NodeJS.ProcessEnv;
}): Promise<CreatedProject> {
  assertProjectName(input.projectName);
  const target = path.resolve(input.cwd, input.projectName);
  const targetState = await pathState(target);
  if (targetState === "file") throw new Error(`Target ${target} is a file.`);
  if (targetState === "non-empty-directory") throw new Error(`Target directory ${target} is not empty.`);
  const createdTarget = targetState === "missing";
  if (createdTarget) await mkdir(target, { recursive: false });
  try {
    const packageIndex = JSON.parse(await readFile(path.join(input.packageRoot, "packages", "candidate-packages.json"), "utf8")) as CandidatePackageIndex;
    validatePackageIndex(packageIndex);
    const cliPackage = JSON.parse(await readFile(path.join(input.packageRoot, "package.json"), "utf8")) as { name: string; version: string };
    if (cliPackage.name !== "@com-pyvue/arkimux" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cliPackage.version)) {
      throw new Error("The installed ArkiMux package does not declare an exact CLI release version.");
    }
    await copyScaffold(path.join(input.packageRoot, "scaffold"), target, {
      "__PROJECT_NAME__": input.projectName,
      "__CLI_VERSION__": cliPackage.version,
      "__CORE_TARBALL__": packageFile(packageIndex, "@com-pyvue/agent-execution-core"),
      "__LOCAL_TARBALL__": packageFile(packageIndex, "@com-pyvue/agent-execution-local"),
      "__RUN_CONTRACT_TARBALL__": packageFile(packageIndex, "@com-pyvue/agent-execution-run-contract"),
    });
    await cp(path.join(input.packageRoot, "packages"), path.join(target, "vendor"), {
      recursive: true,
      filter: source => !source.endsWith("candidate-packages.json"),
    });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // Freeze the complete dependency tree before installing it. The second
    // command consumes that exact lock and installs platform optional packages.
    for (const args of [
      ["install", "--package-lock-only", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"],
      ["ci", "--include=optional", "--no-audit", "--no-fund"],
    ]) {
      const install = spawnSync(npm, args, { cwd: target, encoding: "utf8", env: input.environment });
      if (install.status !== 0) {
        await writeFile(path.join(target, ".arkimux-create-failed.json"), `${JSON.stringify({
          schemaVersion: 1,
          command: `npm ${args.join(" ")}`,
          status: install.status,
          ...installationDiagnostic(install, input.environment),
          cleanup: `Remove ${target} after inspecting this file, then run arkimux create ${input.projectName} again.`,
        }, null, 2)}\n`);
        throw new Error(`Project files were created at ${target}, but npm install failed. See .arkimux-create-failed.json.`);
      }
    }
    return {
      kind: "create",
      projectRoot: target,
      message: [
        `Created ArkiMux project at ${target}.`,
        "Included workflows: weather-advisor@1, graph-invocation@1",
        `Next: cd ${input.projectName} && cp .env.example .env`,
        "Set WEATHER_API_URL in .env (for example https://wttr.in), then run npm run dev.",
      ].join("\n"),
    };
  } catch (error) {
    if (createdTarget && (await readdir(target).catch(() => ["missing"])).length === 0) await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function copyScaffold(source: string, target: string, replacements: Record<string, string>): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name === "gitignore" ? ".gitignore" : entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyScaffold(sourcePath, targetPath, replacements);
    } else {
      const sourceValue = await readFile(sourcePath);
      if (sourceValue.includes(0)) await writeFile(targetPath, sourceValue);
      else {
        let value = sourceValue.toString("utf8");
        for (const [token, replacement] of Object.entries(replacements)) value = value.split(token).join(replacement);
        await writeFile(targetPath, value);
      }
      if (entry.name.endsWith(".sh")) await chmod(targetPath, 0o755);
    }
  }
}

function validatePackageIndex(value: CandidatePackageIndex): void {
  if (value.schemaVersion !== 1 || !Array.isArray(value.packages)) throw new Error("Candidate package index is invalid.");
  for (const name of ["@com-pyvue/agent-execution-core", "@com-pyvue/agent-execution-local", "@com-pyvue/agent-execution-run-contract"]) packageFile(value, name);
}

function packageFile(index: CandidatePackageIndex, name: string): string {
  const candidate = index.packages.find(item => item.name === name);
  if (!candidate || !candidate.file.endsWith(".tgz") || !candidate.integrity.startsWith("sha512-")) {
    throw new Error(`Candidate package ${name} is missing or incomplete.`);
  }
  return candidate.file;
}

function assertProjectName(value: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(value) || value.endsWith("-")) {
    throw new Error("Project name must start with a lowercase letter, contain only lowercase letters, numbers, and hyphens, and not end with a hyphen.");
  }
}

async function pathState(target: string): Promise<"missing" | "file" | "empty-directory" | "non-empty-directory"> {
  const info = await stat(target).catch(() => undefined);
  if (!info) return "missing";
  if (!info.isDirectory()) return "file";
  return (await readdir(target)).length === 0 ? "empty-directory" : "non-empty-directory";
}

/** Used by the small bootstrap package without evaluating the complete CLI. */
export async function runCreateArkiMuxCli(args: string[], cwd = process.cwd()): Promise<CreatedProject> {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 24) throw new Error(`ArkiMux requires Node.js >=24.0.0; current runtime is ${process.versions.node}.`);
  if (args[0] !== "create" || !args[1] || args[1].startsWith("-")) throw new Error("arkimux create requires a project name.");
  if (args.length !== 2) throw new Error(`Unknown option ${args[2]}.`);
  return createProject({ cwd, projectName: args[1], packageRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), environment: process.env });
}
