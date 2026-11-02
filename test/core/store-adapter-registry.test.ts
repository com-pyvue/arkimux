import { describe, expect, it } from "vitest";
import {
  DefaultStoreAdapterRegistry,
  DuplicateStoreAdapterError,
  StoreAdapterRoleMismatchError,
  UnknownStoreAdapterError,
  type StoreAdapterFactory,
} from "../../core/src/index.ts";

type FixtureRole = "journal" | "cache";

interface FixtureContext {
  namespace: string;
  options: Record<string, unknown>;
}

interface JournalStore {
  append(value: string): string;
}

interface CacheStore {
  get(key: string): string | undefined;
}

interface FixtureStoreByRole {
  journal: JournalStore;
  cache: CacheStore;
}

const journalFactory: StoreAdapterFactory<"journal", JournalStore, FixtureContext> = {
  adapterId: "memory-journal@1",
  role: "journal",
  validateConfig(options) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("Journal options must be an object.");
    }
    return structuredClone(options as Record<string, unknown>);
  },
  async create(context) {
    return { append: (value) => `${context.namespace}:${value}` };
  },
  async preflight() {
    return { adapterId: this.adapterId, role: this.role, available: true };
  },
};

const cacheFactory: StoreAdapterFactory<"cache", CacheStore, FixtureContext> = {
  adapterId: "memory-cache@1",
  role: "cache",
  validateConfig() {
    return {};
  },
  async create() {
    return { get: (key) => key === "known" ? "value" : undefined };
  },
  async preflight() {
    return { adapterId: this.adapterId, role: this.role, available: true };
  },
};

function registry(factories = [journalFactory, cacheFactory]) {
  return new DefaultStoreAdapterRegistry<FixtureRole, FixtureStoreByRole, FixtureContext>({
    roles: ["journal", "cache"],
    factories,
  });
}

describe("generic store adapter registry", () => {
  it("resolves workflow-owned roles to their exact typed stores", async () => {
    const stores = registry();
    const journal = await stores.resolve("journal", "memory-journal@1").create({
      namespace: "run-01",
      options: {},
    });
    const cache = await stores.resolve("cache", "memory-cache@1").create({
      namespace: "run-01",
      options: {},
    });

    expect(journal.append("event")).toBe("run-01:event");
    expect(cache.get("known")).toBe("value");
    await expect(stores.resolve("journal", "memory-journal@1").preflight(journal))
      .resolves.toEqual({
        adapterId: "memory-journal@1",
        role: "journal",
        available: true,
      });
  });

  it("rejects missing adapters and role mismatches", () => {
    const stores = registry();
    expect(() => stores.resolve("journal", "missing@1"))
      .toThrow(UnknownStoreAdapterError);
    expect(() => stores.resolve("cache", "memory-journal@1"))
      .toThrow(StoreAdapterRoleMismatchError);
  });

  it("rejects duplicate, unversioned, and unsupported registrations", () => {
    expect(() => registry([journalFactory, journalFactory]))
      .toThrow(DuplicateStoreAdapterError);
    expect(() => registry([{ ...journalFactory, adapterId: "memory-journal" }]))
      .toThrow("exact positive numeric version");
    expect(() => new DefaultStoreAdapterRegistry({
      roles: ["journal", "cache"] as const,
      factories: [{ ...journalFactory, role: "archive" as "journal" }],
    })).toThrow("has an unsupported role: archive");
  });

  it("rejects ambiguous role descriptors", () => {
    expect(() => new DefaultStoreAdapterRegistry({
      roles: ["journal", "journal"],
    })).toThrow("Store role is duplicated: journal.");
    expect(() => new DefaultStoreAdapterRegistry({
      roles: [""],
    })).toThrow("Store role must not be empty.");
  });
});
