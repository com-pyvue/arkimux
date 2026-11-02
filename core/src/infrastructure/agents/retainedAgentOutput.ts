import type { WriteStream } from "node:fs";
import type { AuthAvailability } from "../../application/agentProvider.ts";
import { credentialSecretValues } from "../../application/externalError.ts";

export function credentialValuesForRetention(environment: NodeJS.ProcessEnv, prepared: NodeJS.ProcessEnv, kind: AuthAvailability["kind"]): string[] {
  // Native session preparation also carries HOME, PATH, USER and config paths.
  // They are not credentials. Explicit key bindings may use arbitrary names.
  return [...credentialSecretValues(environment), ...(kind === "runtime-native" ? [] :
    Object.values(prepared).filter((value): value is string => typeof value === "string" && value.length > 0))];
}

/** Exact selected values only: ordinary provider text and JSON field names are
 * not heuristically classified as secrets. Raw protocol data may still be
 * parsed in memory, but only this filtered output is retained. */
export function createCredentialOutputRedactor(secretValues: readonly string[]) {
  const values = new Set<string>();
  for (const value of secretValues) {
    if (!value) continue;
    values.add(value);
    // A malformed UTF-16 value still has a raw/JSON representation to redact.
    try { values.add(encodeURIComponent(value)); } catch { /* no URI representation */ }
    let escaped = value;
    // Native JSON events can contain a JSON result string inside another string.
    for (let depth = 0; depth < 3; depth++) {
      escaped = JSON.stringify(escaped).slice(1, -1);
      values.add(escaped);
    }
  }
  const variants = [...values].sort((a, b) => b.length - a.length);
  function consume(text: string, final: boolean): [string, string] {
    if (!variants.length) return [text, ""];
    let output = "", offset = 0;
    while (offset < text.length) {
      const tail = text.slice(offset);
      // Keep a possible longer match until its next chunk arrives.
      if (!final && variants.some(value => value.length > tail.length && value.startsWith(tail))) break;
      const match = variants.find(value => text.startsWith(value, offset));
      if (match) { output += "[redacted]"; offset += match.length; }
      else { output += text[offset]; offset++; }
    }
    return [output, text.slice(offset)];
  }
  return {
    redact(text: string) { return consume(text, true)[0]; },
    stream() {
      let pending = "";
      return {
        push(chunk: string) { const [output, rest] = consume(pending + chunk, false); pending = rest; return output; },
        finish() { const output = consume(pending, true)[0]; pending = ""; return output; },
      };
    },
  };
}

export function createRetainedAgentOutput(events: WriteStream, stderr: WriteStream, secretValues: readonly string[]) {
  const redactor = createCredentialOutputRedactor(secretValues);
  const eventFilter = redactor.stream(), stderrFilter = redactor.stream();
  let stderrTail = "", lastStderrLine: string | undefined;
  const writeStderr = (text: string) => {
    stderr.write(text);
    stderrTail = (stderrTail + text).slice(-4096);
    lastStderrLine = stderrTail.split(/\r?\n/).filter(line => line.trim()).at(-1);
  };
  return {
    redact: redactor.redact,
    stdout(chunk: string) { events.write(eventFilter.push(chunk)); },
    stderr(chunk: string) { writeStderr(stderrFilter.push(chunk)); },
    get lastStderrLine() { return lastStderrLine; },
    finish() { events.write(eventFilter.finish()); writeStderr(stderrFilter.finish()); },
  };
}
