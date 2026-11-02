import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Debug metadata only. Execution always uses the retained bytes. Current source
 * is compared, never imported, so an edited/deleted file cannot replace old code. */
export async function retainedDebugCode(code: string, buildSha256: string, projectRoot: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(buildSha256)) throw new Error("Invalid retained debug identity.");
  const match = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(code);
  const identity = `arkimux-retained://${buildSha256}/`;
  if (!match) return `${code}\n//# sourceURL=${identity}entry.mjs\n`;
  const map = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  const root = await realpath(projectRoot);
  map.sources = await Promise.all(map.sources.map(async (source: string, index: number) => {
    const relative = source.replace(/^arkimux-source:\/\/\//, "");
    const safe = /^(src|workflows)\//.test(relative) && !relative.split("/").some((part: string) => ["", ".", ".."].includes(part)) && !relative.includes("\\");
    if (safe && typeof map.sourcesContent?.[index] === "string") {
      const file = path.join(root, relative);
      try {
        const resolved = await realpath(file);
        if (resolved.startsWith(root + path.sep) && await readFile(resolved, "utf8") === map.sourcesContent[index]) return pathToFileURL(file).href;
      } catch { /* Deleted/changed source is opened from retained sourcesContent. */ }
    }
    return identity + relative.split("/").map(encodeURIComponent).join("/");
  }));
  map.sourceRoot = "";
  return `${code.slice(0, match.index)}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n//# sourceURL=${identity}entry.mjs\n`;
}
