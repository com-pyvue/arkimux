import { describe, expect, it } from "vitest";
import {
  HeadlessDebuggerError, compareExpectations, headlessManifestSchema, headlessRequestSchema,
  isHeadlessJson, parseHeadlessAuthorization, parseHeadlessManifest, parseHeadlessRequest, sanitizeEvidence,
  resolveHeadlessExecutionBudget,
  type HeadlessExpectation,
} from "../../local/src/headlessDebuggerContracts.ts";

const authorization = { executeProjectCode: true, allowProviderCharges: true, allowExternalEffects: true, discloseWorkflowData: true };
const manifest = () => ({ schemaVersion: 1, sessionId: "check-1", workflowId: "weather-advisor", configurationId: "weather-default-v1",
  cases: [{ caseId: "istanbul", input: { city: "Istanbul" }, expectations: [{ id: "completed", target: "run-status", operator: "equals", value: "complete" }] }] });
const request = (method: string, params: unknown) => ({ schemaVersion: 1, id: "q1", method, params });
const resultExpectation = (value: unknown, pointer = "") => ({ id: "result", target: "result", operator: "equals", pointer, value }) as HeadlessExpectation;
const compare = (expectations: HeadlessExpectation[], resultPayload: unknown) => compareExpectations(expectations,
  { terminal: true, runStatus: "complete", resultAvailable: true, resultPayload });
function errorCode(action: () => unknown, code: string) {
  try { action(); throw new Error("Expected an error."); } catch (error) {
    expect(error).toBeInstanceOf(HeadlessDebuggerError);
    expect((error as HeadlessDebuggerError).code).toBe(code);
  }
}

describe("headless debugger contracts", () => {
  it("accepts and detaches exact manifests and all supported request params", () => {
    const original = manifest(), parsed = parseHeadlessManifest(original);
    original.cases[0]!.input.city = "changed";
    expect(parsed.cases[0]!.input).toEqual({ city: "Istanbul" });
    for (const [method, params] of [
      ["session.create", { manifest: manifest(), authorization }], ["session.open", { sessionId: "check-1" }],
      ["session.inspect", {}], ["case.run", { caseId: "istanbul" }], ["case.cancel", { caseId: "istanbul" }],
      ["case.respond", { caseId: "istanbul", requestId: "request-1", submissionId: "submit-1", expectedRevision: 1,
        response: { schemaVersion: 1, fields: { answer: "yes", count: 2, confirmed: true }, files: {} } }],
      ["evidence.read", { caseId: "istanbul", evidenceId: "item-1", offset: 0, limit: 262144 }], ["session.close", {}],
    ] as const) expect(parseHeadlessRequest(request(method, params)).method).toBe(method);
  });

  it("rejects unknown fields, methods, missing values, unsupported versions and coercion", () => {
    for (const candidate of [
      { ...request("session.inspect", {}), surprise: true }, request("session.inspect", { sessionId: "other" }),
      request("session.delete", {}), request("case.run", { caseId: "UPPER" }), request("case.run", { caseId: "../escape" }),
      request("evidence.read", { caseId: "a", evidenceId: "../escape", offset: 0, limit: 1 }),
      request("evidence.read", { caseId: "a", evidenceId: "item", offset: "0", limit: 1 }),
      request("evidence.read", { caseId: "a", evidenceId: "item", offset: 0, limit: 262145 }),
      request("evidence.read", { caseId: "a", evidenceId: "item", offset: -1, limit: 0 }),
      request("session.open", {}), { ...request("session.inspect", {}), id: "" },
    ]) errorCode(() => parseHeadlessRequest(candidate), "invalid_request");
    errorCode(() => parseHeadlessRequest({ ...request("session.inspect", {}), schemaVersion: 3 }), "unsupported_version");
    expect(headlessRequestSchema.safeParse(request("session.inspect", { extra: true })).success).toBe(false);
  });

  it("requires every explicit acknowledgement without accepting unknown permission fields", () => {
    expect(parseHeadlessAuthorization(authorization)).toEqual(authorization);
    for (const key of Object.keys(authorization)) {
      errorCode(() => parseHeadlessAuthorization({ ...authorization, [key]: false }), "authorization_required");
      const missing = { ...authorization } as Record<string, unknown>; delete missing[key];
      errorCode(() => parseHeadlessRequest(request("session.create", { manifest: manifest(), authorization: missing })), "authorization_required");
    }
    errorCode(() => parseHeadlessRequest(request("session.create", { manifest: manifest() })), "authorization_required");
    errorCode(() => parseHeadlessAuthorization({ ...authorization, editCode: true }), "invalid_request");
  });

  it("rejects empty and duplicate case sets or expectation IDs", () => {
    const duplicateCase = manifest(); duplicateCase.cases.push(duplicateCase.cases[0]!);
    const duplicateExpectation = manifest(); duplicateExpectation.cases[0]!.expectations.push(duplicateExpectation.cases[0]!.expectations[0]!);
    for (const candidate of [{ ...manifest(), cases: [] }, duplicateCase, duplicateExpectation,
      { ...manifest(), sessionId: "a".repeat(65) }, { ...manifest(), unknown: true }]) {
      errorCode(() => parseHeadlessManifest(candidate), "invalid_request");
    }
  });

  it("accepts empty expectations, but validates exact expectation shapes and RFC-6901 syntax", () => {
    const withExpectations = (expectations: unknown[]) => ({ ...manifest(), cases: [{ caseId: "case", input: null, expectations }] });
    for (const pointer of ["", "/", "/a~1b/~0", "/~01"]) expect(headlessManifestSchema.safeParse(withExpectations([resultExpectation(null, pointer)])).success).toBe(true);
    for (const pointer of ["a", "#/a", "/a~", "/a~2"]) expect(headlessManifestSchema.safeParse(withExpectations([resultExpectation(null, pointer)])).success).toBe(false);
    expect(parseHeadlessManifest(withExpectations([])).cases[0]!.expectations).toEqual([]);
    for (const expectation of [
      { id: "x", target: "result", pointer: "", operator: "exists", value: null },
      { id: "x", target: "run-status", operator: "equals", value: "suspended" },
      { id: "x", target: "result", pointer: "", operator: "equals" },
    ]) expect(headlessManifestSchema.safeParse(withExpectations([expectation])).success).toBe(false);
  });

  it("rejects non-JSON values, getters, prototypes, sparse arrays and cycles without executing them", () => {
    let getterCalls = 0;
    const getter = Object.defineProperty({}, "value", { enumerable: true, get() { getterCalls++; return "no"; } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const hidden = Object.defineProperty({}, "hidden", { value: 1 });
    for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), new Map(), Object.create({ inherited: true }),
      [1, , 2], Object.assign([], { extra: 1 }), { [Symbol("secret")]: "secret" }, getter, hidden, cycle]) {
      expect(isHeadlessJson(value)).toBe(false);
      errorCode(() => parseHeadlessManifest({ ...manifest(), cases: [{ caseId: "x", input: value, expectations: [] }] }), "invalid_request");
    }
    expect(getterCalls).toBe(0);
    const shared = { x: 1 };
    expect(isHeadlessJson({ a: shared, b: shared })).toBe(true);
  });

  it("validates response envelope exactly while leaving declared form validation to the runtime", () => {
    const base = { caseId: "x", requestId: "request", submissionId: "submission", expectedRevision: 1 };
    for (const response of [{ schemaVersion: 1, fields: {}, files: {}, unknown: true }, { schemaVersion: 1, fields: { x: null }, files: {} },
      { schemaVersion: 1, fields: {}, files: { file: [{ objectId: "x", byteLength: 2, mediaType: "text/plain", sha256: "bad" }] } }]) {
      errorCode(() => parseHeadlessRequest(request("case.respond", { ...base, response })), "invalid_request");
    }
    expect(parseHeadlessRequest(request("case.respond", { ...base, response: { schemaVersion: 1, fields: {}, files: {
      attachment: [{ objectId: "file", byteLength: 2, mediaType: "text/plain", sha256: "a".repeat(64) }],
    } } })).method).toBe("case.respond"); // The coordinator rejects uploads as unsupported, without a receipt.
  });
});

describe("headless execution budget", () => {
  const permissions = () => parseHeadlessAuthorization(authorization);
  const budgetManifest = (executionBudgetMs: number) => parseHeadlessManifest({ ...manifest(), executionBudgetMs });

  it("uses the workflow default with an internal reserve inside the total", () => {
    expect(resolveHeadlessExecutionBudget(60_000, parseHeadlessManifest(manifest()), permissions()))
      .toEqual({ totalMs: 60_000, attemptMs: 60_000, finalizationReserveMs: 5_000 });
    expect(resolveHeadlessExecutionBudget(1_009, parseHeadlessManifest(manifest()), permissions()))
      .toEqual({ totalMs: 1_009, attemptMs: 1_009, finalizationReserveMs: 100 });
    expect(resolveHeadlessExecutionBudget(10, parseHeadlessManifest(manifest()), permissions()))
      .toEqual({ totalMs: 10, attemptMs: 10, finalizationReserveMs: 1 });
  });

  it("requires the optional explicit permission only for a larger budget", () => {
    const increased = budgetManifest(180_000);
    errorCode(() => resolveHeadlessExecutionBudget(60_000, increased, permissions()), "authorization_required");
    const approved = parseHeadlessAuthorization({ ...authorization, increaseExecutionBudget: true });
    expect(resolveHeadlessExecutionBudget(60_000, increased, approved))
      .toEqual({ totalMs: 180_000, attemptMs: 180_000, finalizationReserveMs: 5_000 });
    expect(resolveHeadlessExecutionBudget(60_000, budgetManifest(30_000), permissions()))
      .toEqual({ totalMs: 30_000, attemptMs: 30_000, finalizationReserveMs: 3_000 });
    expect(resolveHeadlessExecutionBudget(60_000, budgetManifest(60_000), permissions()).totalMs).toBe(60_000);
    expect(parseHeadlessRequest(request("session.create", { manifest: increased, authorization: approved })).method).toBe("session.create");
    errorCode(() => parseHeadlessAuthorization({ ...authorization, increaseExecutionBudget: false }), "invalid_request");
    errorCode(() => parseHeadlessAuthorization({ ...authorization, increaseExecutionBudget: "true" }), "invalid_request");
    errorCode(() => parseHeadlessAuthorization({ ...approved, executeProjectCode: false }), "authorization_required");
  });

  it("rejects invalid budgets and preserves the existing safe-integer domain", () => {
    for (const invalid of [0, -1, 9, 10.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      errorCode(() => resolveHeadlessExecutionBudget(invalid, parseHeadlessManifest(manifest()), permissions()), "configuration_invalid");
      errorCode(() => budgetManifest(invalid), "invalid_request");
    }
    errorCode(() => parseHeadlessManifest({ ...manifest(), executionBudgetMs: "60000" }), "invalid_request");
    expect(resolveHeadlessExecutionBudget(Number.MAX_SAFE_INTEGER, budgetManifest(Number.MAX_SAFE_INTEGER), permissions()))
      .toEqual({ totalMs: Number.MAX_SAFE_INTEGER, attemptMs: Number.MAX_SAFE_INTEGER, finalizationReserveMs: 5_000 });
  });

  it("has no operation that increases a live or reopened session budget", () => {
    for (const [method, params] of [
      ["session.open", { sessionId: "check-1", executionBudgetMs: 180_000 }],
      ["session.inspect", { executionBudgetMs: 180_000 }],
      ["case.run", { caseId: "istanbul", executionBudgetMs: 180_000 }],
      ["case.run", { caseId: "istanbul", authorization: { increaseExecutionBudget: true } }],
      ["session.update", { sessionId: "check-1", executionBudgetMs: 180_000 }],
    ]) errorCode(() => parseHeadlessRequest(request(method as string, params)), "invalid_request");
    const draft = { ...manifest(), executionBudgetMs: 30_000 };
    const parsed = parseHeadlessManifest(draft), budget = resolveHeadlessExecutionBudget(60_000, parsed, permissions());
    draft.executionBudgetMs = 180_000;
    expect(parsed.executionBudgetMs).toBe(30_000);
    expect(budget.totalMs).toBe(30_000);
  });
});

describe("live headless debugger V2 contracts", () => {
  const liveManifest = () => {
    const base = manifest();
    return { ...base, schemaVersion: 2, debug: { stopOnEntry: true }, cases: base.cases.map(item => ({ ...item, mocks: {} })) };
  };
  const liveAuthorization = { executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true, allowSimulatedEvaluation: true };
  const liveRequest = (method: string, params: unknown) => ({ schemaVersion: 2, id: "live-1", method, params });
  const liveParams: [string, Record<string, unknown>][] = [
    ["debug.sources", { offset: 0, limit: 100 }],
    ["debug.source.read", { sourceId: "source-1", offset: 0, limit: 262144 }],
    ["debug.breakpoints.set", { expectedDebuggerRevision: 0, breakpoints: [{ breakpointId: "breakpoint-1", sourceId: "source-1", line: 1, column: 1 }] }],
    ["debug.inspect", { caseId: "case-1" }],
    ["debug.pause", { caseId: "case-1", attemptId: "attempt-1", controlId: "control-1" }],
    ["debug.continue", { caseId: "case-1", pauseId: "pause-1", controlId: "control-2" }],
    ["debug.step", { caseId: "case-1", pauseId: "pause-1", controlId: "control-3", kind: "into" }],
    ["debug.stack", { caseId: "case-1", pauseId: "pause-1", offset: 0, limit: 100 }],
    ["debug.scopes", { caseId: "case-1", pauseId: "pause-1", frameId: "frame-1" }],
    ["debug.properties", { caseId: "case-1", pauseId: "pause-1", objectId: "object-1", offset: 0, limit: 100 }],
    ["debug.evaluate", { caseId: "case-1", pauseId: "pause-1", frameId: "frame-1", evaluationId: "evaluation-1", expression: "result + 1" }],
    ["debug.variable.set", { caseId: "case-1", pauseId: "pause-1", frameId: "frame-1", controlId: "control-4", name: "result", expression: "12" }],
  ];

  it("keeps manifests and authorization version-specific without silently upgrading V1", () => {
    expect(parseHeadlessManifest(liveManifest())).toMatchObject({ schemaVersion: 2, debug: { stopOnEntry: true } });
    expect(parseHeadlessManifest({ ...liveManifest(), debug: { stopOnEntry: false } })).toMatchObject({ debug: { stopOnEntry: false } });
    expect(parseHeadlessRequest(liveRequest("session.create", { manifest: liveManifest(), authorization: liveAuthorization })).schemaVersion).toBe(2);
    expect(parseHeadlessAuthorization(liveAuthorization, 2)).toEqual(liveAuthorization);
    for (const candidate of [
      { ...manifest(), schemaVersion: 2 }, { ...manifest(), debug: { stopOnEntry: true } },
      { ...liveManifest(), debug: {} }, { ...liveManifest(), debug: { stopOnEntry: "true" } },
      { ...liveManifest(), debug: { stopOnEntry: true, inspectorUrl: "ws://127.0.0.1:9229" } },
    ]) errorCode(() => parseHeadlessManifest(candidate), "invalid_request");
    errorCode(() => parseHeadlessRequest(liveRequest("session.create", { manifest: manifest(), authorization: liveAuthorization })), "invalid_request");
    errorCode(() => parseHeadlessRequest(request("session.create", { manifest: liveManifest(), authorization })), "invalid_request");
    errorCode(() => parseHeadlessAuthorization(liveAuthorization, 1), "authorization_required");
  });

  it("requires all four mock-debug acknowledgements, rejects real-effect authority and retains the larger-budget permission", () => {
    for (const key of Object.keys(liveAuthorization)) {
      const missing: Record<string, unknown> = { ...liveAuthorization }; delete missing[key];
      for (const permissions of [missing, { ...liveAuthorization, [key]: false }, { ...liveAuthorization, [key]: "true" }]) {
        errorCode(() => parseHeadlessRequest(liveRequest("session.create", { manifest: liveManifest(), authorization: permissions })), "authorization_required");
      }
    }
    for (const forbidden of ["allowProviderCharges", "allowExternalEffects"]) {
      errorCode(() => parseHeadlessAuthorization({ ...liveAuthorization, [forbidden]: true }, 2), "invalid_request");
    }
    errorCode(() => parseHeadlessAuthorization({ ...liveAuthorization, executeGetter: true }, 2), "invalid_request");
    const increased = parseHeadlessManifest({ ...liveManifest(), executionBudgetMs: 120_000 });
    errorCode(() => resolveHeadlessExecutionBudget(60_000, increased, parseHeadlessAuthorization(liveAuthorization, 2)), "authorization_required");
    expect(resolveHeadlessExecutionBudget(60_000, increased, parseHeadlessAuthorization({ ...liveAuthorization, increaseExecutionBudget: true }, 2)).totalMs).toBe(120_000);
  });

  it("accepts every exact live command and never exposes it through protocol V1", () => {
    for (const [method, params] of liveParams) {
      expect(parseHeadlessRequest(liveRequest(method, params))).toMatchObject({ schemaVersion: 2, method, params });
      errorCode(() => parseHeadlessRequest(request(method, params)), "invalid_request");
      errorCode(() => parseHeadlessRequest(liveRequest(method, { ...params, unknownField: true })), "invalid_request");
      for (const key of Object.keys(params)) {
        const missing = { ...params }; delete missing[key];
        errorCode(() => parseHeadlessRequest(liveRequest(method, missing)), "invalid_request");
      }
    }
    for (const kind of ["into", "over", "out"]) expect(parseHeadlessRequest(liveRequest("debug.step", {
      caseId: "case-1", pauseId: "pause-1", controlId: "control-1", kind,
    })).method).toBe("debug.step");
    errorCode(() => parseHeadlessRequest(liveRequest("debug.evaluate", { caseId: "case-1", pauseId: "pause-1", frameId: "frame-1", evaluationId: "evaluation-1", expression: "" })), "invalid_request");
  });

  it("requires bounded declarative mocks and defaults omitted expectations", () => {
    const withoutExpectations = liveManifest();
    delete (withoutExpectations.cases[0] as { expectations?: unknown }).expectations;
    expect(parseHeadlessManifest(withoutExpectations).cases[0]).toMatchObject({ mocks: {}, expectations: [] });
    const withMocks = liveManifest();
    withMocks.cases[0]!.mocks = {
      "weather.current": { kind: "result", value: { temperatureC: 20 }, delayMs: 5 },
      "agent.recommend": { kind: "error", error: { code: "provider-failed", message: "simulated" } },
    };
    expect(parseHeadlessManifest(withMocks).cases[0]).toMatchObject({ mocks: withMocks.cases[0]!.mocks });
    for (const mocks of [
      { "../escape": { kind: "result", value: null } },
      { "effect/../escape": { kind: "result", value: null } },
      { weather: { kind: "result", value: null, executable: "code" } },
      { weather: { kind: "error", error: { code: "UPPER", message: "simulated" } } },
      { weather: { kind: "result", value: null, delayMs: 60_001 } },
    ]) errorCode(() => parseHeadlessManifest({ ...liveManifest(), cases: [{ ...liveManifest().cases[0], mocks }] }), "invalid_request");
  });

  it("enforces bounded IDs, safe integer pages and one-based source locations", () => {
    for (const [method, params] of liveParams) {
      for (const key of Object.keys(params).filter(key => key.endsWith("Id"))) {
        for (const value of ["", "../escape", "UPPER", "a".repeat(65), 12]) errorCode(() => parseHeadlessRequest(liveRequest(method, { ...params, [key]: value })), "invalid_request");
      }
      if ("offset" in params) for (const offset of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
        errorCode(() => parseHeadlessRequest(liveRequest(method, { ...params, offset })), "invalid_request");
      }
      if ("limit" in params) for (const limit of [0, 0.5, "1", method === "debug.source.read" ? 262145 : 101]) {
        errorCode(() => parseHeadlessRequest(liveRequest(method, { ...params, limit })), "invalid_request");
      }
    }
    for (const field of ["line", "column"]) for (const value of [0, -1, 1.1, "1", Number.MAX_SAFE_INTEGER + 1]) {
      errorCode(() => parseHeadlessRequest(liveRequest("debug.breakpoints.set", { expectedDebuggerRevision: 0,
        breakpoints: [{ breakpointId: "bp", sourceId: "source", line: 1, column: 1, [field]: value }] })), "invalid_request");
    }
    for (const revision of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) errorCode(() => parseHeadlessRequest(liveRequest("debug.breakpoints.set", {
      expectedDebuggerRevision: revision, breakpoints: [],
    })), "invalid_request");
  });

  it("allows atomic removal but rejects duplicate or oversized complete breakpoint sets", () => {
    const breakpoints = Array.from({ length: 100 }, (_, index) => ({ breakpointId: `bp-${index}`, sourceId: "source", line: index + 1, column: 1 }));
    for (const allowed of [[], breakpoints]) expect(parseHeadlessRequest(liveRequest("debug.breakpoints.set", { expectedDebuggerRevision: 0, breakpoints: allowed })).method).toBe("debug.breakpoints.set");
    for (const invalid of [[breakpoints[0], breakpoints[0]], [...breakpoints, { ...breakpoints[0], breakpointId: "overflow" }]]) {
      errorCode(() => parseHeadlessRequest(liveRequest("debug.breakpoints.set", { expectedDebuggerRevision: 0, breakpoints: invalid })), "invalid_request");
    }
  });

  it("uses actionable retry policies for new live-control errors", () => {
    for (const code of ["session_version_mismatch", "debugger_unavailable", "source_mapping_unavailable", "not_paused", "not_running",
      "stale_attempt", "stale_pause", "stale_handle", "stale_debugger_revision", "breakpoint_unbound", "inspection_unavailable", "control_conflict", "action_required", "unsupported_mock_dependency"] as const) {
      expect(new HeadlessDebuggerError(code, "safe").retry).toBe("after_action");
    }
  });
});

describe("headless expectation comparison", () => {
  it("uses structural equality with object order ignored, array order retained and no coercion", () => {
    expect(compare([resultExpectation({ a: 1, b: [null, true] })], { b: [null, true], a: 1 }).comparison).toBe("pass");
    for (const [expected, actual] of [[1, "1"], [[1, 2], [2, 1]], [null, false], [{ a: null }, {}], [{}, []]]) {
      expect(compare([resultExpectation(expected)], actual).comparison).toBe("mismatch");
    }
  });

  it("resolves escaped pointers and own properties only, with missing distinct from null", () => {
    expect(compare([resultExpectation(7, "/a~1b/~0key/0")], { "a/b": { "~key": [7] } }).comparison).toBe("pass");
    for (const pointer of ["/missing", "/toString", "/constructor", "/__proto__", "/a/01", "/a/-", "/a/length"]) {
      expect(compare([{ id: "exists", target: "result", operator: "exists", pointer }], { a: [null, 1] }).comparison).toBe("mismatch");
    }
    expect(compare([{ id: "exists", target: "result", operator: "exists", pointer: "/a/0" }], { a: [null] }).comparison).toBe("pass");
    expect(compare([resultExpectation(null, "/missing")], {}).comparison).toBe("mismatch");
    expect(compare([resultExpectation("business", "/constructor")], JSON.parse('{"constructor":"business"}')).comparison).toBe("pass");
  });

  it("never passes a nonterminal state, empty expectation list or unavailable comparison", () => {
    const expectation: HeadlessExpectation = { id: "failed", target: "run-status", operator: "equals", value: "failed" };
    expect(compareExpectations([expectation], { terminal: false, runStatus: "failed", resultAvailable: false }).comparison).toBe("pending");
    expect(compareExpectations([], { terminal: false, runStatus: null, resultAvailable: false }).comparison).toBe("pending");
    expect(compareExpectations([], { terminal: true, runStatus: "complete", resultAvailable: false }).comparison).toBe("not_checked");
    expect(compareExpectations([expectation], { terminal: true, runStatus: "failed", resultAvailable: false }).comparison).toBe("pass");
    expect(compareExpectations([resultExpectation(null)], { terminal: true, runStatus: "failed", resultAvailable: false }).comparison).toBe("mismatch");
    expect(compareExpectations([expectation], { terminal: true, runStatus: "failed", resultAvailable: false, unavailable: true }).comparison).toBe("unavailable");
    expect(compare([resultExpectation(1)], undefined).comparison).toBe("unavailable");
  });
});

describe("headless evidence sanitization", () => {
  it("redacts known secrets and authentication key names without altering the original payload", () => {
    const original = { city: "Istanbul", OPENAI_API_KEY: "not-detected-by-value", anthropicApiKey: "short", nested: {
      authorization: "Bearer abcdef", refresh_token: "refresh", harmless: "before private-secret after", tokenUsage: 42,
    }, payloadPath: "/Users/example/business.csv" };
    const view = sanitizeEvidence(original, { knownSecrets: ["private-secret"], payload: true });
    expect(view.redacted).toBe(true);
    expect(view.value).toEqual({ city: "Istanbul", OPENAI_API_KEY: "[REDACTED]", anthropicApiKey: "[REDACTED]", nested: {
      authorization: "[REDACTED]", refresh_token: "[REDACTED]", harmless: "before [REDACTED] after", tokenUsage: 42,
    }, payloadPath: "/Users/example/business.csv" });
    expect(original.nested.harmless).toBe("before private-secret after");
    expect(original.OPENAI_API_KEY).toBe("not-detected-by-value");
  });

  it("masks private host paths, stacks, environment and raw process output in metadata", () => {
    const view = sanitizeEvidence({ message: "Failed reading /Users/person/private/workflow.ts at C:\\private\\file.ts",
      stack: "Error\n at secret (/Users/name/project.ts:1:2)", environment: { PRIVATE: "secret" }, stderr: "raw-provider-output",
      code: "input_invalid", durationMs: 10, tokens: null });
    const serialized = JSON.stringify(view.value);
    expect(view.redacted).toBe(true);
    for (const forbidden of ["Users", "person", "C:", "raw-provider-output", "PRIVATE", "project.ts"]) expect(serialized).not.toContain(forbidden);
    expect(view.value).toMatchObject({ code: "input_invalid", durationMs: 10, tokens: null });
  });

  it("preserves clean values and explicit unknown counts, handles dangerous own keys safely", () => {
    const view = sanitizeEvidence({ tokenUsage: { inputTokens: null, outputTokens: 2 }, result: [1, null, "ok"] }, { payload: true });
    expect(view.redacted).toBe(false);
    expect(view.value).toEqual({ tokenUsage: { inputTokens: null, outputTokens: 2 }, result: [1, null, "ok"] });
    const ownPrototype = sanitizeEvidence(JSON.parse('{"__proto__":{"business":"value"}}'), { payload: true });
    expect(Object.prototype.hasOwnProperty.call(ownPrototype.value, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).business).toBeUndefined();
    expect(sanitizeEvidence({ invalid: undefined })).toEqual({ value: "[REDACTED]", redacted: true });
  });

  it("handles deeply nested JSON without recursive traversal failures", () => {
    let nested: unknown = "secret";
    for (let depth = 0; depth < 5000; depth++) nested = [nested];
    expect(isHeadlessJson(nested)).toBe(true);
    expect(parseHeadlessManifest({ ...manifest(), cases: [{ caseId: "deep", input: nested, expectations: [] }] }).cases[0]!.caseId).toBe("deep");
    expect(sanitizeEvidence(nested, { knownSecrets: ["secret"], payload: true }).redacted).toBe(true);
  });

  it("maps contract error retry policies consistently", () => {
    expect(new HeadlessDebuggerError("invalid_request", "bad").retry).toBe("never");
    expect(new HeadlessDebuggerError("authorization_required", "approval").retry).toBe("after_action");
    expect(new HeadlessDebuggerError("storage_unavailable", "storage").retry).toBe("same_identity");
  });
});
