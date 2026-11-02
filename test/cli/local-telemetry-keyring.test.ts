import { beforeEach, expect, it, vi } from "vitest";
import { createOsTelemetrySecretStore } from "../../local/src/localTelemetryTransport.ts";

const keyring = vi.hoisted(() => ({ getPassword: vi.fn() }));
vi.mock("@napi-rs/keyring", () => ({ AsyncEntry: class { getPassword = keyring.getPassword; } }));
beforeEach(() => keyring.getPassword.mockReset());

it.each([null, undefined])("treats a missing keyring entry (%s) as no credential", async value => {
  keyring.getPassword.mockResolvedValue(value);
  expect(await createOsTelemetrySecretStore().get("synthetic-epoch")).toBeUndefined();
});
it("still validates a stored credential and rejects malformed values", async () => {
  const store = createOsTelemetrySecretStore();
  const credential = { secret: "a".repeat(43), refreshToken: "synthetic-refresh" };
  keyring.getPassword.mockResolvedValue(JSON.stringify(credential));
  expect(await store.get("synthetic-epoch")).toEqual(credential);
  keyring.getPassword.mockResolvedValue("null");
  await expect(store.get("synthetic-epoch")).rejects.toThrow();
});
