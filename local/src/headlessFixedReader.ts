import { types } from "node:util";

/** Internal selectors. They never come directly from a protocol request. */
export type HeadlessReaderPath = readonly string[];
export interface HeadlessFixedReader {
  reader(target: unknown, path: HeadlessReaderPath, offset: number, limit: number, knownSecrets: readonly string[]): string;
  /** Called only at the verified, ArkiMux-owned execute-entry gate. */
  entry(scope: unknown): Function | undefined;
  /** Host setup only, outside an inspector read. Never expose this to clients. */
  block(value: unknown): void;
  /** Register only framework/control graphs, never workflow input/result graphs. */
  blockGraph(value: unknown): void;
}

/**
 * Capture before loading project code. The only inspector-facing result from
 * reader() is primitive JSON, never a workflow value for V8 to describe.
 *
 * The owner must bound each inspector call and kill its worker on a read timeout:
 * even own-key enumeration can allocate inside V8 before its size is observable.
 */
export function createHeadlessFixedReader(): HeadlessFixedReader {
  const apply = Reflect.apply;
  const ownKeys = Reflect.ownKeys;
  const descriptor = Object.getOwnPropertyDescriptor;
  const create = Object.create;
  const getPrototype = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const referenceErrorPrototype = ReferenceError.prototype;
  const isArray = Array.isArray;
  const stringify = JSON.stringify;
  const isProxy = types.isProxy;
  const isNativeError = types.isNativeError;
  const slice = String.prototype.slice;
  const charCodeAt = String.prototype.charCodeAt;
  const includes = String.prototype.includes;
  const indexOf = String.prototype.indexOf;
  const numberFinite = Number.isFinite;
  const numberNaN = Number.isNaN;
  const numberSame = Object.is;
  const safeInteger = Number.isSafeInteger;
  const bigIntText = BigInt.prototype.toString;
  // Decimal text plus a possible sign and trailing n always fits 4096 bytes.
  const bigintBound = 10n ** 4093n;
  const maxKeys = 10_000, maxPath = 32, maxStringUnits = 1_048_576;
  const maxReplyBytes = 131_072, maxPreviewBytes = 4096;
  type Bag = Record<string | number, any>;
  const record = (): Bag => create(null);
  const blocked = record(); let blockedCount = 0;
  let blockedOverflow = false;
  const block = (value: unknown): void => {
    if (value === null || typeof value !== "object" && typeof value !== "function") return;
    for (let index = 0; index < blockedCount; index++) if (blocked[index] === value) return;
    if (blockedCount >= maxKeys) { blockedOverflow = true; return; }
    blocked[blockedCount++] = value;
  };
  block(globalThis); block(process); block(process.env);
  const deniedParts = ["apikey", "api-key", "api_key", "password", "secret", "token", "credential", "authorization", "cookie", "privatekey", "private-key", "private_key"];
  const deniedExact = ["process", "globalthis", "global", "context", "host", "owner", "store", "runtime"];
  const marker = (kind: string, type?: string): Bag => {
    const value = record(); value.kind = kind; if (type) value.type = type; return value;
  };
  const isBlocked = (value: unknown): boolean => {
    for (let index = 0; index < blockedCount; index++) if (blocked[index] === value) return true;
    return false;
  };
  const objectLike = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function");
  const ordinary = (value: object): boolean => isArray(value) || getPrototype(value) === objectPrototype || getPrototype(value) === null;
  const blockGraph = (value: unknown): void => {
    const queue = record(); queue[0] = value;
    let next = 0, count = 1, keyCount = 0;
    try {
      while (next < count) {
        const current: unknown = queue[next++];
        if (!objectLike(current) || next > 1 && isBlocked(current)) continue;
        block(current);
        if (blockedOverflow) return;
        // Functions are terminal. Never traverse proxies, Error stack fields,
        // custom class instances, or user accessors to discover another object.
        if (typeof current === "function" || isProxy(current) || isNativeError(current) || !ordinary(current)) continue;
        const keys = ownKeys(current); keyCount += keys.length;
        if (keyCount > maxKeys) { blockedOverflow = true; return; }
        for (let index = 0; index < keys.length; index++) {
          const own = descriptor(current, keys[index]);
          const data = own && descriptor(own, "value");
          if (!data || !objectLike(data.value) || isBlocked(data.value)) continue;
          if (count >= maxKeys) { blockedOverflow = true; return; }
          queue[count++] = data.value;
        }
      }
    } catch { blockedOverflow = true; }
  };
  const codeAt = (text: string, index: number): number => apply(charCodeAt, text, [index]);
  /** Counts code points directly: no user encoder, iterator or conversion hook. */
  const clip = (text: string, bound = maxPreviewBytes): { text: string; bytes: number; truncated: boolean } => {
    let end = 0, bytes = 0;
    while (end < text.length) {
      const code = codeAt(text, end);
      let units = 1, width = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (code >= 0xd800 && code <= 0xdbff && end + 1 < text.length) {
        const next = codeAt(text, end + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { units = 2; width = 4; }
      }
      if (bytes + width > bound) break;
      bytes += width; end += units;
    }
    const result = record(); result.text = apply(slice, text, [0, end]); result.bytes = bytes; result.truncated = end < text.length;
    return result as { text: string; bytes: number; truncated: boolean };
  };
  // Node's side-effect guard rejects String.toLowerCase. These patterns are
  // fixed ASCII, so compare folded character codes without allocating a string.
  const asciiIndex = (text: string, word: string, from = 0): number => {
    for (let start = from; start <= text.length - word.length; start++) {
      let offset = 0;
      for (; offset < word.length; offset++) {
        const code = codeAt(text, start + offset), lower = code >= 65 && code <= 90 ? code + 32 : code;
        if (lower !== codeAt(word, offset)) break;
      }
      if (offset === word.length) return start;
    }
    return -1;
  };
  const denied = (name: string): boolean => {
    for (let index = 0; index < deniedParts.length; index++) if (asciiIndex(name, deniedParts[index]) >= 0) return true;
    for (let index = 0; index < deniedExact.length; index++) if (name.length === deniedExact[index].length && asciiIndex(name, deniedExact[index]) === 0) return true;
    return false;
  };
  const credentialCharacter = (code: number): boolean => code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 45 || code === 95;
  const sensitive = (text: string, secrets: Bag): boolean => {
    for (let index = 0; index < secrets.length; index++) if (secrets[index] && apply(includes, text, [secrets[index]])) return true;
    for (let from = 0; from < text.length;) {
      const start: number = apply(indexOf, text, ["sk-", from]);
      if (start < 0) break;
      let end = start + 3;
      while (end < text.length && end - start < 13 && credentialCharacter(codeAt(text, end))) end++;
      if (end - start >= 13) return true;
      from = start + 3;
    }
    for (let from = 0; from < text.length;) {
      const start = asciiIndex(text, "bearer ", from);
      if (start < 0) break;
      let end = start + 7;
      while (end < text.length && end - start < 17 && (credentialCharacter(codeAt(text, end)) || codeAt(text, end) === 46)) end++;
      if (end - start >= 17) return true;
      from = start + 7;
    }
    return false;
  };
  const fixedEntry = (scope: unknown): Function | undefined => {
    try {
      if (!objectLike(scope) || isProxy(scope)) return undefined;
      const own = descriptor(scope, "workflowExecute");
      if (!own) return undefined;
      const data = descriptor(own, "value");
      return data && typeof data.value === "function" && !isProxy(data.value) ? data.value : undefined;
    } catch { return undefined; }
  };
  const reader = (target: unknown, path: HeadlessReaderPath, offset: number, limit: number, knownSecrets: readonly string[]): string => {
    // Do not add evaluation, caller function/code options, or a block operation.
    // These parameters are controller-owned primitive JSON data only.
    const failure = (reason: string): string => { const out = marker("unavailable"); out.reason = reason; return stringify(out); };
    if (blockedOverflow) return failure("Excluded object limit reached.");
    if (!isArray(path) || isProxy(path) || path.length > maxPath || !safeInteger(offset) || offset < 0 || !safeInteger(limit) || limit < 1 || limit > 100
      || !isArray(knownSecrets) || isProxy(knownSecrets) || knownSecrets.length > 512) return failure("Invalid reader options.");
    const safePath = record(), safeSecrets = record(); safeSecrets.length = knownSecrets.length;
    for (let index = 0; index < path.length; index++) {
      const own = descriptor(path, index), data = own && descriptor(own, "value");
      if (!data || typeof data.value !== "string" || data.value.length > maxPreviewBytes || clip(data.value).truncated) return failure("Unsupported property selector.");
      safePath[index] = data.value;
    }
    for (let index = 0; index < knownSecrets.length; index++) {
      const own = descriptor(knownSecrets, index), data = own && descriptor(own, "value");
      if (!data || typeof data.value !== "string" || data.value.length > 65_536) return failure("Invalid secret filter.");
      safeSecrets[index] = data.value;
    }
    // Rebuilt from the full owned root path on every read, not just the last
    // object. A nested alias must not evade a denying name in an outer scope.
    const inheritedAliases = record(); inheritedAliases.count = 0;
    const isAlias = (input: unknown, aliases: Bag): boolean => {
      for (let index = 0; index < aliases.count; index++) if (aliases[index] === input) return true;
      return false;
    };
    const shape = (input: unknown): Bag | null => {
      if (isBlocked(input)) return marker("redacted");
      if (typeof input === "function") return marker("opaque", "function");
      if (!objectLike(input)) return marker("unavailable");
      if (isProxy(input)) return marker("opaque", "proxy");
      if (isNativeError(input)) return marker("opaque", "native-error");
      if (!ordinary(input)) return marker("opaque", "unsupported-object");
      return null;
    };
    const scalar = (input: unknown, aliases: Bag): Bag => {
      if (isBlocked(input) || isAlias(input, aliases)) return marker("redacted");
      if (input === undefined) return marker("undefined");
      if (input === null) { const out = marker("null"); out.value = null; return out; }
      if (typeof input === "string") {
        if (input.length > maxStringUnits) return marker("unavailable", "string");
        if (sensitive(input, safeSecrets)) return marker("redacted");
        const preview = clip(input), out = marker("scalar", "string"); out.value = preview.text; out.truncated = preview.truncated; return out;
      }
      if (typeof input === "boolean") { const out = marker("scalar", "boolean"); out.value = input; return out; }
      if (typeof input === "number") {
        const out = marker("scalar", "number");
        if (numberFinite(input) && !numberSame(input, -0)) out.value = input;
        else out.preview = numberNaN(input) ? "NaN" : numberSame(input, -0) ? "-0" : input > 0 ? "Infinity" : "-Infinity";
        return out;
      }
      if (typeof input === "bigint") {
        if (input <= -bigintBound || input >= bigintBound) return marker("unavailable", "bigint");
        const out = marker("scalar", "bigint"); out.preview = apply(bigIntText, input, []) + "n"; return out;
      }
      if (typeof input === "symbol") return marker("opaque", "symbol");
      const unsupported = shape(input); return unsupported ?? marker("object", isArray(input) ? "array" : "object");
    };
    const readDescriptor = (input: object, key: string, rootScope: boolean): { data?: PropertyDescriptor; error?: Bag } => {
      const result = record();
      try {
        const own = descriptor(input, key);
        if (!own) { result.error = marker("unavailable"); return result; }
        if (descriptor(own, "get") || descriptor(own, "set")) { result.error = marker("accessor"); return result; }
        const data = descriptor(own, "value");
        if (data) result.data = data; else result.error = marker("unavailable");
        return result;
      } catch (error) {
        // Only the actual inspector root scope gets this narrow TDZ distinction.
        // Never inspect error names, messages, stacks or conversion functions.
        const uninitialized = rootScope && objectLike(error) && !isProxy(error) && isNativeError(error) && getPrototype(error) === referenceErrorPrototype;
        result.error = marker(uninitialized ? "uninitialized" : "unavailable"); return result;
      }
    };
    const owner = (input: unknown, rootScope: boolean): { error?: Bag; keys?: (string | symbol)[]; aliases?: Bag } => {
      const result = record();
      const unsupported = shape(input); if (unsupported) { result.error = unsupported; return result; }
      const keys = ownKeys(input as object);
      if (keys.length > maxKeys) { result.error = marker("unavailable", "key-limit"); return result; }
      const aliases = inheritedAliases;
      // Scan before paging. A secret/control object cannot escape under an alias
      // just because the denying sibling is on a different page.
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]; if (typeof key !== "string") continue;
        if (key.length <= maxPreviewBytes && !clip(key).truncated && !denied(key) && !sensitive(key, safeSecrets)) continue;
        const own = readDescriptor(input as object, key, rootScope);
        if (own.data && (objectLike(own.data.value) || typeof own.data.value === "string" && own.data.value)) {
          if (aliases.count >= maxKeys) { result.error = marker("unavailable", "alias-limit"); return result; }
          aliases[aliases.count++] = own.data.value;
        }
      }
      result.keys = keys; result.aliases = aliases; return result;
    };
    try {
      let selected = target;
      for (let depth = 0; depth < path.length; depth++) {
        const current = owner(selected, depth === 0); if (current.error) return stringify(current.error);
        const key: string = safePath[depth];
        if (denied(key) || sensitive(key, safeSecrets)) return stringify(marker("redacted"));
        const own = readDescriptor(selected as object, key, depth === 0);
        if (own.error) return stringify(own.error);
        selected = own.data!.value;
        if (isBlocked(selected) || isAlias(selected, current.aliases!)) return stringify(marker("redacted"));
      }
      const current = owner(selected, path.length === 0); if (current.error) return stringify(current.error);
      const keys = current.keys!, out = marker("page"); out.items = record(); out.count = 0; out.total = keys.length;
      let bytes = 256, index = offset;
      for (; index < keys.length && out.count < limit; index++) {
        const key = keys[index], item = record();
        if (typeof key === "symbol") { item.name = "[symbol property " + index + "]"; item.value = marker("opaque", "symbol-property"); }
        else {
          const name = clip(key);
          if (name.truncated) { item.name = "[property name exceeds 4096 UTF-8 bytes]"; item.value = marker("unavailable", "property-name"); }
          else if (sensitive(key, safeSecrets)) { item.name = "[redacted property name]"; item.value = marker("redacted"); }
          else {
            item.name = key;
            if (denied(key)) item.value = marker("redacted");
            else {
              const own = readDescriptor(selected as object, key, path.length === 0);
              item.value = own.error ?? scalar(own.data!.value, current.aliases!);
              // A selector is exact, private data, never a truncated display label.
              if (item.value.kind === "object") item.key = key;
            }
          }
        }
        const itemBytes = clip(stringify(item), maxReplyBytes).bytes + 32;
        if (bytes + itemBytes > maxReplyBytes) break;
        bytes += itemBytes; out.items[out.count++] = item;
      }
      out.nextOffset = index < keys.length ? index : null;
      out.truncated = index < keys.length;
      return stringify(out);
    } catch { return failure("This value cannot be inspected safely."); }
  };
  const result = record(); result.reader = reader; result.entry = fixedEntry; result.block = block; result.blockGraph = blockGraph;
  return result as unknown as HeadlessFixedReader;
}
