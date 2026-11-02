import { describe, expect, it } from "vitest";
import { createHeadlessFixedReader } from "../../local/src/headlessFixedReader.ts";

const page = (reader: ReturnType<typeof createHeadlessFixedReader>, root: unknown, path: string[] = [], offset = 0, limit = 100, secrets: string[] = []) =>
  JSON.parse(reader.reader(root, path, offset, limit, secrets));
const items = (value: any): any[] => Object.values(value.items ?? {});

describe("production fixed variable reader", () => {
  it("returns own nonrecursive data pages with exact private object selectors", () => {
    const reader = createHeadlessFixedReader(), input = { value: 10, nested: { result: 11 }, list: [1, 2] };
    const result = page(reader, { input });
    expect(items(result)).toEqual([{ name: "input", key: "input", value: { kind: "object", type: "object" } }]);
    expect(items(page(reader, { input }, ["input"]))).toEqual([
      { name: "value", value: { kind: "scalar", type: "number", value: 10 } },
      { name: "nested", key: "nested", value: { kind: "object", type: "object" } },
      { name: "list", key: "list", value: { kind: "object", type: "array" } },
    ]);
    expect(items(page(reader, { input }, ["input", "list"], 1, 1))[0]).toMatchObject({ name: "1", value: { value: 2 } });
  });
  it("redacts forbidden sibling and nested aliases before selection or pagination", () => {
    const reader = createHeadlessFixedReader(), shared = { value: "hidden" };
    const root = { aliases: { ordinary: shared, nested: { alias: shared } }, password: shared };
    expect(items(page(reader, root, [], 0, 1))[0].value.kind).toBe("object");
    expect(items(page(reader, root, ["aliases"], 0, 1))[0].value.kind).toBe("redacted");
    expect(items(page(reader, root, ["aliases", "nested"] ))[0].value.kind).toBe("redacted");
    expect(page(reader, root, ["aliases", "ordinary"]).kind).toBe("redacted");
    expect(page(reader, root, ["aliases", "nested", "alias"]).kind).toBe("redacted");
  });
  it("blocks host objects under ordinary aliases and matches known secrets before clipping", () => {
    const reader = createHeadlessFixedReader(), context = { unsafe: true };
    reader.block(context);
    const result = page(reader, { ordinary: context, env: process.env, long: "x".repeat(5000) + "known-value", normal: "fine" }, [], 0, 100, ["known-value"]);
    expect(items(result).map(item => item.value.kind)).toEqual(["redacted", "redacted", "redacted", "scalar"]);
    expect(page(reader, { ordinary: context }, ["ordinary"]).kind).toBe("redacted");
  });
  it("excludes nested framework graphs without following accessors or proxies", () => {
    let effects = 0;
    const reader = createHeadlessFixedReader(), nested = { authority: true };
    const framework: any = { nested, get getter() { effects++; return {}; }, proxy: new Proxy({}, { ownKeys() { effects++; return []; } }) };
    framework.self = framework;
    reader.blockGraph(framework);
    expect(items(page(reader, { ordinary: nested }))[0].value.kind).toBe("redacted");
    expect(page(reader, { ordinary: nested }, ["ordinary"]).kind).toBe("redacted");
    expect(effects).toBe(0);
  });
  it("does not invoke getters, Error hooks, proxies or conversion hooks", () => {
    let effects = 0;
    const reader = createHeadlessFixedReader();
    const value = { get unbound() { effects++; return 1; }, toJSON() { effects++; return {}; } };
    Object.defineProperty(value, "bound", { get: function () { effects++; return 2; }.bind(null) });
    const error = new Error("original");
    Object.defineProperty(error, "message", { get: function () { effects++; return "unsafe"; }.bind(null) });
    const proxy = new Proxy({}, { ownKeys() { effects++; return []; }, getPrototypeOf() { effects++; return null; } });
    const root = { value, error, proxy };
    expect(items(page(reader, root, ["value"])).map(item => item.value.kind)).toEqual(["accessor", "opaque", "accessor"]);
    expect(page(reader, root, ["error", "stack"])).toMatchObject({ kind: "opaque", type: "native-error" });
    expect(page(reader, root, ["proxy"])).toMatchObject({ kind: "opaque", type: "proxy" });
    expect(effects).toBe(0);
  });
  it("clips scalar UTF8 without splitting characters and never truncates a lookup identity", () => {
    const reader = createHeadlessFixedReader(), exact = "界".repeat(300), tooLong = "界".repeat(1500);
    const root = { [exact + "a"]: { value: 1 }, [exact + "b"]: { value: 2 }, [tooLong]: { value: 3 }, text: "🙂".repeat(2000) };
    const values = items(page(reader, root));
    expect(values[0].key).toBe(exact + "a"); expect(values[1].key).toBe(exact + "b");
    expect(values[2]).toMatchObject({ value: { kind: "unavailable", type: "property-name" } }); expect(values[2].key).toBeUndefined();
    expect(Buffer.byteLength(values[3].value.value, "utf8")).toBe(4096);
    expect(values[3].value.value).toBe("🙂".repeat(1024)); expect(values[3].value.truncated).toBe(true);
    expect(items(page(reader, root, [exact + "b"]))[0].value.value).toBe(2);
  });
  it("labels symbol properties and unsupported values without materializing them", () => {
    const reader = createHeadlessFixedReader(), symbol = Symbol("secret-description");
    const values = items(page(reader, { ordinary: Symbol("secret-description"), [symbol]: { unsafe: true }, date: new Date(), big: 10n ** 5000n }));
    expect(values.find(item => item.value.type === "symbol-property")).toMatchObject({ name: "[symbol property 3]", value: { kind: "opaque" } });
    expect(values.find(item => item.value.type === "symbol-property").key).toBeUndefined();
    expect(values.find(item => item.name === "date").value.type).toBe("unsupported-object");
    expect(values.find(item => item.name === "big").value).toMatchObject({ kind: "unavailable", type: "bigint" });
  });
  it("bounds key count, reply bytes, secrets and selectors without accepting code", () => {
    const reader = createHeadlessFixedReader();
    const many = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [String(index), index]));
    expect(page(reader, many)).toMatchObject({ kind: "unavailable", type: "key-limit" });
    const large = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ["key" + index, "\u0000".repeat(4096)]));
    const raw = reader.reader(large, [], 0, 100, []), result = JSON.parse(raw);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(131_072); expect(result.count).toBeGreaterThan(0); expect(result.count).toBeLessThan(100);
    expect(result.nextOffset).toBe(result.count);
    expect(page(reader, {}, ["x;throw Error('execute')"]).kind).toBe("unavailable");
    expect(page(reader, {}, Array(33).fill("x")).kind).toBe("unavailable");
    expect(page(reader, {}, [], 0, 1, Array(513).fill("x")).kind).toBe("unavailable");
    expect(JSON.parse(reader.reader({}, {} as any, 0, 1, [])).kind).toBe("unavailable");
    let effects = 0;
    const accessorPath = [] as string[];
    Object.defineProperty(accessorPath, "0", { get() { effects++; return "key"; } });
    expect(page(reader, {}, accessorPath).kind).toBe("unavailable");
    expect(page(reader, {}, new Proxy([], { get() { effects++; return 1; } })).kind).toBe("unavailable");
    expect(effects).toBe(0);
  });
  it("captures only the trusted gate's own nonproxy data function", () => {
    const reader = createHeadlessFixedReader(), workflowExecute = () => 1;
    expect(reader.entry({ workflowExecute })).toBe(workflowExecute);
    expect(reader.entry({ workflowExecute: new Proxy(workflowExecute, {}) })).toBeUndefined();
    expect(reader.entry({ get workflowExecute() { throw new Error("never"); } })).toBeUndefined();
    expect(reader.entry(Object.create({ workflowExecute }))).toBeUndefined();
  });
});
