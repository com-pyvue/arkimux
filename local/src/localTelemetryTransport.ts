import { z } from "zod";
import { registrationSchema, parseUsageBatch, installationId, deletionReceiptSchema, type DeletionReceipt, type UsageEvent } from "@com-pyvue/arkimux-telemetry-contracts";

export const senderConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baseUrl: z.string().url().refine(value => { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; }),
  userPoolId: z.string().regex(/^(?!cn-)[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/),
  clientId: z.string().regex(/^[a-z0-9]{1,128}$/),
  privacy: z.strictObject({ noticeVersion: z.string().regex(/^[a-z0-9-]{1,100}$/),
    usageRetentionDays: z.union([z.number().int().positive(), z.literal("indefinite")]),
    queryRetentionDays: z.number().int().positive(), logRetentionDays: z.number().int().positive(),
    deletionDescription: z.string().min(1).max(1000) }),
  maxBatchEvents: z.number().int().min(1).max(100),
  maxBodyBytes: z.number().int().min(1024).max(128 * 1024),
});
export type SenderConfig = z.infer<typeof senderConfigSchema>;
export interface InstallationCredential { secret: string; refreshToken?: string }
export interface SecretStore {
  get(key: string): Promise<InstallationCredential | undefined>;
  set(key: string, value: InstallationCredential): Promise<void>;
  delete(key: string): Promise<void>;
}
export class TelemetryTransportError extends Error {
  constructor(readonly kind: "retry" | "rejected" | "invalid" | "unauthorized", readonly retryAfterMs?: number) { super(kind); }
}
export interface TelemetryTransport {
  register(registrationId: string, secret: string, signal: AbortSignal): Promise<string>;
  authenticate(registrationId: string, credential: InstallationCredential, signal: AbortSignal): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }>;
  send(events: UsageEvent[], accessToken: string, signal: AbortSignal): Promise<void>;
  requestDeletion?(accessToken: string, signal: AbortSignal): Promise<DeletionReceipt>;
}

/** Only this adapter knows Cognito's public auth protocol. No AWS admin credentials. */
export function createTelemetryTransport(config: SenderConfig, fetcher: typeof fetch = fetch): TelemetryTransport {
  const base = config.baseUrl.replace(/\/?$/, "/");
  const region = config.userPoolId.split("_")[0];
  async function request(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal) {
    let response: Response;
    try { response = await fetcher(url, { method: "POST", redirect: "error", headers, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }); }
    catch { throw new TelemetryTransportError("retry"); }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      const raw = response.headers.get("retry-after");
      const delay = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - Date.now() : undefined;
      throw new TelemetryTransportError("retry", delay !== undefined && Number.isFinite(delay) ? Math.max(0, delay) : undefined);
    }
    let value: unknown;
    try {
      // Bound even a malformed endpoint response; never persist or log its text.
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) { try { while (true) { const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 32 * 1024) throw new Error("oversized"); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => undefined); } }
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      if (response.ok) throw new TelemetryTransportError("retry");
      value = {}; // Gateway auth/validation responses need not contain JSON.
    }
    return { response, value: value as Record<string, unknown> };
  }
  return {
    async requestDeletion(accessToken, signal) {
      const { response, value } = await request(`${base}v1/deletion`, { schema_version: 1, confirm: true },
        { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, signal);
      if (response.status === 401) throw new TelemetryTransportError("unauthorized");
      if (response.status === 403) throw new TelemetryTransportError("rejected");
      if (response.status !== 202) throw new TelemetryTransportError("retry");
      return deletionReceiptSchema.parse(value);
    },
    async register(registrationId, secret, signal) {
      const input = registrationSchema.parse({ schema_version: 1, registration_id: registrationId, secret });
      const { response, value } = await request(`${base}v1/installations`, input, { "content-type": "application/json" }, signal);
      if ([401, 403].includes(response.status)) throw new TelemetryTransportError("rejected");
      if (!response.ok) throw new TelemetryTransportError("invalid");
      if (value.user_pool_id !== config.userPoolId || value.client_id !== config.clientId) throw new TelemetryTransportError("rejected");
      return installationId.parse(value.installation_id);
    },
    async authenticate(registrationId, credential, signal) {
      let useRefreshToken = !!credential.refreshToken;
      while (true) {
        const { response, value } = await request(`https://cognito-idp.${region}.amazonaws.com/`, {
          ClientId: config.clientId,
          AuthFlow: useRefreshToken ? "REFRESH_TOKEN_AUTH" : "USER_PASSWORD_AUTH",
          AuthParameters: useRefreshToken ? { REFRESH_TOKEN: credential.refreshToken }
            : { USERNAME: `installation-${registrationId}`, PASSWORD: `Local1!${credential.secret}` },
        }, { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth" }, signal);
        if (!response.ok) {
          const kind = String(value.__type).split("#").at(-1);
          if (useRefreshToken && kind === "NotAuthorizedException") {
            // Refresh tokens expire independently of the installation secret.
            // Authenticate the same account once before declaring it rejected.
            useRefreshToken = false;
            continue;
          }
          if (["TooManyRequestsException", "InternalErrorException"].includes(kind!)) throw new TelemetryTransportError("retry");
          throw new TelemetryTransportError("rejected");
        }
        const result = z.object({ AccessToken: z.string().min(1).max(16384), ExpiresIn: z.number().positive().max(86400),
          RefreshToken: z.string().min(1).max(16384).optional() }).parse(value.AuthenticationResult);
        return { accessToken: result.AccessToken, expiresIn: result.ExpiresIn, refreshToken: result.RefreshToken };
      }
    },
    async send(events, accessToken, signal) {
      try { parseUsageBatch({ events }, { maxBodyBytes: config.maxBodyBytes, maxBatchEvents: config.maxBatchEvents }); }
      catch { throw new TelemetryTransportError("invalid"); }
      const { response, value } = await request(`${base}v1/events`, { events },
        { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, signal);
      if (response.status === 401) throw new TelemetryTransportError("unauthorized");
      if (response.status === 403) throw new TelemetryTransportError("rejected");
      if ([400, 410, 413, 422].includes(response.status)) throw new TelemetryTransportError("invalid");
      if (response.status !== 202) throw new TelemetryTransportError("retry");
      const ids = value.accepted_event_ids;
      if (!Array.isArray(ids) || ids.length !== events.length || new Set(ids).size !== ids.length
        || events.some(event => !ids.includes(event.event_id))) throw new TelemetryTransportError("retry");
    },
  };
}

/** Load lazily, after consent, and never downgrade to plaintext or volatile Linux storage. */
export function createOsTelemetrySecretStore(): SecretStore {
  async function entry(key: string) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry("ai.arkimux.local.telemetry", key, { linux: { store: "secret-service" } });
  }
  return {
    async get(key) { const text = await (await entry(key)).getPassword(AbortSignal.timeout(5000));
      return text == null ? undefined : z.strictObject({ secret: registrationSchema.shape.secret,
        refreshToken: z.string().max(16384).optional() }).parse(JSON.parse(text)); },
    async set(key, value) { await (await entry(key)).setPassword(JSON.stringify(value), AbortSignal.timeout(5000)); },
    async delete(key) { await (await entry(key)).deleteCredential(AbortSignal.timeout(5000)); },
  };
}
