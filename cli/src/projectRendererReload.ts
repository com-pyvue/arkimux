import path from "node:path";
import { realpath } from "node:fs/promises";
import { createServer, type ModuleNode } from "vite";
import { validateProjectSource } from "./projectSourceGuard.ts";
import { assertLocalRendererDeclarations } from "../../local/src/workflowDeclarations.ts";
import type { LocalResultView, LocalResultViewSource } from "../../local/src/resultViews.ts";

/** Vite transforms trusted project renderers only. No HTTP server or project config/.env loader. */
export async function createProjectResultViewSource(repositoryRoot: string): Promise<LocalResultViewSource> {
  const root = await realpath(repositoryRoot);
  const entry = "/src/arkimux.renderers.tsx";
  const vite = await createServer({
    root, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, hmr: false, watch: { ignored: ["**/.arkimux/**", "**/.env*", "**/node_modules/**"] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    css: { postcss: { plugins: [] } },
    esbuild: { jsx: "automatic" },
  });
  let current: ReturnType<LocalResultViewSource["snapshot"]> = { revision: 0, status: "unavailable", views: [] };
  let closed = false;
  let requested = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();

  async function reload(generation: number): Promise<void> {
    let next: readonly LocalResultView[] = [];
    let status: "ready" | "unavailable" | "error" = "unavailable";
    try {
      const checked = await validateProjectSource(root);
      if (checked.rendererRegistryPresent && !checked.rendererRegistryEmpty) {
        vite.moduleGraph.invalidateAll();
        const loaded = await vite.ssrLoadModule(entry);
        assertLocalRendererDeclarations(checked.renderers, loaded.resultViews);
        assertLocalRendererDeclarations(loaded.rendererDeclarations, loaded.resultViews);
        // SSR does not inject CSS into a browser. Use Vite's processed inline CSS
        // from this renderer's graph, including CSS imports and CSS modules.
        const css: string[] = [];
        const visited = new Set<ModuleNode>();
        const collect = async (module: ModuleNode | undefined): Promise<void> => {
          if (!module || visited.has(module)) return;
          visited.add(module);
          for (const dependency of module.ssrImportedModules) await collect(dependency);
          if (module.file?.endsWith(".css") && !module.url.includes("?inline")) {
            const inline = await vite.ssrLoadModule(`${module.url.split("?")[0]}?inline`);
            if (typeof inline.default !== "string") throw new Error("Invalid CSS output.");
            css.push(inline.default);
          }
        };
        await collect(await vite.moduleGraph.getModuleByUrl(entry));
        const styles = css.length ? `<style>${css.join("\n").replace(/<\/style/gi, "<\\/style")}</style>` : "";
        next = (loaded.resultViews as LocalResultView[]).map(view => ({
          resultKind: view.resultKind, payloadSchemaVersion: view.payloadSchemaVersion,
          render: async (payload: unknown) => `${styles}${await view.render(payload)}`,
        }));
        status = "ready";
      }
    } catch {
      status = "error";
      // Do not expose module errors, local paths or source content to the UI.
      // A later valid save rebuilds the graph and restores the view automatically.
    }
    if (!closed && generation === requested) current = { revision: current.revision + 1, status, views: next };
  }
  const schedule = (file: string) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!/^(src|workflows)\//.test(relative) || !/\.(?:[cm]?[jt]sx?|css|json)$/.test(relative)) return;
    requested++;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const generation = requested;
      pending = pending.then(() => reload(generation));
    }, 75);
  };
  vite.watcher.on("change", schedule).on("add", schedule).on("unlink", schedule);
  await reload(requested);
  return {
    snapshot: () => current,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      vite.watcher.off("change", schedule).off("add", schedule).off("unlink", schedule);
      await pending;
      await vite.close();
    },
  };
}
