import { describe, expect, it } from "vitest";
import { defineEffectAdapter, defineEffectContract } from "../../core/src/application/durableWorkflow.ts";
import { assertRetainedEffectAdapterMatches, assertRetainedEffectOutputSafe, prepareRetainedEffectAdapters, retainedEffectSecretValues,
  sanitizeRetainedEffectDiagnostic } from "../../local/src/retainedEffectAdapters.ts";

const factoryCode = `
  const json = { parse(value) { return value; } };
  export function adapter(context) {
    if (Object.hasOwn(context, "readAsset")) throw new Error("Adapter received workflow construction authority.");
    return {
      schemaVersion: 1,
      operationId: "fixture.read",
      definitionVersion: "1",
      safety: "read",
      input: json,
      output: json,
      async execute(_execution, input) {
        return {
          configured: context.environment.ENDPOINT === "https://provider.invalid",
          authorized: input.candidate === context.credentials.API_KEY,
          configurationId: context.runConfiguration.configurationId,
        };
      },
    };
  }
`;

describe("retained host effect adapters", () => {
  it("does not let an adapter implementation override its checked contract", () => {
    const json = { parse: (value: unknown) => value as null };
    const contract = defineEffectContract({ schemaVersion: 1, operationId: "fixture.read", definitionVersion: "1",
      safety: "read", input: json, output: json });
    const adapter = defineEffectAdapter(contract, { execute: async () => null,
      operationId: "forged.write", safety: "unsafe-write" } as never);
    expect(adapter).toMatchObject({ operationId: "fixture.read", definitionVersion: "1", safety: "read" });
  });

  it("constructs adapters with host-only environment, credentials and Run Configuration", async () => {
    const adapters = await prepareRetainedEffectAdapters({ code: factoryCode,
      descriptor: { schemaVersion: 2, export: "construct", effectAdapterEntryPoint: "effect-adapters.mjs", effectAdapters: ["adapter"] },
      environment: { ENDPOINT: "https://provider.invalid" }, credentials: { API_KEY: "private-fixture-key" },
      runConfiguration: { configurationId: "config-v1" } });
    const adapter = adapters["fixture.read"]!;
    await expect(adapter.execute({ stableOperationId: "step:fixture.read", deadlineAt: "2030-01-01T00:00:00.000Z",
      cancellation: { aborted: false } }, { candidate: "private-fixture-key" })).resolves.toEqual({
      configured: true, authorized: true, configurationId: "config-v1",
    });
  });

  it("does not instantiate adapters for a legacy build without declared factories", async () => {
    const adapters = await prepareRetainedEffectAdapters({ code: "throw new Error('must not import')",
      descriptor: { schemaVersion: 1, export: "construct" }, environment: {}, credentials: {}, runConfiguration: null });
    expect(adapters).toEqual({});
  });

  it("rejects duplicate operation IDs from distinct retained factories", async () => {
    await expect(prepareRetainedEffectAdapters({ code: `${factoryCode}\nexport const duplicate = adapter;`,
      descriptor: { schemaVersion: 2, export: "construct", effectAdapterEntryPoint: "effect-adapters.mjs", effectAdapters: ["adapter", "duplicate"] },
      environment: {}, credentials: {}, runConfiguration: null })).rejects.toThrow("Duplicate retained effect adapter");
  });

  it("rejects host adapters whose retained contract differs from the worker request", async () => {
    const adapters = await prepareRetainedEffectAdapters({ code: factoryCode,
      descriptor: { schemaVersion: 2, export: "construct", effectAdapterEntryPoint: "effect-adapters.mjs", effectAdapters: ["adapter"] },
      environment: {}, credentials: {}, runConfiguration: null });
    const adapter = adapters["fixture.read"]!;
    expect(() => assertRetainedEffectAdapterMatches(adapter,
      { operationId: "fixture.read", definitionVersion: "2", safety: "read" })).toThrow("contract differs");
    expect(() => assertRetainedEffectAdapterMatches(adapter,
      { operationId: "fixture.read", definitionVersion: "1", safety: "unsafe-write" })).toThrow("contract differs");
  });

  it("rejects raw credential output and redacts known secrets from provider diagnostics", () => {
    const secrets = retainedEffectSecretValues({ PUBLIC_URL: "https://example.invalid", PROVIDER_TOKEN: "env-token" },
      { api: "credential-token", escaped: "quoted\"secret", encoded: "token with spaces" });
    expect(() => assertRetainedEffectOutputSafe({ value: "credential-token" }, secrets)).toThrow("host-owned secret");
    expect(() => assertRetainedEffectOutputSafe({ value: "quoted\"secret" }, secrets)).toThrow("host-owned secret");
    expect(() => assertRetainedEffectOutputSafe({ value: "token%20with%20spaces" }, secrets)).toThrow("host-owned secret");
    expect(sanitizeRetainedEffectDiagnostic({ origin: "external", provider: "fixture",
      code: "bad_credential-token", message: "credential-token and env-token failed" }, secrets)).toEqual({
      origin: "external", provider: "fixture", code: "bad_[redacted]", message: "[redacted] and [redacted] failed",
    });
  });
});
