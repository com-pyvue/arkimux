import { chmod, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { usageEventSchema, uuid, installationId, deletionReceiptSchema } from "@com-pyvue/arkimux-telemetry-contracts";

export const TELEMETRY_TTL = 7 * 86400_000;
const decision = z.strictObject({ choice: z.enum(["accepted", "declined"]), notice: z.string(),
  target: z.string(), at: z.string().datetime(), epoch: uuid });
const queued = z.strictObject({ project: z.string(), event: usageEventSchema });
const privacyHistoryEntry = z.strictObject({ id: uuid, epoch: uuid,
  kind: z.enum(["consent_granted", "sharing_stopped", "deletion_requested", "deletion_accepted", "deletion_completed"]),
  at: z.string().datetime().optional(), installationId: installationId.optional(), notice: z.string().optional(),
  requestId: uuid.optional(), completionDueAt: z.string().datetime().optional(),
  recovered: z.boolean().optional() });
export type PrivacyHistoryEntry = z.infer<typeof privacyHistoryEntry>;
export const telemetryStateSchema = z.strictObject({
  version: z.literal(1), consent: decision.optional(),
  identity: z.strictObject({ registrationId: uuid, sub: installationId.optional(), credentialCreated: z.boolean() }).optional(),
  pendingDeletes: z.array(uuid).max(100),
  remoteDeletion: z.strictObject({ epoch: uuid, registrationId: uuid, target: z.string(),
    installationId: installationId.optional(), requestedAt: z.string().datetime().optional(),
    status: z.enum(["pending", "accepted"]), receipt: deletionReceiptSchema.optional() }).optional(),
  privacyHistory: z.array(privacyHistoryEntry).optional(),
  outbox: z.array(queued), // Each project is bounded independently by the sender.
  operations: z.record(z.string(), z.strictObject({ epoch: uuid, kind: z.enum(["connection_created", "connection_tested", "configuration_saved", "invocation_submitted"]), at: z.string().datetime() })),
  runs: z.record(z.string(), z.strictObject({ epoch: uuid, operation: uuid, at: z.string().datetime(),
    outcome: z.enum(["complete", "failed", "cancelled"]).optional(), fetched: z.boolean() })),
  early: z.record(z.string(), z.strictObject({ outcome: z.enum(["complete", "failed", "cancelled"]), at: z.string().datetime() })),
  delivery: z.enum(["disabled", "not-configured", "registration-pending", "connected", "retrying", "credential-rejected", "credential-store-unavailable", "invalid-event"]),
  retryAt: z.number().nonnegative(), attempts: z.number().int().nonnegative(),
  lease: z.strictObject({ owner: uuid, until: z.number() }).optional(),
});
export type TelemetryState = z.infer<typeof telemetryStateSchema>;
export function recordPrivacyHistory(state: TelemetryState, entry: Omit<PrivacyHistoryEntry, "id">) {
  (state.privacyHistory ??= []).push({ id: randomUUID(), ...entry });
}
function recoverPrivacyHistory(state: TelemetryState) {
  if (state.privacyHistory !== undefined) return;
  state.privacyHistory = [];
  const consent = state.consent, deletion = state.remoteDeletion;
  // Deletion overwrote choice but did not update consent.at in older states.
  // That timestamp cannot be claimed as the time sharing stopped.
  if (consent && !(consent.choice === "declined" && deletion?.epoch === consent.epoch)) {
    recordPrivacyHistory(state, { epoch: consent.epoch, kind: consent.choice === "accepted" ? "consent_granted" : "sharing_stopped",
      at: consent.at, notice: consent.notice, installationId: state.identity?.sub, recovered: true });
  }
  if (deletion) {
    const common = { epoch: deletion.epoch, installationId: deletion.installationId ?? (consent?.epoch === deletion.epoch ? state.identity?.sub : undefined),
      requestId: deletion.receipt?.request_id, recovered: true };
    recordPrivacyHistory(state, { ...common, kind: "deletion_requested", at: deletion.requestedAt ?? deletion.receipt?.requested_at });
    if (deletion.receipt) recordPrivacyHistory(state, { ...common,
      kind: deletion.receipt.status === "data_removed" ? "deletion_completed" : "deletion_accepted",
      completionDueAt: deletion.receipt.completion_due_at }); // Acceptance/completion time was not saved.
  }
}
export function emptyTelemetryState(): TelemetryState {
  return { version: 1, pendingDeletes: [], outbox: [], operations: {}, runs: {}, early: {}, delivery: "disabled", retryAt: 0, attempts: 0 };
}
export function telemetryRoot(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/ArkiMux/telemetry");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), "ArkiMux/telemetry");
  const xdg = process.env.XDG_STATE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local/state"), "arkimux/telemetry");
}

/** One OS-user state transaction. Only filesystem work belongs inside the lock. */
export class TelemetryStateStore {
  constructor(readonly root: string, private now = Date.now) {}
  async update<T>(mutate: (state: TelemetryState) => T): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
    const file = path.join(this.root, "collector.sqlite");
    const db = new DatabaseSync(file);
    try {
      await chmod(file, 0o600);
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); BEGIN IMMEDIATE;");
      const row = db.prepare("SELECT payload FROM state WHERE id=1").get();
      const saved = row === undefined ? undefined : JSON.parse(String(row.payload));
      // Drop legacy error envelopes before validating the usage-only state. No
      // message/stack schema or sanitizer is needed to retire an error upload.
      if (saved && Array.isArray(saved.outbox)) saved.outbox = saved.outbox.filter((item: unknown) =>
        !(item && typeof item === "object" && "event" in item && item.event && typeof item.event === "object"
          && "kind" in item.event && item.event.kind === "arkimux.error.framework"));
      const state = saved === undefined ? emptyTelemetryState() : telemetryStateSchema.parse(saved);
      recoverPrivacyHistory(state);
      const oldest = this.now() - TELEMETRY_TTL;
      state.outbox = state.outbox.filter(item => Date.parse(item.event.event_time) >= oldest);
      for (const collection of [state.operations, state.runs, state.early]) {
        for (const [key, value] of Object.entries(collection)) if (Date.parse(value.at) < oldest) delete collection[key];
      }
      const result = mutate(state);
      telemetryStateSchema.parse(state);
      db.prepare("INSERT INTO state (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(state));
      db.exec("COMMIT");
      return result;
    } finally { db.close(); }
  }
}
