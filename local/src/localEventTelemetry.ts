import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { type UsageEvent } from "@com-pyvue/arkimux-telemetry-contracts";
import { TelemetryStateStore, telemetryRoot, recordPrivacyHistory, type TelemetryState } from "./localTelemetryState.ts";
import { createOsTelemetrySecretStore, createTelemetryTransport, senderConfigSchema, TelemetryTransportError,
  type SenderConfig, type SecretStore, type TelemetryTransport } from "./localTelemetryTransport.ts";

type Action = "connection_created" | "connection_tested" | "configuration_saved" | "invocation_submitted";
type Settlement = { executionId: string; status: "complete" | "failed" | "cancelled"; elapsedMs: number };
const NOTICE = "2026-10-12-usage-only-query-expiry";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function loadSenderConfig(environment: NodeJS.ProcessEnv): SenderConfig | undefined {
  if (!environment.ARKIMUX_TELEMETRY_CONFIG) return;
  try { return senderConfigSchema.parse(JSON.parse(readFileSync(environment.ARKIMUX_TELEMETRY_CONFIG, "utf8"))); }
  catch { return; } // Fail closed. Never use an old provider as a fallback.
}
export interface LocalEventTelemetryOptions {
  projectRoot: string; arkimuxVersion: string; machineRoot?: string; environment?: NodeJS.ProcessEnv;
  config?: SenderConfig; transport?: TelemetryTransport; secrets?: SecretStore; now?: () => number;
  random?: () => number;
  /** Local-only reporting for unexpected sender failures, never delivery retries. */
  onInternalError?(error: unknown): Promise<void>;
}

/** The Local API/runtime owns events. The browser never receives installation credentials. */
export class LocalEventTelemetry {
  readonly #store: TelemetryStateStore;
  readonly #config?: SenderConfig;
  readonly #transport?: TelemetryTransport;
  readonly #secrets: SecretStore;
  readonly #project: string;
  readonly #target: string;
  readonly #notice: string;
  readonly #now: () => number;
  #askLater = false;
  #flush?: Promise<void>;
  #abort?: AbortController;
  #token?: { epoch: string; value: string; expires: number };
  constructor(readonly options: LocalEventTelemetryOptions) {
    this.#now = options.now ?? Date.now;
    this.#store = new TelemetryStateStore(options.machineRoot ?? telemetryRoot(), this.#now);
    this.#config = options.config ? senderConfigSchema.parse(options.config) : loadSenderConfig(options.environment ?? process.env);
    this.#transport = options.transport ?? (this.#config ? createTelemetryTransport(this.#config) : undefined);
    this.#secrets = options.secrets ?? createOsTelemetrySecretStore();
    this.#project = hash(path.resolve(options.projectRoot));
    // A new usage-only notice requires a fresh choice. Saved history is retained.
    this.#notice = this.#config ? `${this.#config.privacy.noticeVersion}-usage-only-v1-query-expiry-v1` : NOTICE;
    this.#target = this.#config ? hash(JSON.stringify([this.#config.baseUrl, this.#config.userPoolId, this.#config.clientId, this.#config.privacy])) : "unconfigured";
  }
  #suppressed() { const env = this.options.environment ?? process.env;
    return env.CI === "true" || env.CI === "1" || env.ARKIMUX_DISABLE_TELEMETRY === "1"; }
  #currentChoice(s: TelemetryState) {
    return s.consent?.notice === this.#notice && s.consent.target === this.#target ? s.consent : undefined;
  }
  #consent(s: TelemetryState) {
    return s.remoteDeletion?.status !== "pending" && !this.#suppressed() && this.#currentChoice(s)?.choice === "accepted" ? s.consent : undefined;
  }
  async status() {
    return this.#store.update(s => {
      const current = this.#currentChoice(s);
      return { schemaVersion: 1 as const, arkimuxVersion: this.options.arkimuxVersion, choice: current?.choice ?? "undecided", sharingEnabled: !!this.#consent(s),
        promptEligible: !current && !this.#askLater && !this.#suppressed(), privacyNoticeVersion: this.#notice,
        provider: { kind: "arkimux" as const, configured: !!this.#config },
        deliveryState: s.remoteDeletion?.status === "pending" ? s.delivery : !this.#consent(s) ? "disabled" : !this.#config ? "not-configured" : s.delivery,
        pendingEventCount: s.outbox.filter(row => row.project === this.#project).length,
        localRetentionDays: 7 as const, remoteRetentionDays: this.#config?.privacy.usageRetentionDays ?? null,
        privacy: this.#config?.privacy ?? null, remoteDeletion: "installation-authenticated" as const,
        canDeleteSharedData: !!this.#transport?.requestDeletion && !!s.identity?.sub && this.#consent(s) !== undefined,
        installationId: this.#consent(s) ? s.identity?.sub ?? null : null,
        privacyHistory: [...(s.privacyHistory ?? [])].reverse()
          .sort((a, b) => (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0))
          .map(({ epoch: _epoch, ...entry }) => entry),
        deletionRequest: s.remoteDeletion ? { status: s.remoteDeletion.status, receipt: s.remoteDeletion.receipt } : null,
        credentialDeletionPending: s.pendingDeletes.length > 0 };
    });
  }
  async currentConsent() {
    return this.#store.update(s => { const consent = this.#consent(s);
      return consent ? { grantedAt: consent.at, privacyNoticeVersion: consent.notice } : undefined; });
  }
  async currentId() { return this.#store.update(s => this.#consent(s)?.epoch); }
  async choose(choice: "yes" | "no" | "ask-later") {
    if (await this.#store.update(s => s.remoteDeletion?.status === "pending")) return this.status();
    if (choice === "yes" && this.#suppressed()) return this.status();
    if (choice === "ask-later") { this.#askLater = true; return this.status(); }
    this.#abort?.abort(); this.#token = undefined;
    await this.#store.update(s => {
      if (s.remoteDeletion?.status === "pending") return;
      if (choice === "yes" && this.#consent(s)) return;
      if (choice === "no" && this.#currentChoice(s)?.choice === "declined") return;
      const previousInstallationId = s.identity?.sub;
      if (s.identity && s.consent && !s.pendingDeletes.includes(s.consent.epoch)) s.pendingDeletes.push(s.consent.epoch);
      if (s.pendingDeletes.length > 100) throw new Error("Clear pending telemetry credentials before changing consent again.");
      s.identity = undefined; s.outbox = []; s.operations = {}; s.runs = {}; s.early = {}; s.lease = undefined;
      s.retryAt = 0; s.attempts = 0;
      s.consent = { choice: choice === "yes" ? "accepted" : "declined", notice: this.#notice, target: this.#target,
        at: new Date(this.#now()).toISOString(), epoch: randomUUID() };
      s.delivery = choice === "yes" ? "registration-pending" : "disabled";
      recordPrivacyHistory(s, { epoch: s.consent.epoch, kind: choice === "yes" ? "consent_granted" : "sharing_stopped",
        at: s.consent.at, notice: s.consent.notice, ...(choice === "no" ? { installationId: previousInstallationId } : {}) });
      if (choice === "yes" && !this.#suppressed()) {
        s.identity = { registrationId: randomUUID(), credentialCreated: false };
        this.#enqueue(s, "arkimux.event.consent.success");
      }
    });
    // Local cleanup only. A different privacy version cannot authorize forwarding legacy queues.
    if (choice === "no") await Promise.all(["outboxes", "milestones"].map(name =>
      rm(path.join(this.#store.root, name), { recursive: true, force: true })));
    // Network and OS credential operations run from the host's background pump, never in this request.
    return this.status();
  }
  async requestDeletion() {
    if (!this.#config || !this.#transport?.requestDeletion) throw new Error("Deletion is not configured.");
    this.#abort?.abort(); this.#token = undefined;
    await this.#store.update(s => {
      if (s.remoteDeletion?.status === "pending") return;
      const consent = this.#consent(s);
      if (!consent || !s.identity?.sub || !s.identity.credentialCreated) throw new Error("No authenticated sharing identity is available.");
      const at = new Date(this.#now()).toISOString();
      s.remoteDeletion = { epoch: consent.epoch, registrationId: s.identity.registrationId, target: this.#target, status: "pending",
        installationId: s.identity.sub, requestedAt: at };
      recordPrivacyHistory(s, { epoch: consent.epoch, kind: "sharing_stopped", at, installationId: s.identity.sub, notice: consent.notice });
      recordPrivacyHistory(s, { epoch: consent.epoch, kind: "deletion_requested", at, installationId: s.identity.sub });
      s.consent!.choice = "declined";
      s.outbox = []; s.operations = {}; s.runs = {}; s.early = {};
      s.retryAt = 0; s.attempts = 0; s.delivery = "retrying";
    });
    return this.status();
  }
  async #deleteUnusedCredential(epoch: string) {
    // Losing a sender lease or stopping Local does not retire the installation.
    // Use persisted ownership, not this sender's interrupted delivery state.
    const inUse = await this.#store.update(s =>
      (s.consent?.choice === "accepted" && s.consent.epoch === epoch)
      || (s.remoteDeletion?.status === "pending" && s.remoteDeletion.epoch === epoch));
    if (!inUse) await this.#secrets.delete(epoch);
  }
  async start() { await this.#store.update(s => { if (this.#consent(s)) this.#enqueue(s, "arkimux.event.local.start"); }); }
  async stop() { this.#abort?.abort(); this.#token = undefined; }
  #enqueue(s: TelemetryState, kind: UsageEvent["kind"], operation?: string, at?: string) {
    const consent = this.#consent(s); if (!consent || !s.identity) return;
    const event: UsageEvent = { schema_version: 1, event_id: randomUUID(), installation_id: s.identity.sub ?? s.identity.registrationId,
      consent_journey_id: consent.epoch, event_time: at ?? new Date(this.#now()).toISOString(),
      send_time: new Date(this.#now()).toISOString(), kind, arkimux_version: this.options.arkimuxVersion,
      ...(operation ? { operation_id: operation } : {}) };
    this.#queue(s, event);
  }
  #queue(s: TelemetryState, event: UsageEvent) {
    s.outbox.push({ project: this.#project, event });
    let count = 0;
    s.outbox = [...s.outbox].reverse().filter(item => item.project !== this.#project || ++count <= 100).reverse();
  }
  async begin(kind: Action) {
    return this.#store.update(s => {
      const consent = this.#consent(s); if (!consent || Object.keys(s.operations).length >= 1000) return;
      const operation = randomUUID(); s.operations[operation] = { epoch: consent.epoch, kind, at: new Date(this.#now()).toISOString() };
      if (kind === "connection_tested") this.#enqueue(s, "arkimux.event.connection.test.start", operation);
      return operation;
    });
  }
  #runKey(executionId: string) { return hash(`${this.#project}/${executionId}`); }
  async finish(operation: string, succeeded: boolean, executionId?: string) {
    await this.#store.update(s => {
      const action = s.operations[operation]; delete s.operations[operation];
      if (!action || action.epoch !== this.#consent(s)?.epoch) return;
      if (action.kind === "connection_tested") this.#enqueue(s, succeeded ? "arkimux.event.connection.test.success" : "arkimux.event.connection.test.error", operation);
      if (action.kind === "connection_created" && succeeded) this.#enqueue(s, "arkimux.event.connection.create.success", operation);
      if (action.kind === "configuration_saved" && succeeded) this.#enqueue(s, "arkimux.event.configuration.save.success", operation);
      if (action.kind === "invocation_submitted" && succeeded && executionId) {
        const key = this.#runKey(executionId);
        // Duplicate admission receipts must not change the operation attached to a Run.
        if (s.runs[key]) return;
        if (Object.keys(s.runs).length >= 10000) return;
        s.runs[key] = { epoch: action.epoch, operation, at: action.at, fetched: false };
        this.#enqueue(s, "arkimux.event.run.start", operation, action.at);
        const early = s.early[key]; delete s.early[key];
        if (early) this.#settle(s, key, early.outcome, early.at);
      }
      if (!Object.values(s.operations).some(item => item.kind === "invocation_submitted")) s.early = {};
    });
  }
  #settle(s: TelemetryState, key: string, status: Settlement["status"], at: string) {
    const run = s.runs[key]; if (!run || run.epoch !== this.#consent(s)?.epoch || run.outcome) return;
    run.outcome = status;
    this.#enqueue(s, status === "complete" ? "arkimux.event.run.success" : status === "failed" ? "arkimux.event.run.error" : "arkimux.event.run.cancel", run.operation, at);
  }
  async settled(event: Settlement) {
    await this.#store.update(s => {
      if (!this.#consent(s)) return;
      const key = this.#runKey(event.executionId), at = new Date(this.#now()).toISOString();
      if (s.runs[key]) this.#settle(s, key, event.status, at);
      else if (Object.values(s.operations).some(item => item.kind === "invocation_submitted") && Object.keys(s.early).length < 1000) {
        s.early[key] = { outcome: event.status, at };
      }
    });
  }
  async fetched(executionId: string) {
    return this.#store.update(s => {
      const run = s.runs[this.#runKey(executionId)];
      if (!run || run.epoch !== this.#consent(s)?.epoch || run.fetched || (run.outcome && run.outcome !== "complete")) return true;
      if (!run.outcome) return false;
      this.#enqueue(s, "arkimux.event.run_result.fetch.success", run.operation); run.fetched = true; return true;
    });
  }
  flush(): Promise<void> { return this.#flush ??= this.#deliver().finally(() => { this.#flush = undefined; }); }
  async #deliver() {
    if (this.#suppressed()) return;
    const owner = randomUUID(); this.#abort = new AbortController(); const signal = this.#abort.signal;
    // A short, persisted sender lease prevents two Local processes from registering or refreshing together.
    const snapshot = await this.#store.update(s => {
      if (s.lease && s.lease.until > this.#now()) return;
      if (s.retryAt > this.#now()) return;
      s.lease = { owner, until: this.#now() + 60_000 }; return structuredClone(s);
    });
    if (!snapshot) return;
    const epoch = snapshot.consent?.epoch;
    const ownsLease = (s: TelemetryState) => s.lease?.owner === owner && s.lease.until > this.#now() && !signal.aborted;
    const isCurrent = (s: TelemetryState) => ownsLease(s) && this.#consent(s)?.epoch === epoch;
    const current = () => this.#store.update(isCurrent);
    let credentialFailure = false;
    try {
      for (const key of snapshot.pendingDeletes) {
        credentialFailure = true; await this.#secrets.delete(key); credentialFailure = false;
        await this.#store.update(s => { s.pendingDeletes = s.pendingDeletes.filter(item => item !== key); });
      }
      const deletion = snapshot.remoteDeletion;
      if (deletion?.status === "pending") {
        if (deletion.target !== this.#target || !this.#transport?.requestDeletion) return;
        const isPending = (s: TelemetryState) => ownsLease(s)
          && s.remoteDeletion?.epoch === deletion.epoch && s.remoteDeletion.status === "pending";
        const stillPending = () => this.#store.update(isPending);
        credentialFailure = true;
        const credential = await this.#secrets.get(deletion.epoch);
        if (!credential) throw new TelemetryTransportError("rejected");
        credentialFailure = false;
        if (!await stillPending()) return;
        const token = await this.#transport.authenticate(deletion.registrationId, { secret: credential.secret }, signal);
        if (!await stillPending()) return;
        const receipt = await this.#transport.requestDeletion(token.accessToken, signal);
        if (!await stillPending()) return;
        await this.#store.update(s => {
          if (!isPending(s)) return;
          s.remoteDeletion = { ...deletion, status: "accepted", receipt };
          for (const entry of s.privacyHistory ?? []) if (entry.epoch === deletion.epoch && entry.kind === "deletion_requested") entry.requestId = receipt.request_id;
          recordPrivacyHistory(s, { epoch: deletion.epoch, kind: receipt.status === "data_removed" ? "deletion_completed" : "deletion_accepted",
            at: new Date(this.#now()).toISOString(), installationId: deletion.installationId,
            requestId: receipt.request_id, completionDueAt: receipt.completion_due_at });
          s.identity = undefined; s.pendingDeletes.push(deletion.epoch);
          s.retryAt = 0; s.attempts = 0; s.delivery = "disabled";
        });
        return;
      }
      if (!this.#config || !this.#transport || !snapshot.identity || !await current()) return;
      if (snapshot.delivery === "credential-rejected") return;
      credentialFailure = true;
      let credential = await this.#secrets.get(epoch!);
      if (!credential) {
        if (snapshot.identity.credentialCreated) throw new TelemetryTransportError("rejected");
        credential = { secret: randomBytes(32).toString("base64url") };
        await this.#secrets.set(epoch!, credential);
      }
      credentialFailure = false;
      if (!await current()) { await this.#deleteUnusedCredential(epoch!); return; }
      await this.#store.update(s => { if (isCurrent(s) && s.identity) s.identity.credentialCreated = true; });
      let sub = snapshot.identity.sub;
      if (!sub) {
        sub = await this.#transport.register(snapshot.identity.registrationId, credential.secret, signal);
        if (!await current()) return;
        await this.#store.update(s => { if (isCurrent(s) && s.identity) {
          s.identity.sub = sub;
          for (const entry of s.privacyHistory ?? []) if (entry.epoch === epoch && !entry.installationId) entry.installationId = sub;
          for (const item of s.outbox) item.event.installation_id = sub!;
        } });
      }
      if (!this.#token || this.#token.epoch !== epoch || this.#token.expires <= this.#now() + 30_000) {
        if (!await current()) return;
        const token = await this.#transport.authenticate(snapshot.identity.registrationId, credential, signal);
        if (!await current()) return;
        if (token.refreshToken) {
          credentialFailure = true; await this.#secrets.set(epoch!, { ...credential, refreshToken: token.refreshToken }); credentialFailure = false;
          if (!await current()) { await this.#deleteUnusedCredential(epoch!); return; }
        }
        this.#token = { epoch: epoch!, value: token.accessToken, expires: this.#now() + token.expiresIn * 1000 };
      }
      let oversized = false;
      const batch = await this.#store.update(s => {
        if (!isCurrent(s)) return [];
        const selected: UsageEvent[] = [];
        for (const row of s.outbox) {
          const event = { ...row.event, send_time: new Date(this.#now()).toISOString(), installation_id: sub! };
          if (selected.length >= this.#config!.maxBatchEvents || Buffer.byteLength(JSON.stringify({ events: [...selected, event] })) > this.#config!.maxBodyBytes) break;
          selected.push(event);
        }
        if (!selected.length && s.outbox.length) { s.outbox.shift(); oversized = true; }
        return selected;
      });
      if (oversized) throw new TelemetryTransportError("invalid");
      if (batch.length && await current()) {
        try { await this.#transport.send(batch, this.#token.value, signal); }
        catch (error) {
          if (error instanceof TelemetryTransportError && error.kind === "invalid") {
            await this.#store.update(s => { if (isCurrent(s)) s.outbox = s.outbox.filter(item => !batch.some(event => event.event_id === item.event.event_id)); });
          }
          throw error;
        }
        if (!await current()) return;
        await this.#store.update(s => { if (isCurrent(s)) s.outbox = s.outbox.filter(item => !batch.some(event => event.event_id === item.event.event_id)); });
      }
      await this.#store.update(s => { if (isCurrent(s)) { s.delivery = "connected"; s.attempts = 0; s.retryAt = 0; } });
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof TelemetryTransportError) && !credentialFailure) {
        try { await this.options.onInternalError?.(error); } catch { /* Do not recurse into the outbox. */ }
      }
      if (error instanceof TelemetryTransportError && error.kind === "unauthorized") this.#token = undefined;
      await this.#store.update(s => {
        if (!ownsLease(s) || s.consent?.epoch !== epoch) return;
        s.delivery = error instanceof TelemetryTransportError && error.kind === "rejected" ? "credential-rejected"
          : credentialFailure ? "credential-store-unavailable" : error instanceof TelemetryTransportError && error.kind === "invalid" ? "invalid-event" : "retrying";
        const jitter = 0.75 + (this.options.random?.() ?? Math.random()) * 0.5;
        const delay = Math.min(3600_000, 5000 * 2 ** Math.min(s.attempts++, 10)) * jitter;
        s.retryAt = this.#now() + Math.max(delay, error instanceof TelemetryTransportError ? error.retryAfterMs ?? 0 : 0);
      });
    } finally {
      await this.#store.update(s => { if (s.lease?.owner === owner) s.lease = undefined; });
    }
  }
}
