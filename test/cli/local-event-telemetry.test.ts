import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalEventTelemetry } from "../../local/src/localEventTelemetry.ts";
import { TelemetryStateStore, TELEMETRY_TTL } from "../../local/src/localTelemetryState.ts";
import { createTelemetryTransport, TelemetryTransportError, type InstallationCredential, type SenderConfig } from "../../local/src/localTelemetryTransport.ts";
import { type UsageEvent } from "@com-pyvue/arkimux-telemetry-contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const config: SenderConfig = { schemaVersion: 1, baseUrl: "https://collector.example/collect/", userPoolId: "us-east-1_fixture", clientId: "fixtureclient",
  privacy: { noticeVersion: "test-aws-result-fetch", usageRetentionDays: 90, queryRetentionDays: 7,
    logRetentionDays: 7, deletionDescription: "Synthetic fixture policy, not approved production settings." }, maxBatchEvents: 25, maxBodyBytes: 32768 };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-event-sender-")); roots.push(root);
  let now = Date.parse("2026-09-30T00:00:00.000Z");
  const sub = "11223344-5566-7001-0123-123456789abc", secrets = new Map<string, InstallationCredential>(), sent: UsageEvent[][] = [];
  const vault = { get: vi.fn(async (key: string) => secrets.get(key)),
    set: vi.fn(async (key: string, value: InstallationCredential) => { secrets.set(key, value); }),
    delete: vi.fn(async (key: string) => { secrets.delete(key); }) };
  const transport = { register: vi.fn(async (_id: string, _secret: string, _signal: AbortSignal) => sub), authenticate: vi.fn(async (_id: string, _credential: InstallationCredential, _signal: AbortSignal) => ({ accessToken: "ACCESS_SECRET", expiresIn: 300, refreshToken: "REFRESH_SECRET" })),
    send: vi.fn(async (events: UsageEvent[]) => { sent.push(events); }),
    requestDeletion: vi.fn(async (_token: string, _signal: AbortSignal) => ({ schema_version: 1 as const, request_id: randomUUID(),
      requested_at: new Date(now).toISOString(), completion_due_at: new Date(now + 7 * 86400_000).toISOString(), status: "accepted" as const })) };
  const options = { projectRoot: path.join(root, "project"), machineRoot: root, arkimuxVersion: "0.1.0", config,
    environment: {}, transport, secrets: vault, now: () => now, random: () => 0.5 };
  const sender = new LocalEventTelemetry(options);
  const state = new TelemetryStateStore(root, () => now);
  return { root, options, sender, state, transport, vault, secrets, sent, sub, advance: (ms: number) => { now += ms; },
    read: () => state.update(s => structuredClone(s)) };
}

describe("event-first Local sender", () => {
  it("keeps privacy history across deletion, restart and a new identity without new telemetry kinds", async () => {
    const f = await fixture();
    await f.sender.choose("ask-later"); expect((await f.sender.status()).privacyHistory).toEqual([]);
    await f.sender.choose("yes");
    expect(await f.sender.status()).toMatchObject({ installationId: null,
      privacyHistory: [{ kind: "consent_granted" }] });
    await f.sender.flush(); await f.sender.choose("yes");
    expect((await f.sender.status()).privacyHistory).toHaveLength(1);
    expect((await f.sender.status()).installationId).toBe(f.sub);
    await f.sender.requestDeletion(); await f.sender.requestDeletion();
    expect((await f.sender.status()).installationId).toBeNull();
    await f.sender.flush(); await f.sender.flush();
    const oldHistory = (await f.sender.status()).privacyHistory;
    expect(oldHistory.map(e => e.kind)).toEqual(["deletion_accepted", "deletion_requested", "sharing_stopped", "consent_granted"]);
    expect(oldHistory.every(e => e.installationId === f.sub)).toBe(true);
    expect(oldHistory.some(e => e.kind === "deletion_completed")).toBe(false);
    const newSub = randomUUID(); f.transport.register.mockResolvedValueOnce(newSub); f.advance(1000);
    const restarted = new LocalEventTelemetry(f.options);
    await restarted.choose("yes"); await restarted.flush();
    const status = await restarted.status();
    expect(status.installationId).toBe(newSub);
    expect(status.privacyHistory[0]).toMatchObject({ kind: "consent_granted", installationId: newSub });
    expect(status.privacyHistory.slice(1)).toEqual(oldHistory);
    expect(JSON.stringify(status)).not.toMatch(/registrationId|ACCESS_SECRET|REFRESH_SECRET|"epoch"/);
    expect(f.sent.flat().map(e => e.kind)).toEqual(["arkimux.event.consent.success", "arkimux.event.consent.success"]);
    await restarted.choose("no"); await restarted.choose("no");
    expect((await restarted.status()).privacyHistory).toHaveLength(6);
    expect((await restarted.status()).privacyHistory[0]).toMatchObject({ kind: "sharing_stopped", installationId: newSub });
  });
  it("recovers only known legacy history and never assigns a new installation to an old receipt", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush();
    await f.sender.requestDeletion(); await f.sender.flush(); await f.sender.flush();
    const newSub = randomUUID(); f.transport.register.mockResolvedValueOnce(newSub); f.advance(1000);
    await f.sender.choose("yes"); await f.sender.flush();
    await f.state.update(s => { delete s.privacyHistory; delete s.remoteDeletion!.installationId; delete s.remoteDeletion!.requestedAt; });
    const history = (await new LocalEventTelemetry(f.options).status()).privacyHistory;
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ kind: "consent_granted", installationId: newSub, recovered: true });
    const accepted = history.find(e => e.kind === "deletion_accepted")!;
    expect(accepted.at).toBeUndefined(); expect(accepted.installationId).toBeUndefined();
    expect(history.find(e => e.kind === "deletion_requested")?.at).toBe(new Date(Date.parse("2026-09-30T00:00:00Z")).toISOString());
    expect((await f.sender.status()).privacyHistory).toEqual(history);
  });
  it("does not invent a stopped timestamp from a legacy consent changed by deletion", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush();
    f.advance(1000); await f.sender.requestDeletion(); await f.sender.flush();
    await f.state.update(s => { delete s.privacyHistory; delete s.remoteDeletion!.requestedAt; });
    const history = (await f.sender.status()).privacyHistory;
    expect(history.map(e => e.kind)).toEqual(["deletion_requested", "deletion_accepted"]);
    expect(history[0].at).toBe("2026-09-30T00:00:01.000Z");
    expect(history[1].at).toBeUndefined();
  });
  it("records deletion completion only when the service receipt confirms data_removed", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush();
    const receipt = { schema_version: 1 as const, request_id: randomUUID(), requested_at: "2026-09-30T00:00:00.000Z",
      completion_due_at: "2026-10-07T00:00:00.000Z", status: "data_removed" };
    f.transport.requestDeletion.mockResolvedValueOnce(receipt as any);
    await f.sender.requestDeletion(); await f.sender.flush();
    expect((await f.sender.status()).privacyHistory[0]).toMatchObject({ kind: "deletion_completed", requestId: receipt.request_id });
  });
  it("requires a new choice for the query-result expiry policy before resuming uploads", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    await f.state.update(s => { s.consent!.notice = `${config.privacy.noticeVersion}-framework-stacks-v1`; });
    expect(await f.sender.status()).toMatchObject({ choice: "undecided", sharingEnabled: false,
      privacyNoticeVersion: `${config.privacy.noticeVersion}-usage-only-v1-query-expiry-v1` });
    await f.sender.flush(); expect(f.transport.register).not.toHaveBeenCalled(); expect(f.sent).toEqual([]);
    await f.sender.choose("yes"); await f.sender.flush();
    expect(f.sent.flat().map(event => event.kind)).toEqual(["arkimux.event.consent.success"]);
  });
  it("requires a new choice when older consent did not cover the current retention terms", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    await f.state.update(s => { s.consent!.notice = config.privacy.noticeVersion; });
    expect(await f.sender.status()).toMatchObject({ choice: "undecided", sharingEnabled: false });
    await f.sender.flush(); expect(f.transport.register).not.toHaveBeenCalled(); expect(f.sent).toEqual([]);
    await f.sender.choose("yes"); await f.sender.flush();
    expect(f.sent.flat().map(event => event.kind)).toEqual(["arkimux.event.consent.success"]);
  });
  it("deletes shared data separately, stops sharing immediately and clears the credential only after acknowledgement", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush();
    const epoch = (await f.read()).consent!.epoch;
    expect((await f.sender.status()).canDeleteSharedData).toBe(true);
    await f.sender.start(); await f.sender.requestDeletion();
    expect(await f.sender.status()).toMatchObject({ choice: "declined", sharingEnabled: false,
      pendingEventCount: 0, deletionRequest: { status: "pending" } });
    expect(f.transport.requestDeletion).not.toHaveBeenCalled(); expect(f.secrets.has(epoch)).toBe(true);
    await f.sender.flush();
    expect(f.transport.requestDeletion).toHaveBeenCalledTimes(1);
    expect(await f.sender.status()).toMatchObject({ deletionRequest: { status: "accepted", receipt: { status: "accepted" } } });
    await f.sender.flush(); expect(f.secrets.has(epoch)).toBe(false);
    expect(f.sent).toHaveLength(1);
  });
  it("retries a deletion after restart without registering a new identity or sending usage", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush(); await f.sender.requestDeletion();
    f.transport.requestDeletion.mockRejectedValueOnce(new TelemetryTransportError("retry"));
    await f.sender.flush(); expect((await f.sender.status()).deletionRequest?.status).toBe("pending");
    expect(f.vault.delete).not.toHaveBeenCalled();
    const restarted = new LocalEventTelemetry(f.options); f.advance(6000);
    await restarted.flush(); expect((await restarted.status()).deletionRequest?.status).toBe("accepted");
    expect(f.transport.register).toHaveBeenCalledTimes(1); expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it("does not abandon a pending deletion on Yes or No, or send it to a different service", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush(); await f.sender.requestDeletion();
    await f.sender.choose("yes"); await f.sender.choose("no");
    expect((await f.sender.status()).deletionRequest?.status).toBe("pending");
    const changed = new LocalEventTelemetry({ ...f.options, config: { ...config, baseUrl: "https://different.example" } });
    await changed.flush(); expect(f.transport.requestDeletion).not.toHaveBeenCalled();
    expect(f.vault.delete).not.toHaveBeenCalled();
  });
  it("No only stops sharing and cannot silently request remote deletion", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush();
    await f.sender.choose("no"); await f.sender.flush();
    expect(f.transport.requestDeletion).not.toHaveBeenCalled();
    await expect(f.sender.requestDeletion()).rejects.toThrow("No authenticated sharing identity");
  });
  it("does not report a missing deletion credential as success", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush(); await f.sender.requestDeletion();
    f.secrets.clear(); await f.sender.flush();
    expect(await f.sender.status()).toMatchObject({ deletionRequest: { status: "pending" }, deliveryState: "credential-rejected" });
    expect(f.transport.requestDeletion).not.toHaveBeenCalled();
  });
  it("exposes indefinite retention explicitly and requires fresh consent when policy changes", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    const updated = new LocalEventTelemetry({ ...f.options, config: { ...config,
      privacy: { ...config.privacy, usageRetentionDays: "indefinite" } } });
    expect(await updated.status()).toMatchObject({ choice: "undecided", sharingEnabled: false,
      remoteRetentionDays: "indefinite", privacy: { usageRetentionDays: "indefinite" } });
    await updated.flush(); expect(f.transport.register).not.toHaveBeenCalled();
    await updated.choose("yes"); await updated.flush(); expect(f.transport.register).toHaveBeenCalledTimes(1);
  });
  it("does no network or credential work before consent, for No, or in CI", async () => {
    const f = await fixture();
    await f.sender.start(); await f.sender.begin("connection_tested"); await f.sender.flush();
    await f.sender.choose("ask-later"); await f.sender.flush();
    await f.sender.choose("no"); await f.sender.flush();
    const ci = new LocalEventTelemetry({ ...f.options, environment: { CI: "true" } });
    await ci.choose("yes"); await ci.start(); await ci.flush();
    expect(f.transport.register).not.toHaveBeenCalled(); expect(f.vault.get).not.toHaveBeenCalled();
    expect((await f.read()).outbox).toEqual([]);
  });
  it("saves consent immediately and defers credentials, registration and upload to the pump", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.start();
    expect(f.transport.register).not.toHaveBeenCalled(); expect(f.vault.set).not.toHaveBeenCalled();
    const before = await f.read();
    await f.sender.flush();
    expect(f.transport.register).toHaveBeenCalledTimes(1); expect(f.sent[0]).toHaveLength(2);
    expect(f.sent[0][0]).toMatchObject({ kind: "arkimux.event.consent.success", installation_id: f.sub,
      event_id: before.outbox[0].event.event_id, event_time: before.consent!.at });
    expect((await f.sender.status()).deliveryState).toBe("connected");
    const disk = await readFile(path.join(f.root, "collector.sqlite"));
    for (const secret of ["ACCESS_SECRET", "REFRESH_SECRET", ...[...f.secrets.values()].map(value => value.secret)]) expect(disk.includes(secret)).toBe(false);
  });
  it("persists consent and run correlation across restarts, with API-only fetched results", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    const ticket = await f.sender.begin("invocation_submitted"); await f.sender.finish(ticket!, true, "private-run-name");
    f.advance(1000);
    const restarted = new LocalEventTelemetry(f.options);
    await restarted.settled({ executionId: "private-run-name", status: "complete", elapsedMs: 1000 });
    f.advance(2000);
    const reader = new LocalEventTelemetry(f.options);
    await reader.fetched("private-run-name"); await reader.fetched("private-run-name"); await reader.flush();
    const events = f.sent.flat();
    expect(events.map(e => e.kind)).toEqual(["arkimux.event.consent.success", "arkimux.event.run.start", "arkimux.event.run.success", "arkimux.event.run_result.fetch.success"]);
    expect(new Set(events.map(e => e.consent_journey_id)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain("private-run-name");
  });
  it("shares one consent and credential across projects and serializes concurrent flushes", async () => {
    const f = await fixture(); const other = new LocalEventTelemetry({ ...f.options, projectRoot: path.join(f.root, "other") });
    await Promise.all([f.sender.choose("yes"), other.choose("yes")]);
    expect((await f.read()).outbox).toHaveLength(1);
    await Promise.all([f.sender.start(), other.start()]);
    await Promise.all([f.sender.flush(), other.flush()]);
    expect(f.transport.register).toHaveBeenCalledTimes(1); expect(f.vault.set.mock.calls.filter(call => !call[1].refreshToken)).toHaveLength(1);
    expect(f.sent.flat()).toHaveLength(3);
  });
  it("reuses the registration identity and secret after a lost registration reply", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    f.transport.register.mockRejectedValueOnce(new TelemetryTransportError("retry"));
    await f.sender.flush(); const first = f.transport.register.mock.calls[0];
    f.advance(6000); await new LocalEventTelemetry(f.options).flush();
    expect(f.transport.register.mock.calls[1].slice(0, 2)).toEqual(first.slice(0, 2));
    expect((await f.sender.status()).deliveryState).toBe("connected");
  });
  it("honors backoff and Retry-After, retaining IDs and occurrence times across failed sends", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    f.transport.send.mockRejectedValueOnce(new TelemetryTransportError("retry", 60_000));
    await f.sender.flush(); const original = f.transport.send.mock.calls[0][0];
    f.advance(30_000); await f.sender.flush(); expect(f.transport.send).toHaveBeenCalledTimes(1);
    f.advance(30_001); await f.sender.flush();
    const retry = f.sent[0]; expect(retry[0].event_id).toBe(original[0].event_id);
    expect(retry[0].event_time).toBe(original[0].event_time); expect(retry[0].send_time).not.toBe(original[0].send_time);
  });
  it("refreshes expired access tokens with the saved refresh token without registering again", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush();
    f.advance(300_001); await f.sender.start(); await new LocalEventTelemetry(f.options).flush();
    expect(f.transport.register).toHaveBeenCalledTimes(1);
    expect(f.transport.authenticate.mock.calls[1][1]).toMatchObject({ refreshToken: "REFRESH_SECRET" });
  });
  it("blocks rejected credentials instead of creating replacement installations", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    f.transport.authenticate.mockRejectedValueOnce(new TelemetryTransportError("rejected"));
    await f.sender.flush(); f.advance(100_000); await new LocalEventTelemetry(f.options).flush();
    expect((await f.sender.status()).deliveryState).toBe("credential-rejected");
    expect(f.transport.authenticate).toHaveBeenCalledTimes(1); expect(f.transport.register).toHaveBeenCalledTimes(1);
  });
  for (const phase of ["read", "create", "refresh"] as const) {
    for (const interruption of ["stop", "lease-expired", "lease-replaced"] as const) {
      it(`preserves the active credential after ${interruption} during credential ${phase}`, async () => {
        const f = await fixture(); await f.sender.choose("yes");
        if (phase !== "create") { await f.sender.flush(); await f.sender.start(); f.advance(300_001); }
        const before = await f.read(), epoch = before.consent!.epoch;
        let interruptedCredential: InstallationCredential | undefined;
        const interrupt = async () => {
          interruptedCredential = f.secrets.get(epoch);
          if (interruption === "stop") await f.sender.stop();
          else if (interruption === "lease-expired") f.advance(60_001);
          else await f.state.update(s => { s.lease = { owner: randomUUID(), until: f.options.now() + 60_000 }; });
        };
        if (phase === "read") f.vault.get.mockImplementationOnce(async key => {
          const value = f.secrets.get(key); await interrupt(); return value;
        });
        else f.vault.set.mockImplementationOnce(async (key, value) => { f.secrets.set(key, value); await interrupt(); });
        const sentBefore = f.transport.send.mock.calls.length;
        await f.sender.flush();
        expect(interruptedCredential).toBeDefined();
        expect(f.secrets.get(epoch)).toEqual(interruptedCredential);
        expect(f.vault.delete).not.toHaveBeenCalled();
        const interrupted = await f.read();
        expect(interrupted.consent).toEqual(before.consent);
        expect(interrupted.identity).toEqual(before.identity);
        expect(interrupted.outbox).toEqual(before.outbox);
        expect(f.transport.send).toHaveBeenCalledTimes(sentBefore);
        if (interruption === "lease-replaced") {
          expect(interrupted.lease).toBeDefined();
          f.advance(60_001);
        }
        await new LocalEventTelemetry(f.options).flush();
        expect((await f.sender.status()).deliveryState).toBe("connected");
        expect((await f.read()).outbox).toEqual([]);
        expect(f.transport.register).toHaveBeenCalledTimes(1);
        expect(f.sent.at(-1)!.map(event => event.event_id)).toEqual(before.outbox.map(row => row.event.event_id));
        expect(f.transport.authenticate.mock.calls.at(-1)![1]).toEqual(interruptedCredential);
      });
    }
  }
  for (const phase of ["read", "refresh"] as const) {
    for (const choice of ["no", "yes", "replace", "delete"] as const) {
      it(`respects ${choice} during credential ${phase} cleanup`, async () => {
        const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush();
        await f.sender.start(); f.advance(300_001);
        const epoch = (await f.read()).consent!.epoch;
        const changeConsent = async () => {
          if (choice === "delete") await f.sender.requestDeletion();
          else if (choice === "replace") { await f.sender.choose("no"); await f.sender.choose("yes"); }
          else await f.sender.choose(choice);
        };
        if (phase === "read") f.vault.get.mockImplementationOnce(async key => {
          const value = f.secrets.get(key); await changeConsent(); return value;
        });
        else f.vault.set.mockImplementationOnce(async (key, value) => { f.secrets.set(key, value); await changeConsent(); });
        await f.sender.flush();
        expect(f.transport.send).toHaveBeenCalledTimes(1);
        if (choice === "no" || choice === "replace") {
          expect(f.secrets.has(epoch)).toBe(false);
          await f.sender.flush();
          expect((await f.read()).pendingDeletes).toEqual([]);
          if (choice === "replace") {
            const replacement = await f.read();
            expect(replacement.consent!.epoch).not.toBe(epoch);
            expect(f.secrets.has(replacement.consent!.epoch)).toBe(true);
            expect((await f.sender.status()).deliveryState).toBe("connected");
          }
        } else {
          expect(f.secrets.has(epoch)).toBe(true);
          expect(f.vault.delete).not.toHaveBeenCalled();
          await new LocalEventTelemetry(f.options).flush();
          if (choice === "delete") {
            expect(f.transport.requestDeletion).toHaveBeenCalledTimes(1);
            await f.sender.flush(); expect(f.secrets.has(epoch)).toBe(false);
          } else expect((await f.sender.status()).deliveryState).toBe("connected");
        }
      });
    }
  }
  it("never falls back to plaintext when the credential store fails", async () => {
    const f = await fixture(); await f.sender.choose("yes"); f.vault.get.mockRejectedValueOnce(new Error("locked"));
    await f.sender.flush(); expect((await f.sender.status()).deliveryState).toBe("credential-store-unavailable");
    expect(f.transport.register).not.toHaveBeenCalled(); expect(f.transport.send).not.toHaveBeenCalled();
  });
  it("withdraws immediately during registration and deletes old credentials in the background", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    let finish!: (value: string) => void;
    f.transport.register.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pump = f.sender.flush(); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await f.sender.choose("no"); finish(f.sub); await pump;
    expect(f.transport.authenticate).not.toHaveBeenCalled(); expect(f.transport.send).not.toHaveBeenCalled();
    await f.sender.flush(); expect(f.secrets.size).toBe(0); expect((await f.read()).outbox).toHaveLength(0);
  });
  it("retains failed credential deletion for retry but never resumes sending", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush(); await f.sender.choose("no");
    f.vault.delete.mockRejectedValueOnce(new Error("locked")); await f.sender.flush();
    expect((await f.sender.status()).credentialDeletionPending).toBe(true);
    f.advance(10000); await f.sender.flush(); expect((await f.sender.status()).credentialDeletionPending).toBe(false);
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it("rejects old provider consent and asks again after recipient or notice changes", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "state.json"), JSON.stringify({ choice: "accepted", installationId: randomUUID() }));
    expect((await f.sender.status()).choice).toBe("undecided"); await f.sender.flush(); expect(f.transport.register).not.toHaveBeenCalled();
    await f.sender.choose("yes");
    const changed = new LocalEventTelemetry({ ...f.options, config: { ...config, baseUrl: "https://new.example/" } });
    expect((await changed.status()).choice).toBe("undecided"); await changed.flush(); expect(f.transport.register).not.toHaveBeenCalled();
  });
  it("bounds each project outbox to 100 events and expires queued data after seven days", async () => {
    const f = await fixture(); await f.sender.choose("yes"); for (let n = 0; n < 110; n++) await f.sender.start();
    expect((await f.read()).outbox).toHaveLength(100);
    f.advance(TELEMETRY_TTL + 1); expect((await f.read()).outbox).toHaveLength(0);
  });
  it("discards legacy error outboxes while retaining the same consent, identity and usage events", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush(); await f.sender.start();
    const before = await f.read();
    const saved = structuredClone(before);
    // Simulate an old queue, including a retired diagnostic shape.
    const db = new DatabaseSync(path.join(f.root, "collector.sqlite"));
    try { db.prepare("UPDATE state SET payload=? WHERE id=1").run(JSON.stringify({ ...saved,
      outbox: [{ project: saved.outbox[0].project, event: { kind: "arkimux.error.framework", message: "PRIVATE DIAGNOSTIC" } }, ...saved.outbox] })); }
    finally { db.close(); }
    const restarted = new LocalEventTelemetry(f.options);
    expect(await restarted.status()).toMatchObject({ choice: "accepted", sharingEnabled: true, pendingEventCount: 1, installationId: f.sub });
    await restarted.flush();
    expect(f.sent.flat().map(e => e.kind)).toEqual(["arkimux.event.consent.success", "arkimux.event.local.start"]);
    expect(JSON.stringify(f.sent)).not.toContain("PRIVATE DIAGNOSTIC");
    expect((await f.read()).consent!.epoch).toBe(before.consent!.epoch);
    expect((await f.read()).privacyHistory).toEqual(before.privacyHistory);
    expect(f.transport.register).toHaveBeenCalledTimes(1);
  });
  it.each(["yes", "no"] as const)("asks again after the usage-only upgrade, even when the old choice was %s", async choice => {
    const f = await fixture(); await f.sender.choose(choice);
    await f.state.update(s => { s.consent!.notice = `${config.privacy.noticeVersion}-framework-stacks-v1-query-expiry-v1`; });
    const before = await f.read();
    const restarted = new LocalEventTelemetry(f.options);
    expect(await restarted.status()).toMatchObject({ choice: "undecided", sharingEnabled: false, promptEligible: true });
    await restarted.flush();
    expect(f.transport.register).not.toHaveBeenCalled(); expect(f.sent).toEqual([]);
    expect((await f.read()).privacyHistory).toEqual(before.privacyHistory);
    await restarted.choose("yes"); await restarted.flush();
    expect((await f.read()).consent!.epoch).not.toBe(before.consent!.epoch);
    expect(f.sent.flat().map(event => event.kind)).toEqual(["arkimux.event.consent.success"]);
  });
  it("reauthenticates after a 401 without losing the batch or registering a new identity", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    const ids = (await f.read()).outbox.map(row => row.event.event_id);
    f.transport.send.mockRejectedValueOnce(new TelemetryTransportError("unauthorized"));
    await f.sender.flush();
    expect((await f.read()).outbox.map(row => row.event.event_id)).toEqual(ids);
    f.advance(6000); await f.sender.flush();
    expect(f.transport.register).toHaveBeenCalledTimes(1);
    expect(f.transport.authenticate).toHaveBeenCalledTimes(2);
    expect((await f.read()).outbox).toEqual([]);
  });
  it("removes only acknowledged events while new events arrive during upload", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    f.transport.send.mockImplementationOnce(async events => { f.sent.push(events); await f.sender.start(); });
    await f.sender.flush();
    expect((await f.read()).outbox.map(row => row.event.kind)).toEqual(["arkimux.event.local.start"]);
    await f.sender.flush(); expect((await f.read()).outbox).toEqual([]);
  });
  it("reports a permanently rejected batch and can deliver later valid events", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    f.transport.send.mockRejectedValueOnce(new TelemetryTransportError("invalid"));
    await f.sender.flush();
    expect((await f.sender.status()).deliveryState).toBe("invalid-event");
    expect((await f.read()).outbox).toEqual([]);
    await f.sender.start(); f.advance(6000); await f.sender.flush();
    expect((await f.sender.status()).deliveryState).toBe("connected");
  });
  it("does not authorize a future non-CI process through a suppressed consent call", async () => {
    const f = await fixture();
    await new LocalEventTelemetry({ ...f.options, environment: { CI: "1" } }).choose("yes");
    await f.sender.start(); await f.sender.flush();
    expect(await f.sender.currentConsent()).toBeUndefined();
    expect(f.transport.register).not.toHaveBeenCalled();
  });
  it("ignores a late authentication rejection after another sender takes over and succeeds", async () => {
    const f = await fixture(); await f.sender.choose("yes"); await f.sender.flush(); await f.sender.start();
    let rejectOld!: (error: Error) => void;
    f.transport.authenticate.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const stale = new LocalEventTelemetry(f.options), current = new LocalEventTelemetry(f.options);
    const pending = stale.flush();
    await vi.waitFor(() => expect(rejectOld).toBeTypeOf("function"));
    f.advance(60_001); await current.flush();
    expect((await f.sender.status()).deliveryState).toBe("connected");
    rejectOld(new TelemetryTransportError("rejected")); await pending;
    expect(await f.read()).toMatchObject({ delivery: "connected", retryAt: 0, attempts: 0 });
    await current.start(); await current.flush();
    expect(f.sent.flat().filter(event => event.kind === "arkimux.event.local.start")).toHaveLength(2);
    expect(f.transport.register).toHaveBeenCalledTimes(1);
  });
});

describe("Cognito HTTP transport", () => {
  it("rejects error content before making an HTTP request, including mixed batches", async () => {
    const f = await fixture(); await f.sender.choose("yes");
    const usage = (await f.read()).outbox[0].event;
    const error = { ...usage, kind: "arkimux.error.framework", diagnostic_id: randomUUID(), error: { code: "cleanup-failed", message: "secret", frames: [] } };
    const fetcher = vi.fn(); const transport = createTelemetryTransport(config, fetcher);
    for (const events of [[error], [usage, error]]) {
      await expect(transport.send(events as UsageEvent[], "token", new AbortController().signal)).rejects.toMatchObject({ kind: "invalid" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts deletion without an installation ID and validates the durable receipt", async () => {
    const receipt = { schema_version: 1, request_id: randomUUID(), status: "accepted",
      requested_at: "2026-09-30T00:00:00.000Z", completion_due_at: "2026-10-07T00:00:00.000Z" };
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(receipt), { status: 202 }));
    const transport = createTelemetryTransport(config, fetcher);
    expect(await transport.requestDeletion!("ACCESS_SECRET", new AbortController().signal)).toEqual(receipt);
    expect(fetcher.mock.calls[0][0]).toBe("https://collector.example/collect/v1/deletion");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ schema_version: 1, confirm: true });
    fetcher.mockResolvedValueOnce(new Response("{}", { status: 202 }));
    await expect(transport.requestDeletion!("ACCESS_SECRET", new AbortController().signal)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(transport.requestDeletion!("ACCESS_SECRET", new AbortController().signal)).rejects.toMatchObject({ kind: "unauthorized" });
  });
  it("uses password then refresh flows, rejects redirects and requires exact durable acknowledgements", async () => {
    const sub = "11223344-5566-7001-0123-123456789abc", id = randomUUID(); const calls: Array<{ url: string; body: any; headers: any; redirect: unknown }> = [];
    const fetcher = vi.fn(async (url: any, init: any) => {
      const body = JSON.parse(init.body); calls.push({ url: String(url), body, headers: init.headers, redirect: init.redirect });
      if (String(url).endsWith("installations")) return Response.json({ installation_id: sub, user_pool_id: config.userPoolId, client_id: config.clientId });
      return Response.json({ AuthenticationResult: { AccessToken: "access", ExpiresIn: 300, RefreshToken: "refresh" } });
    });
    const transport = createTelemetryTransport(config, fetcher);
    expect(await transport.register(id, "a".repeat(43), new AbortController().signal)).toBe(sub);
    await transport.authenticate(id, { secret: "s" }, new AbortController().signal);
    await transport.authenticate(id, { secret: "s", refreshToken: "refresh" }, new AbortController().signal);
    expect(calls[0].url).toBe("https://collector.example/collect/v1/installations");
    expect(calls[1].body.AuthFlow).toBe("USER_PASSWORD_AUTH"); expect(calls[2].body.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect(calls.every(call => call.redirect === "error")).toBe(true);
    fetcher.mockResolvedValueOnce(Response.json({ accepted_event_ids: [id] }, { status: 202 }));
    await transport.send([{ ...transportUsage(), event_id: id }], "access", new AbortController().signal);
    fetcher.mockResolvedValueOnce(Response.json({ accepted_event_ids: [] }, { status: 202 }));
    await expect(transport.send([{ ...transportUsage(), event_id: id }], "access", new AbortController().signal)).rejects.toMatchObject({ kind: "retry" });
  });
  it.each([[401, "unauthorized"], [403, "rejected"], [413, "invalid"], [503, "retry"]])("classifies non-JSON HTTP %s responses without discarding retryable events", async (status, kind) => {
    const transport = createTelemetryTransport(config, vi.fn(async () => new Response("gateway response", { status: Number(status) })));
    await expect(transport.send([transportUsage()], "access", new AbortController().signal)).rejects.toMatchObject({ kind });
  });
});

function transportUsage(): UsageEvent {
  return { schema_version: 1, kind: "arkimux.event.local.start", event_id: randomUUID(), installation_id: randomUUID(),
    consent_journey_id: randomUUID(), event_time: "2026-10-12T00:00:00.000Z", send_time: "2026-10-12T00:00:00.000Z", arkimux_version: "0.1.0" };
}
