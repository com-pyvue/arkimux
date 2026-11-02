import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTelemetryTransport, type SenderConfig } from "../../local/src/localTelemetryTransport.ts";

const config: SenderConfig = {
  schemaVersion: 1, baseUrl: "https://collector.example/", userPoolId: "eu-west-1_fixture", clientId: "fixtureclient",
  privacy: { noticeVersion: "fixture", usageRetentionDays: 90, queryRetentionDays: 7, logRetentionDays: 7,
    deletionDescription: "Fixture only." }, maxBatchEvents: 25, maxBodyBytes: 32768,
};
const signal = () => new AbortController().signal;
const rejected = (kind = "NotAuthorizedException") => Response.json({ __type: kind }, { status: 400 });

describe("installation credential refresh", () => {
  it.each(["NotAuthorizedException", "com.amazonaws.cognitoidentityprovider#NotAuthorizedException"])
    ("renews an expired refresh token using the same installation secret (%s)", async kind => {
      const registrationId = randomUUID();
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(rejected(kind))
        .mockResolvedValueOnce(Response.json({ AuthenticationResult: {
          AccessToken: "new-access", ExpiresIn: 300, RefreshToken: "new-refresh",
        } }));
      const result = await createTelemetryTransport(config, fetcher).authenticate(registrationId,
        { secret: "saved-secret", refreshToken: "expired-refresh" }, signal());
      expect(result).toEqual({ accessToken: "new-access", expiresIn: 300, refreshToken: "new-refresh" });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
        { ClientId: config.clientId, AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: "expired-refresh" } },
        { ClientId: config.clientId, AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: `installation-${registrationId}`, PASSWORD: "Local1!saved-secret" } },
      ]);
      expect(fetcher.mock.calls.every(([url]) => url === "https://cognito-idp.eu-west-1.amazonaws.com/")).toBe(true);
    });

  it("still rejects a disabled account or invalid secret after one password attempt", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => rejected());
    await expect(createTelemetryTransport(config, fetcher).authenticate(randomUUID(),
      { secret: "invalid", refreshToken: "expired" }, signal())).rejects.toMatchObject({ kind: "rejected" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected password when there was no refresh token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected());
    await expect(createTelemetryTransport(config, fetcher).authenticate(randomUUID(),
      { secret: "invalid" }, signal())).rejects.toMatchObject({ kind: "rejected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([["TooManyRequestsException", "retry"], ["InternalErrorException", "retry"], ["UserNotFoundException", "rejected"]])
    ("does not switch auth flows for %s", async (kind, expected) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected(kind));
      await expect(createTelemetryTransport(config, fetcher).authenticate(randomUUID(),
        { secret: "saved-secret", refreshToken: "saved-refresh" }, signal())).rejects.toMatchObject({ kind: expected });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
