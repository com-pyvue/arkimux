/** Decorate a host-owned storage adapter without changing its contract. Capture
 * failures before an engine can turn them into a saved workflow outcome. */
export function observeFrameworkStorage<T extends object>(storage: T, report: (error: unknown) => void): T {
  const methods = new Map<PropertyKey, unknown>();
  const failed = (error: unknown): never => { try { report(error); } catch { /* Keep the original failure. */ } throw error; };
  return new Proxy(storage, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    if (!methods.has(key)) methods.set(key, (...args: unknown[]) => {
      try {
        const result = Reflect.apply(value, target, args);
        return result instanceof Promise ? result.catch(failed) : result;
      } catch (error) { return failed(error); }
    });
    return methods.get(key);
  } });
}
