const usage = [
  "Usage:",
  "  npm create arkimux@latest <project-name>",
  "  npx create-arkimux@latest <project-name>",
  "",
  "Creates a project with the exact ArkiMux generator selected by this bootstrap.",
].join("\n");

/**
 * Run the bootstrap without owning any project-generation or server lifecycle logic.
 * @param {string[]} [args]
 * @param {string} [cwd]
 * @param {import("./index.js").BootstrapDependencies} [dependencies]
 * @returns {Promise<number>}
 */
export async function main(args = process.argv.slice(2), cwd = process.cwd(), dependencies = {}) {
  const stdout = dependencies.stdout ?? ((message) => console.log(message));
  const stderr = dependencies.stderr ?? ((message) => console.error(message));
  try {
    const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
    const [major] = nodeVersion.replace(/^v/, "").split(".").map(Number);
    if (!Number.isInteger(major) || major < 24) {
      throw new Error(`ArkiMux requires Node.js >=24.0.0; current runtime is ${nodeVersion}. Upgrade Node.js and retry.`);
    }
    if (args.length === 0 || (args.length === 1 && ["help", "--help", "-h"].includes(args[0]))) {
      stdout(usage);
      return 0;
    }
    const runCli = dependencies.runCli ?? await loadGenerator();
    const result = await runCli(["create", ...args], cwd);
    stdout(result.message);
    return 0;
  } catch (error) {
    stderr(`create-arkimux: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function loadGenerator() {
  try {
    const { runCreateArkiMuxCli } = await import("@com-pyvue/arkimux/create");
    return runCreateArkiMuxCli;
  } catch (error) {
    throw new Error("Could not load the pinned ArkiMux generator. Reinstall create-arkimux and retry.", { cause: error });
  }
}
