/** Validation prototype only. Import before loading any project code.
 * No production debugger imports this module and no caller code is accepted. */
import { types } from "node:util";

export function createFixedInspectorReader(probe = null) {
  const apply = Reflect.apply;
  const descriptors = Object.getOwnPropertyDescriptors;
  const descriptor = Object.getOwnPropertyDescriptor;
  const names = Object.getOwnPropertyNames;
  const create = Object.create;
  const getPrototype = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const isArray = Array.isArray;
  const setPrototype = Object.setPrototypeOf;
  const stringify = JSON.stringify;
  const isProxy = types.isProxy;
  const isNativeError = types.isNativeError;
  const slice = String.prototype.slice;
  const numberFinite = Number.isFinite;
  const numberNaN = Number.isNaN;
  const numberSame = Object.is;
  const safeInteger = Number.isSafeInteger;
  const bigIntText = BigInt.prototype.toString;
  const CapturedWeakSet = WeakSet;
  const weakHas = WeakSet.prototype.has;
  const weakAdd = WeakSet.prototype.add;

  // The receiver and target are debugger-owned handles. Path/options are data,
  // not JavaScript. Output is a primitive JSON string, never a project object.
  return function arkimuxFixedInspectorReader(target, path, offset, limit) {
    // Fixed validation probes selected by the test bootstrap, never an agent.
    if (probe === "constant") return '"constant"';
    if (probe === "is-proxy") return stringify(isProxy(target));
    if (probe === "is-error") return stringify(isNativeError(target));
    if (probe === "descriptors") return stringify(names(descriptors(target)).length);
    if (probe === "null-array") return stringify(setPrototype([], null));
    if (probe === "weak-set") { const set = new CapturedWeakSet(); apply(weakAdd, set, [target]); return stringify(apply(weakHas, set, [target])); }
    const record = () => create(null);
    const outcome = record();
    const visited = record(); let visitedCount = 0;
    let nodes = 0;
    const clipped = value => apply(slice, value, [0, 4096]);
    const opaque = kind => { const out = record(); out.kind = kind; return out; };
    const proxy = value => (typeof value === "object" && value !== null || typeof value === "function") && isProxy(value);
    const ordinary = input => isArray(input) || getPrototype(input) === objectPrototype || getPrototype(input) === null;
    function value(input, depth) {
      if (++nodes > 200 || depth > 4) return opaque("truncated");
      if (input === null) return opaque("null");
      const type = typeof input;
      if (type === "undefined") return opaque("undefined");
      if (type === "function") return opaque("function");
      if (type === "symbol") return opaque("symbol");
      if (type === "bigint") { const out = opaque("bigint"); out.text = apply(bigIntText, input, []); return out; }
      if (type === "string") { const out = opaque("string"); out.value = clipped(input); out.truncated = input.length > 4096; return out; }
      if (type === "boolean") { const out = opaque(type); out.value = input; return out; }
      if (type === "number") {
        const out = opaque(type);
        if (numberFinite(input) && !numberSame(input, -0)) out.value = input;
        else out.special = numberNaN(input) ? "NaN" : numberSame(input, -0) ? "-0" : input > 0 ? "Infinity" : "-Infinity";
        return out;
      }
      if (proxy(input)) return opaque("proxy");
      if (isNativeError(input)) return opaque("native-error");
      if (!ordinary(input)) return opaque("unsupported-object");
      for (let index = 0; index < visitedCount; index++) if (visited[index] === input) return opaque("cycle");
      visited[visitedCount++] = input;
      const out = opaque("object"); out.items = record(); out.itemCount = 0;
      const keys = names(input);
      out.total = keys.length;
      const start = depth === 0 ? offset : 0, count = depth === 0 ? limit : 20;
      for (let index = start; index < keys.length && index < start + count; index++) {
        const key = keys[index], item = record(); item.name = clipped(key);
        // An uninitialized binding can throw when a synthetic scope exposes
        // its descriptor. Preserve other bindings without guessing the cause.
        try {
          const details = descriptor(input, key);
          if (!details) item.value = opaque("unavailable");
          else if (descriptor(details, "get") || descriptor(details, "set")) item.value = opaque("accessor");
          else {
            const data = descriptor(details, "value");
            item.value = data ? value(data.value, depth + 1) : opaque("unavailable");
          }
        } catch { item.value = opaque("unavailable"); }
        out.items[out.itemCount++] = item;
      }
      out.nextOffset = start + count < keys.length ? start + count : null;
      return out;
    }
    try {
      if (!isArray(path) || path.length > 8 || !safeInteger(offset) || offset < 0 || !safeInteger(limit) || limit < 1 || limit > 100) {
        outcome.kind = "invalid-request";
      } else {
        for (let index = 0; index < path.length; index++) if (typeof path[index] !== "string") {
          outcome.kind = "invalid-request"; return stringify(outcome);
        }
        let selected = target;
        for (let index = 0; index < path.length; index++) {
          if (proxy(selected)) { outcome.kind = "proxy"; return stringify(outcome); }
          if (typeof selected === "function") { outcome.kind = "function"; return stringify(outcome); }
          if (selected !== null && typeof selected === "object" && isNativeError(selected)) { outcome.kind = "native-error"; return stringify(outcome); }
          if (selected !== null && typeof selected === "object" && !ordinary(selected)) { outcome.kind = "unsupported-object"; return stringify(outcome); }
          if (typeof path[index] !== "string" || selected === null || typeof selected !== "object") {
            outcome.kind = "unavailable"; return stringify(outcome);
          }
          const own = descriptor(selected, path[index]);
          if (!own) { outcome.kind = "unavailable"; return stringify(outcome); }
          if (descriptor(own, "get") || descriptor(own, "set")) { outcome.kind = "accessor"; return stringify(outcome); }
          selected = own.value;
        }
        outcome.kind = "snapshot"; outcome.value = value(selected, 0);
      }
    } catch { outcome.kind = "unavailable"; }
    return stringify(outcome);
  };
}
