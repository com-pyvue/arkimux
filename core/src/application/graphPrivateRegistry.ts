/**
 * Retained workflow code and the execution host can contain separate bundled
 * copies of the SDK. They still run in one worker realm, so graph helper state
 * must be shared across those copies without becoming part of the public wire
 * contract.
 */
export function graphPrivateWeakMap<T>(name: string): WeakMap<object, T> {
  const key = Symbol.for(`com.pyvue.arkimux.graph.${name}.v1`);
  const scope = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = scope[key];
  if (existing instanceof WeakMap) return existing as WeakMap<object, T>;
  const created = new WeakMap<object, T>();
  Object.defineProperty(scope, key, { value: created, configurable: false, enumerable: false, writable: false });
  return created;
}

export function graphPrivateWeakSet(name: string): WeakSet<object> {
  const key = Symbol.for(`com.pyvue.arkimux.graph.${name}.v1`);
  const scope = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = scope[key];
  if (existing instanceof WeakSet) return existing as WeakSet<object>;
  const created = new WeakSet<object>();
  Object.defineProperty(scope, key, { value: created, configurable: false, enumerable: false, writable: false });
  return created;
}
