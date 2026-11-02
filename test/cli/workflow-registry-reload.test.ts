import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { LocalRegistryUnavailable, LocalWorkflowRegistryReload } from "../../local/src/workflowRegistryReload.ts";
import type { WorkflowRegistrySourceDiagnostic } from "../../local/src/workflowRegistryReload.ts";
import type { LocalWorkflowRegistration } from "../../local/src/index.ts";

const workflow = { kind: "weather-advisor", version: 1 };
function fixture(name: string) {
  const execute = vi.fn(async () => {}), release = vi.fn(async () => {});
  const registration: LocalWorkflowRegistration = { workflow, title: name, validateInput: input => input,
    reserve: async () => ({ executionId: name }), execute,
    runConfigurationValidator: { workflow, validate: value => ({ ...value as object, configurationId: name, workflow }) } };
  return { workflows: [registration], release, execute };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const command = { runRef: { executionId: "run-1" }, workflow,
  actor: { userId: "local-developer", roleId: "developer-v1" }, input: {},
  runConfiguration: { configurationId: "config-v1", contentHash: "a".repeat(64) } };
function sourceDiagnostic(): WorkflowRegistrySourceDiagnostic {
  return { kind: "source", code: "TS1109", message: "Expression expected.", file: "src/workflow-registry.ts", line: 7, column: 12 };
}

describe("Local registry generation controller", () => {
  it("switches workflows and validators together, releases the previous generation", async () => {
    const reconcile = vi.fn(async () => {}), owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile });
    const first = fixture("first"), second = fixture("second");
    await owner.activateCandidate(owner.prepareCandidate(first));
    expect(owner.workflows.list()[0].title).toBe("first");
    await owner.activateCandidate(owner.prepareCandidate(second));
    expect(owner.workflows.list()[0].title).toBe("second");
    expect(owner.validators.validate({ workflow }).configurationId).toBe("second");
    expect(owner.status()).toEqual({ revision: 2, status: "ready" });
    expect(first.release).toHaveBeenCalledOnce();
    await owner.close();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("keeps one generation across a real Hono request, await and queued dispatch", async () => {
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile: async () => {} });
    const first = fixture("first"), second = fixture("second"), entered = gate(), proceed = gate();
    await owner.activateCandidate(owner.prepareCandidate(first));
    const app = new Hono();
    app.use("*", (_c, next) => owner.withRequest(next));
    app.post("/submit", async c => {
      const selected = owner.workflows.resolve(workflow);
      const before = owner.validators.validate({ workflow }).configurationId;
      entered.release(); await proceed.promise;
      await selected.reserve({ actor: command.actor, workflow, input: {}, resolvedConfiguration: {
        configuration: { configurationId: "config-v1", workflow }, contentHash: "a".repeat(64) } });
      queueMicrotask(() => void owner.workflows.execute(command));
      const after = owner.validators.validate({ workflow }).configurationId;
      return c.json({ before, after });
    });
    const response = app.request("/submit", { method: "POST" });
    await entered.promise;
    const replacing = owner.activateCandidate(owner.prepareCandidate(second));
    await vi.waitFor(() => expect(owner.status().status).toBe("waiting"));
    proceed.release();
    expect(await (await response).json()).toEqual({ before: "first", after: "first" });
    await replacing;
    expect(first.execute).toHaveBeenCalledOnce(); expect(second.execute).not.toHaveBeenCalled();
    expect(owner.workflows.list()[0].title).toBe("second");
    await owner.close();
  });

  it("waits for active background compute, not a suspended stored Run", async () => {
    let idle = true;
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => idle, reconcile: async () => {} });
    await owner.activateCandidate(owner.prepareCandidate(fixture("first")));
    idle = false;
    const replacing = owner.activateCandidate(owner.prepareCandidate(fixture("second")));
    await vi.waitFor(() => expect(owner.status().status).toBe("waiting"));
    expect(owner.workflows.list()[0].title).toBe("first");
    idle = true; // Suspension ends compute, while its persisted Run remains.
    await replacing;
    expect(owner.workflows.list()[0].title).toBe("second");
    await owner.close();
  });

  it("invalid candidates cannot replace the last good validator or execution", async () => {
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile: async () => {} });
    const first = fixture("first"); await owner.activateCandidate(owner.prepareCandidate(first));
    const invalid = fixture("invalid");
    invalid.workflows[0].runConfigurationValidator = { ...invalid.workflows[0].runConfigurationValidator, workflow: { kind: "other", version: 1 } };
    expect(() => owner.prepareCandidate(invalid)).toThrow("identities differ");
    owner.failed();
    await owner.withRequest(() => owner.workflows.execute(command));
    expect(first.execute).toHaveBeenCalledOnce();
    expect(owner.validators.validate({ workflow }).configurationId).toBe("first");
    expect(owner.status()).toMatchObject({ revision: 1, status: "error" });
    await owner.close();
  });

  it("copies only source diagnostic fields, keeps last-good execution, and clears the error on recovery", async () => {
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile: async () => {} });
    const first = fixture("first"), expected = sourceDiagnostic();
    await owner.activateCandidate(owner.prepareCandidate(first));
    const reported = { ...expected, stack: "SECRET_STACK", raw: { source: "SECRET_SOURCE" } };
    owner.failed(false, reported);
    expect(owner.status()).toMatchObject({ revision: 1, status: "error", restartRequired: false, diagnostic: expected });
    expect(owner.status().diagnostic).toEqual(expected);
    expect(JSON.stringify(owner.status())).not.toContain("SECRET");
    reported.message = "mutated input";
    const snapshot = owner.status(); snapshot.diagnostic!.message = "mutated output";
    expect(owner.status().diagnostic).toEqual(expected);
    await owner.withRequest(() => owner.workflows.execute(command));
    expect(first.execute).toHaveBeenCalledOnce();
    expect(first.release).not.toHaveBeenCalled();
    expect(owner.validators.validate({ workflow }).configurationId).toBe("first");
    owner.validating();
    expect(owner.status()).toEqual({ revision: 1, status: "validating" });
    owner.failed(false, expected);
    await owner.activateCandidate(owner.prepareCandidate(fixture("second")));
    expect(owner.status()).toEqual({ revision: 2, status: "ready" });
    await owner.close();
  });

  it.each(["src/workflow definitions/registry.ts", "workflows/weather advisor.ts"])("allows safe relative paths with spaces: %s", file => {
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile: async () => {} });
    const diagnostic = { kind: "source" as const, code: "INVALID_WORKFLOW", message: "Invalid workflow declaration.", file };
    owner.failed(false, diagnostic);
    expect(owner.status().diagnostic).toEqual(diagnostic);
  });

  it("accepts the maximum diagnostic field lengths and safe coordinates", () => {
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile: async () => {} });
    const diagnostic = { kind: "source" as const, code: "C".repeat(64), message: "M".repeat(1000),
      file: `src/${"f".repeat(508)}`, line: Number.MAX_SAFE_INTEGER, column: Number.MAX_SAFE_INTEGER };
    owner.failed(false, diagnostic);
    expect(owner.status().diagnostic).toEqual(diagnostic);
  });

  it.each([
    ["null", null], ["string", "raw source error"], ["array", []], ["missing fields", {}],
    ["wrong kind", { ...sourceDiagnostic(), kind: "runtime" }],
    ["empty code", { ...sourceDiagnostic(), code: "" }], ["long code", { ...sourceDiagnostic(), code: "C".repeat(65) }],
    ["non-string code", { ...sourceDiagnostic(), code: 1109 }],
    ["newline code", { ...sourceDiagnostic(), code: "TS1109\n" }],
    ["ANSI code", { ...sourceDiagnostic(), code: "\u001b[31mTS1109" }],
    ["control code", { ...sourceDiagnostic(), code: "TS\u009f1109" }],
    ["empty message", { ...sourceDiagnostic(), message: "" }], ["long message", { ...sourceDiagnostic(), message: "M".repeat(1001) }],
    ["non-string message", { ...sourceDiagnostic(), message: new Error("SECRET") }],
    ["newline message", { ...sourceDiagnostic(), message: "Expression\nexpected." }],
    ["ANSI message", { ...sourceDiagnostic(), message: "\u001b[31mExpression expected." }],
    ["control message", { ...sourceDiagnostic(), message: "Expression expected.\u007f" }],
    ["empty file", { ...sourceDiagnostic(), file: "" }], ["long file", { ...sourceDiagnostic(), file: `src/${"f".repeat(509)}` }],
    ["absolute file", { ...sourceDiagnostic(), file: "/Users/private/src/workflow.ts" }],
    ["unapproved root", { ...sourceDiagnostic(), file: "node_modules/package/index.ts" }],
    ["parent component", { ...sourceDiagnostic(), file: "src/../secret.ts" }],
    ["current component", { ...sourceDiagnostic(), file: "src/./registry.ts" }],
    ["empty component", { ...sourceDiagnostic(), file: "src//registry.ts" }],
    ["missing filename", { ...sourceDiagnostic(), file: "src/" }],
    ["backslash", { ...sourceDiagnostic(), file: "src/folder\\registry.ts" }],
    ["control character", { ...sourceDiagnostic(), file: "src/registry\u0000.ts" }],
    ["line only", { ...sourceDiagnostic(), column: undefined }], ["column only", { ...sourceDiagnostic(), line: undefined }],
    ["zero line", { ...sourceDiagnostic(), line: 0 }], ["negative column", { ...sourceDiagnostic(), column: -1 }],
    ["fractional line", { ...sourceDiagnostic(), line: 1.5 }], ["unsafe column", { ...sourceDiagnostic(), column: Number.MAX_SAFE_INTEGER + 1 }],
    ["infinite line", { ...sourceDiagnostic(), line: Infinity }], ["string column", { ...sourceDiagnostic(), column: "12" }],
    ["null coordinates", { ...sourceDiagnostic(), line: null, column: null }],
    ["throwing field", { ...sourceDiagnostic(), get message() { throw new Error("SECRET"); } }],
  ])("falls back to the generic error for malformed diagnostics: %s", (_name, diagnostic) => {
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile: async () => {} });
    owner.failed();
    const generic = owner.status();
    owner.failed(false, sourceDiagnostic());
    owner.failed(false, diagnostic as WorkflowRegistrySourceDiagnostic);
    expect(owner.status()).toEqual(generic);
  });

  it("does not attach source diagnostics to restart-required or closed states", async () => {
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile: async () => {} });
    owner.failed(false, sourceDiagnostic());
    owner.failed(true, sourceDiagnostic());
    expect(owner.status()).toMatchObject({ revision: 0, status: "error", restartRequired: true });
    expect(owner.status().diagnostic).toBeUndefined();
    expect(owner.status().message).toContain("Restart the Local server");
    const stopped = owner.status(); owner.stop();
    owner.failed(false, sourceDiagnostic());
    expect(owner.status()).toEqual(stopped);
    await owner.close();
  });

  it("keeps old state on restored permission failure without leaking raw details", async () => {
    const reconcile = vi.fn(async () => {}), owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile });
    await owner.activateCandidate(owner.prepareCandidate(fixture("first")));
    const second = fixture("second"); reconcile.mockRejectedValueOnce(new Error("SECRET_INTERNAL_PATH"));
    await expect(owner.activateCandidate(owner.prepareCandidate(second))).rejects.toThrow("SECRET_INTERNAL_PATH");
    expect(owner.workflows.list()[0].title).toBe("first");
    expect(JSON.stringify(owner.status())).not.toContain("SECRET_INTERNAL_PATH");
    expect(second.release).toHaveBeenCalledOnce();
    await expect(owner.withRequest(async () => true)).resolves.toBe(true);
    await owner.close();
  });

  it("gates requests during permission writes and fails closed if rollback fails", async () => {
    const reconcile = vi.fn(async () => {}), owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile });
    await owner.activateCandidate(owner.prepareCandidate(fixture("first")));
    const entered = gate(), proceed = gate(), request = vi.fn(async () => true);
    reconcile.mockImplementationOnce(async () => { entered.release(); await proceed.promise; throw Object.assign(new Error("internal"), { restartRequired: true }); });
    const replacing = owner.activateCandidate(owner.prepareCandidate(fixture("second"))).catch(error => error);
    await entered.promise;
    const pending = owner.withRequest(request).catch(error => error);
    expect(request).not.toHaveBeenCalled(); proceed.release();
    await replacing;
    expect(await pending).toBeInstanceOf(LocalRegistryUnavailable);
    expect(request).not.toHaveBeenCalled();
    expect(owner.status()).toMatchObject({ revision: 1, status: "error", restartRequired: true });
    const fault = owner.status();
    owner.failed(false, sourceDiagnostic());
    owner.failed(true, sourceDiagnostic());
    owner.validating();
    expect(owner.status()).toEqual(fault);
    expect(owner.status().diagnostic).toBeUndefined();
    await owner.close();
  });

  it("discards stale candidates while waiting and on saves during permission writes", async () => {
    const reconcile = vi.fn(async (_workflows: readonly LocalWorkflowRegistration[]) => {}), owner = new LocalWorkflowRegistryReload({ isIdle: () => true, reconcile });
    const first = fixture("first"), second = fixture("second");
    await owner.activateCandidate(owner.prepareCandidate(first));
    let current = true;
    reconcile.mockImplementationOnce(async () => { current = false; });
    expect(await owner.activateCandidate(owner.prepareCandidate(second), () => current)).toBe(false);
    expect(reconcile.mock.calls.at(-1)?.[0]).toEqual(first.workflows);
    expect(owner.workflows.list()[0].title).toBe("first");
    expect(second.release).toHaveBeenCalledOnce();
    await owner.close();
  });

  it("stop interrupts a waiting candidate and releases both candidates once", async () => {
    let idle = true;
    const owner = new LocalWorkflowRegistryReload({ isIdle: () => idle, reconcile: async () => {} });
    const first = fixture("first"), second = fixture("second");
    await owner.activateCandidate(owner.prepareCandidate(first)); idle = false;
    const replacing = owner.activateCandidate(owner.prepareCandidate(second));
    await vi.waitFor(() => expect(owner.status().status).toBe("waiting"));
    await owner.close();
    expect(await replacing).toBe(false);
    expect(first.release).toHaveBeenCalledOnce(); expect(second.release).toHaveBeenCalledOnce();
    await expect(owner.withRequest(async () => {})).rejects.toBeInstanceOf(LocalRegistryUnavailable);
  });
});
