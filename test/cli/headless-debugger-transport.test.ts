import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  headlessDebuggerMessageLimit,
  runHeadlessDebuggerTransport,
  type HeadlessDebuggerClient,
} from "../../cli/src/headlessDebuggerCommand.ts";

function request(id: string, method = "session.inspect", params: unknown = {}, schemaVersion: 1 | 2 = 1) {
  return JSON.stringify({ schemaVersion, id, method, params });
}
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }

function fixture(overrides: Partial<HeadlessDebuggerClient> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const signals = new EventEmitter();
  let text = "";
  let errors = "";
  let notify!: (sessionId: string, revision: number) => void;
  output.on("data", (chunk) => { text += chunk.toString(); });
  diagnostics.on("data", (chunk) => { errors += chunk.toString(); });
  const client = {
    request: vi.fn(overrides.request ?? (async () => ({ sessionId: "example", revision: 1 }))),
    close: vi.fn(overrides.close ?? (async () => {})),
  };
  const result = runHeadlessDebuggerTransport({ input, output, diagnostics, signals,
    createClient: async (onChange) => { notify = onChange; return client; } });
  return { input, output, client, signals, result, notify: (revision: number) => notify("example", revision),
    responses: () => text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [],
    errors: () => errors };
}

describe("headless debugger JSON-lines transport", () => {
  it("accepts split UTF-8 requests and a final line without newline", async () => {
    const f = fixture();
    const params = { manifest: { schemaVersion: 1, sessionId: "city", workflowId: "weather", configurationId: "default",
      cases: [{ caseId: "city", input: { city: "İstanbul" }, expectations: [] }] },
    authorization: { executeProjectCode: true, allowProviderCharges: true, allowExternalEffects: true, discloseWorkflowData: true } };
    const bytes = Buffer.from(request("city", "session.create", params));
    const utf8 = bytes.indexOf(Buffer.from("İ"));
    f.input.write(bytes.subarray(0, utf8 + 1));
    f.input.end(bytes.subarray(utf8 + 1));
    expect(await f.result).toBe(0);
    expect(f.client.request).toHaveBeenCalledWith("session.create", params);
    expect(f.responses()).toEqual([{ schemaVersion: 1, id: "city", ok: true, result: { sessionId: "example", revision: 1 } }]);
    expect(f.client.close).toHaveBeenCalledOnce();
    expect(f.errors()).toBe("");
  });

  it("rejects malformed and unknown envelope fields without ending a usable stream", async () => {
    const f = fixture();
    f.input.end([
      "invalid json", "[]", request("bad-params", "session.inspect", []),
      JSON.stringify({ schemaVersion: 1, id: "extra", method: "session.inspect", params: {}, extra: true }),
      JSON.stringify({ schemaVersion: 3, id: "version", method: "session.inspect", params: {} }),
      request("method", "eval"), request("valid"), "",
    ].join("\n"));
    expect(await f.result).toBe(0);
    expect(f.responses().map((message) => [message.id, message.error?.code ?? "ok"])).toEqual([
      [null, "invalid_request"], [null, "invalid_request"], ["bad-params", "invalid_request"],
      ["extra", "invalid_request"], ["version", "unsupported_version"], ["method", "unsupported_operation"], ["valid", "ok"],
    ]);
    expect(f.client.request).toHaveBeenCalledTimes(1);
  });

  it("pins V2 only after a fully valid request and keeps replies and notifications on that version", async () => {
    const f = fixture();
    await tick();
    f.notify(1);
    f.notify(2);
    expect(f.responses()).toEqual([]); // No version has been selected yet.
    f.input.write(`${request("invalid-v1", "case.run", { caseId: "../invalid" })}\n`);
    await tick();
    f.input.write(`${request("inspect-v2", "debug.inspect", { caseId: "first" }, 2)}\n`);
    await tick();
    f.notify(3);
    f.input.end(`${request("mixed-v1")}\n${request("close-v2", "session.close", {}, 2)}\n`);
    expect(await f.result).toBe(0);
    expect(f.client.request.mock.calls).toEqual([["debug.inspect", { caseId: "first" }, 2], ["session.close", {}, 2]]);
    const responses = f.responses();
    expect(responses[0]).toMatchObject({ schemaVersion: 1, id: "invalid-v1", error: { code: "invalid_request" } });
    expect(responses.slice(1).every(message => message.schemaVersion === 2)).toBe(true);
    expect(responses.filter(message => message.event)).toEqual([
      { schemaVersion: 2, event: "session.changed", sessionId: "example", revision: 2 },
      { schemaVersion: 2, event: "session.changed", sessionId: "example", revision: 3 },
    ]);
    expect(responses.find(message => message.id === "mixed-v1")).toMatchObject({ error: { code: "unsupported_version" } });
  });

  it("does not select V2 for missing live disclosure permission and can still select V1", async () => {
    const f = fixture();
    f.input.end(`${request("unapproved", "session.create", { manifest: { schemaVersion: 2, sessionId: "live", workflowId: "fixture",
      configurationId: "default", debug: { stopOnEntry: true }, cases: [{ caseId: "first", input: {}, mocks: {}, expectations: [] }] },
    authorization: { executeProjectCode: true, allowProviderCharges: true, allowExternalEffects: true, discloseWorkflowData: true } }, 2)}\n${request("v1")}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses()).toEqual([
      expect.objectContaining({ schemaVersion: 2, id: "unapproved", error: expect.objectContaining({ code: "authorization_required" }) }),
      expect.objectContaining({ schemaVersion: 1, id: "v1", ok: true }),
    ]);
    expect(f.client.request.mock.calls).toEqual([["session.inspect", {}]]);
  });

  it("keeps the selected version after a valid request encounters an application error", async () => {
    const f = fixture({ request: async () => { throw { code: "session_version_mismatch", message: "Use the session's original protocol.", retry: "after_action" }; } });
    f.input.end(`${request("open-v2", "session.open", { sessionId: "old" }, 2)}\n${request("mixed-v1")}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses()).toEqual([
      expect.objectContaining({ schemaVersion: 2, id: "mixed-v1", error: expect.objectContaining({ code: "unsupported_version" }) }),
      expect.objectContaining({ schemaVersion: 2, id: "open-v2", error: expect.objectContaining({ code: "session_version_mismatch", retry: "after_action" }) }),
    ]);
    expect(f.client.request.mock.calls).toEqual([["session.open", { sessionId: "old" }, 2]]);
  });

  it("rejects live controls on V1 and invalid V2 controls before dispatch", async () => {
    const f = fixture();
    f.input.end(`${request("v1-step", "debug.step", { caseId: "first", pauseId: "pause", controlId: "control", kind: "into" })}\n${request("bad-v2-step", "debug.step", {
      caseId: "first", pauseId: "pause", controlId: "control", kind: "evaluate",
    }, 2)}\n${request("good-v2-step", "debug.step", { caseId: "first", pauseId: "pause", controlId: "control", kind: "over" }, 2)}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses().map(message => [message.id, message.error?.code ?? "ok"])).toEqual([
      ["v1-step", "unsupported_operation"], ["bad-v2-step", "invalid_request"], ["good-v2-step", "ok"],
    ]);
    expect(f.client.request.mock.calls).toEqual([["debug.step", { caseId: "first", pauseId: "pause", controlId: "control", kind: "over" }, 2]]);
  });

  it("uses V2 for oversized-response and malformed-input errors after selection", async () => {
    const f = fixture({ request: async () => ({ large: "x".repeat(headlessDebuggerMessageLimit) }) });
    f.input.end(`${request("large", "debug.inspect", { caseId: "first" }, 2)}\nnot-json\n`);
    expect(await f.result).toBe(0);
    expect(f.responses().every(message => message.schemaVersion === 2)).toBe(true);
    expect(f.responses().map(message => message.error.code).sort()).toEqual(["evidence_too_large", "invalid_request"]);
  });

  it("rejects invalid UTF-8 instead of replacing bytes", async () => {
    const f = fixture();
    f.input.end(Buffer.concat([Buffer.from('{"schemaVersion":1,"id":"'), Buffer.from([0xff]), Buffer.from('","method":"session.inspect","params":{}}\n')]));
    expect(await f.result).toBe(0);
    expect(f.responses()[0]).toMatchObject({ id: null, error: { code: "invalid_request" } });
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it("keeps IDs outstanding until their responses are flushed, while allowing concurrent cancellation", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ request: async (method) => {
      if (method === "case.run") await wait;
      if (method === "case.cancel") release();
      return { method };
    } });
    f.input.write(`${request("run", "case.run", { caseId: "first" })}\n`);
    await tick();
    f.input.end(`${request("run")}\n${request("cancel", "case.cancel", { caseId: "first" })}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses().filter((message) => message.error?.code === "invalid_request")).toHaveLength(1);
    expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(["case.run", "case.cancel"]);
    expect(f.responses().filter((message) => message.ok)).toHaveLength(2);
  });

  it("rejects oversized UTF-8 input and closes after cleanup", async () => {
    const f = fixture();
    f.input.write(Buffer.alloc(headlessDebuggerMessageLimit, 0x20));
    f.input.write(Buffer.from("é"));
    expect(await f.result).toBe(2);
    expect(f.responses()).toEqual([expect.objectContaining({ id: null, error: expect.objectContaining({ code: "message_too_large" }) })]);
    expect(f.client.request).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("returns bounded response errors and leaves evidence paging available", async () => {
    const f = fixture({ request: async (method) => method === "session.inspect"
      ? { large: "é".repeat(headlessDebuggerMessageLimit) } : { data: "aGVsbG8=" } });
    f.input.end(`${request("large")}\n${request("page", "evidence.read", { caseId: "first", evidenceId: "input", offset: 0, limit: 5 })}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses()).toEqual([
      expect.objectContaining({ id: "large", error: expect.objectContaining({ code: "evidence_too_large" }) }),
      expect.objectContaining({ id: "page", ok: true, result: { data: "aGVsbG8=" } }),
    ]);
    expect(f.responses().every((value) => Buffer.byteLength(JSON.stringify(value)) <= headlessDebuggerMessageLimit)).toBe(true);
  });

  it("passes only safe public errors and does not expose arbitrary thrown data", async () => {
    const f = fixture({ request: async (_method, params) => {
      if ((params as any).sessionId === "safe") throw { code: "case_busy", message: "Another case is running.", retry: "after_action" };
      throw new Error("secret-key /private/project provider raw output");
    } });
    f.input.end(`${request("unsafe")}\n${request("safe", "session.open", { sessionId: "safe" })}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses()).toEqual([
      expect.objectContaining({ id: "unsafe", error: expect.objectContaining({ code: "internal_error", retry: "same_identity" }) }),
      expect.objectContaining({ id: "safe", error: { code: "case_busy", message: "Another case is running.", retry: "after_action" } }),
    ]);
    expect(JSON.stringify(f.responses()) + f.errors()).not.toMatch(/secret-key|private\/project|provider raw/);
  });

  it("emits optional revisions and stops processing lines after session.close", async () => {
    const f = fixture();
    await tick();
    f.notify(2);
    f.input.write(`${request("close", "session.close")}\n${request("ignored", "case.run", { caseId: "first" })}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses()).toEqual([
      { schemaVersion: 1, event: "session.changed", sessionId: "example", revision: 2 },
      expect.objectContaining({ id: "close", ok: true }),
    ]);
    expect(f.client.request).toHaveBeenCalledTimes(1);
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("rejects invalid close params without closing an otherwise usable connection", async () => {
    const f = fixture();
    f.input.end(`${request("invalid-close", "session.close", { arbitrary: true })}\n${request("still-open")}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses()).toEqual([
      expect.objectContaining({ id: "invalid-close", error: expect.objectContaining({ code: "invalid_request" }) }),
      expect.objectContaining({ id: "still-open", ok: true }),
    ]);
    expect(f.client.request).toHaveBeenCalledTimes(1);
  });

  it("keeps even the error response below the byte cap for a near-limit request ID", async () => {
    const f = fixture({ request: async () => "é".repeat(headlessDebuggerMessageLimit) });
    const prefix = request("");
    const id = "q".repeat(headlessDebuggerMessageLimit - Buffer.byteLength(prefix));
    f.input.end(`${request(id)}\n`);
    expect(await f.result).toBe(0);
    expect(f.responses()[0]).toMatchObject({ id: null, error: { code: "message_too_large" } });
    expect(Buffer.byteLength(JSON.stringify(f.responses()[0]))).toBeLessThan(headlessDebuggerMessageLimit);
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("cleans up on %s and reports its signal exit code", async (signal, code) => {
    const f = fixture();
    await tick();
    f.signals.emit(signal);
    expect(await f.result).toBe(code);
    expect(f.client.close).toHaveBeenCalledOnce();
    expect(f.signals.listenerCount(signal)).toBe(0);
  });

  it("reports cleanup failure without exposing its original exception", async () => {
    const f = fixture({ close: async () => { throw new Error("private filesystem information"); } });
    f.input.end();
    expect(await f.result).toBe(1);
    expect(f.errors()).toBe("Diagnostic cleanup could not be confirmed.\n");
  });

  it("attempts cleanup if the protocol output becomes unavailable", async () => {
    const input = new PassThrough();
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("broken pipe")); } });
    const close = vi.fn(async () => {});
    const result = runHeadlessDebuggerTransport({ input, output, diagnostics: new PassThrough(),
      createClient: async () => ({ request: async () => ({}), close }) });
    input.write(`${request("one")}\n`);
    expect(await result).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([["eof", 0], ["SIGINT", 130], ["SIGTERM", 143], ["output-error", 1]] as const)("aborts an outstanding response on %s before waiting for its reply", async (trigger, code) => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ request: async () => {
      await waiting;
      throw { code: "run_terminal", message: "The case was stopped before its answer was accepted.", retry: "after_action" };
    }, close: async () => { release(); } });
    f.input.write(`${request("answer", "case.respond", { caseId: "first", requestId: "request", submissionId: "answer", expectedRevision: 1,
      response: { schemaVersion: 1, fields: {}, files: {} } })}\n`);
    await tick();
    expect(f.client.request).toHaveBeenCalledOnce();
    if (trigger === "eof") f.input.end();
    else if (trigger === "output-error") f.output.emit("error", new Error("private broken output"));
    else f.signals.emit(trigger);
    expect(await f.result).toBe(code);
    expect(f.client.close).toHaveBeenCalledOnce();
    if (trigger !== "output-error") expect(f.responses()).toEqual([
      expect.objectContaining({ id: "answer", ok: false, error: expect.objectContaining({ code: "run_terminal" }) }),
    ]);
  });

  it("finishes cleanup after output emits an error without invoking the write callback", async () => {
    const input = new PassThrough();
    const output = new Writable({ write(_chunk, _encoding, _callback) {
      setImmediate(() => output.emit("error", new Error("disconnected output")));
    } });
    const close = vi.fn(async () => {});
    const result = runHeadlessDebuggerTransport({ input, output, diagnostics: new PassThrough(),
      createClient: async () => ({ request: async () => ({}), close }) });
    input.write(`${request("one")}\n`);
    expect(await result).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });
});
