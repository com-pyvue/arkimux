import { createHash } from "node:crypto";
import { TraceMap, eachMapping, originalPositionFor, type EachMapping } from "@jridgewell/trace-mapping";
import { HeadlessDebuggerError } from "./headlessDebuggerContracts.ts";

export interface LiveSourceLocation { sourceId: string; line: number; column: number }
export interface LiveSourceDescriptor { sourceId: string; buildSha256: string; displayPath: string; contentSha256: string; exactSourceMap: true }
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const bad = () => new HeadlessDebuggerError("source_mapping_unavailable", "Retained source or location is unavailable.", "after_action");

/** Reads only the retained inline map. Current project files are never consulted. */
export class HeadlessDebugSources {
  readonly scriptUrl: string;
  readonly #map: TraceMap | undefined;
  readonly #entries: { descriptor: LiveSourceDescriptor; original: string; text: string }[] = [];
  readonly #mappings: EachMapping[] = [];
  constructor(code: string, readonly buildSha256: string) {
    if (!/^[a-f0-9]{64}$/.test(buildSha256)) throw bad();
    this.scriptUrl = `arkimux-retained://${buildSha256}/entry.mjs`;
    const encoded = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(code)?.[1];
    if (!encoded) return;
    try {
      const raw = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (raw.version !== 3 || !Array.isArray(raw.sources) || !Array.isArray(raw.sourcesContent)) return;
      this.#map = new TraceMap(raw);
      for (let index = 0; index < raw.sources.length; index++) {
        const original = this.#map.resolvedSources[index];
        const displayPath = String(raw.sources[index]).replace(/^arkimux-source:\/\/\//, "");
        if (!/^(src|workflows)\//.test(displayPath) || displayPath.includes("\\") || displayPath.split("/").some(p => ["", ".", ".."].includes(p))) continue;
        const text = raw.sourcesContent[index];
        if (typeof text !== "string") continue;
        const descriptor = { sourceId: `source-${sha(`${buildSha256}:${displayPath}`).slice(0, 40)}`, buildSha256,
          displayPath, contentSha256: sha(text), exactSourceMap: true as const };
        this.#entries.push({ descriptor, original, text });
      }
      eachMapping(this.#map, mapping => { if (this.#entries.some(e => e.original === mapping.source)) this.#mappings.push(mapping); });
    } catch { throw bad(); }
  }
  list(offset: number, limit: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw bad();
    return { items: this.#entries.slice(offset, offset + limit).map(e => e.descriptor), total: this.#entries.length,
      nextOffset: offset + limit < this.#entries.length ? offset + limit : null };
  }
  read(sourceId: string, offset: number, limit: number, knownSecrets: readonly string[] = []) {
    const entry = this.#entries.find(e => e.descriptor.sourceId === sourceId);
    if (!entry || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 262144) throw bad();
    if (knownSecrets.some(secret => secret && entry.text.includes(secret))) throw new HeadlessDebuggerError("inspection_unavailable", "This retained source contains a known credential and cannot be disclosed.", "after_action");
    const bytes = Buffer.from(entry.text);
    if (offset > bytes.length) throw bad();
    const end = Math.min(bytes.length, offset + limit);
    return { ...entry.descriptor, encoding: "base64" as const, offset, totalBytes: bytes.length,
      data: bytes.subarray(offset, end).toString("base64"), nextOffset: end < bytes.length ? end : null };
  }
  /** A blank line may choose the following mapped location; caller reports it. */
  generated(location: LiveSourceLocation) {
    const entry = this.#entries.find(e => e.descriptor.sourceId === location.sourceId);
    if (!entry || !Number.isSafeInteger(location.line) || location.line < 1 || !Number.isSafeInteger(location.column) || location.column < 1) throw bad();
    const candidates = this.#mappings.filter(m => m.source === entry.original && m.originalLine !== null && m.originalColumn !== null
      && (m.originalLine > location.line || m.originalLine === location.line && m.originalColumn >= location.column - 1))
      .sort((a, b) => a.originalLine! - b.originalLine! || a.originalColumn! - b.originalColumn! || a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn);
    const best = candidates[0];
    if (!best) throw bad();
    return { lineNumber: best.generatedLine - 1, columnNumber: best.generatedColumn,
      actual: { sourceId: location.sourceId, line: best.originalLine!, column: best.originalColumn! + 1 } };
  }
  original(lineNumber: number, columnNumber: number): LiveSourceLocation | null {
    if (!this.#map || !Number.isInteger(lineNumber) || lineNumber < 0 || !Number.isInteger(columnNumber) || columnNumber < 0) return null;
    const found = originalPositionFor(this.#map, { line: lineNumber + 1, column: columnNumber });
    const entry = this.#entries.find(e => e.original === found.source);
    return entry && found.line !== null && found.column !== null ? { sourceId: entry.descriptor.sourceId, line: found.line, column: found.column + 1 } : null;
  }
}
