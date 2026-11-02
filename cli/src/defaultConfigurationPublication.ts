import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { workflowIdentitySchema, workflowListResponseSchema } from "../../apps/packages/run/contract/src/index.ts";
import { runBeforeDeadline } from "./localStartup.ts";

/** Private startup helper. Removing a registration must not require deleting
 * its project files or the configurations pinned by existing Runs. */
export async function publishDefaultConfigurations(input: {
  projectRoot: string;
  url: string;
  deadline: number;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const request = input.fetchImpl ?? fetch;
  const catalog = await runBeforeDeadline(input.deadline, async signal => {
    const response = await request(`${input.url}/api/v1/workflows`, { signal });
    if (!response.ok) throw new Error(`Could not read the registered workflows: HTTP ${response.status}.`);
    let value: unknown;
    try { value = await response.json(); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new Error("Local server returned an invalid workflow catalog.");
    }
    const parsed = workflowListResponseSchema.safeParse(value);
    if (!parsed.success) throw new Error("Local server returned an invalid workflow catalog.");
    return parsed.data.items;
  });
  const registered = new Set(catalog.map(({ workflow }) => JSON.stringify([workflow.kind, workflow.version])));
  const messages: string[] = [];
  for (const folder of await readdir(path.join(input.projectRoot, "workflows"), { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const directory = path.join(input.projectRoot, "workflows", folder.name, "run-configurations");
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files.filter(name => name.endsWith(".json")).sort()) {
      const filePath = path.join(directory, file);
      const label = JSON.stringify(path.relative(input.projectRoot, filePath).split(path.sep).join("/"));
      const source = await readFile(filePath, "utf8");
      let definition: unknown;
      try { definition = JSON.parse(source); }
      catch { throw new Error(`Invalid JSON in default Run Configuration ${label}.`); }
      const identity = workflowIdentitySchema.safeParse(typeof definition === "object" && definition !== null
        ? (definition as { workflow?: unknown }).workflow : undefined);
      if (!identity.success) throw new Error(`Default Run Configuration ${label} must declare a valid workflow ID and version.`);
      const workflow = identity.data;
      if (!registered.has(JSON.stringify([workflow.kind, workflow.version]))) {
        messages.push(`Skipped default Run Configuration ${label}: ${workflow.kind}@${workflow.version} is not registered.`);
        continue;
      }
      const { response, errorBody } = await runBeforeDeadline(input.deadline, async signal => {
        const response = await request(`${input.url}/api/v1/workflows/${encodeURIComponent(workflow.kind)}/${workflow.version}/run-configurations`, {
          method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ definition }), signal,
        });
        return { response, errorBody: response.ok ? "" : await response.text() };
      });
      // A failed publication for a registered workflow is still a startup error.
      // In particular, never reinterpret a permission failure as a removed workflow.
      if (!response.ok) throw new Error(`Could not publish the default Run Configuration: HTTP ${response.status} ${errorBody}`);
    }
  }
  return messages;
}
