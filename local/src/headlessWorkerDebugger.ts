import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HeadlessDebugSources, type LiveSourceLocation } from "./headlessDebugSources.ts";
import { HeadlessDebuggerError } from "./headlessDebuggerContracts.ts";

export interface LiveBreakpoint extends LiveSourceLocation { breakpointId: string; condition?: string; logExpression?: string }
export interface LiveBreakpointBinding { breakpointId: string; requested: Omit<LiveBreakpoint, "breakpointId">; actual: LiveSourceLocation | null;
  state: "pending" | "bound" | "unbound"; reason: string | null }
export interface HeadlessWorkerDebuggerOptions {
  endpoint: string; workerScriptUrl: string; retainedCode: string; buildSha256: string; attemptId: string; stopOnEntry: boolean;
  breakpoints?: LiveBreakpoint[]; knownSecrets?: readonly string[]; onChange?(): void;
  /** Synchronous fail-closed hook: the owner terminates its child, never resumes it. */
  onDisconnect(): void;
  onPause?(pauseId: string): Promise<void>; onResume?(pauseId: string): Promise<void>;
}
type Remote = { type: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string; objectId?: string };
type Property = { name: string; value?: Remote; get?: Remote; set?: Remote; wasThrown?: boolean; enumerable?: boolean };
type Frame = { callFrameId: string; functionName: string; url: string; location: { scriptId: string; lineNumber: number; columnNumber: number };
  scopeChain: { type: string; name?: string; object: Remote }[] };
type Pause = { pauseId: string; reason: "entry" | "breakpoint" | "interrupt" | "step"; sourceId: string | null;
  line: number | null; column: number | null; breakpointIds: string[] };
const boundMs = 5000;
const safeError = (code: ConstructorParameters<typeof HeadlessDebuggerError>[0] = "debugger_unavailable", message = "The owned workflow debugger is unavailable.") =>
  new HeadlessDebuggerError(code, message, "after_action");
const validPage = (offset: number, limit: number) => Number.isSafeInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 100;
const readerCall = "function(target,path,offset,limit,secrets){return this(target,path,offset,limit,secrets);}";
const entryCall = "function(scope){return this(scope);}";
const sameWorkerScript = (actual: string, expected: string): boolean => {
  try {
    const a = fileURLToPath(actual), b = fileURLToPath(expected);
    return a === b || realpathSync(a) === realpathSync(b);
  } catch { return false; }
};

/** Private inspector transport for one already-owned child; never accepts client URLs. */
class InspectorConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  #sequence = 0; #closed = false;
  onEvent?: (method: string, params: any) => void;
  onFailure?: () => void;
  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 8 * 1024 * 1024) { this.onFailure?.(); this.close(); return; }
      let message: any;
      try { message = JSON.parse(event.data); } catch { this.onFailure?.(); this.close(); return; }
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id); if (!pending) return;
        this.#pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(safeError()); else pending.resolve(message.result ?? {});
      } else if (typeof message.method === "string") this.onEvent?.(message.method, message.params ?? {});
    });
    socket.addEventListener("close", () => { const unexpected = !this.#closed; if (unexpected) this.onFailure?.(); this.close(); });
    socket.addEventListener("error", () => { if (!this.#closed) this.onFailure?.(); this.close(); });
  }
  static async connect(endpoint: string) {
    let url: URL; try { url = new URL(endpoint); } catch { throw safeError(); }
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash
      || !/^\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw safeError();
    const socket = new WebSocket(endpoint);
    const connection = new InspectorConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { connection.close(); reject(safeError()); }, boundMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(safeError()); }, { once: true });
    });
    return connection;
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(safeError());
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(safeError()); }, boundMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.#pending.delete(id); reject(safeError()); }
    });
  }
  close() {
    if (this.#closed) return; this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(safeError()); }
    this.#pending.clear(); this.#socket.close();
  }
}

/** Owns live state only. Session receipts and durable breakpoint intent belong to the coordinator. */
export class HeadlessWorkerDebugger {
  readonly sources: HeadlessDebugSources;
  readonly #connection: InspectorConnection;
  readonly #options: HeadlessWorkerDebuggerOptions;
  readonly #scripts = new Map<string, string>();
  readonly #frames = new Map<string, Frame>();
  readonly #objects = new Map<string, { scopeId: string; path: string[] }>();
  readonly #simulatedVariableValues = new Map<string, Map<string, Record<string, unknown>>>();
  readonly #remoteBreakpoints = new Map<string, string>();
  readonly #logBindingName = `arkimuxMockLog_${randomUUID().replaceAll("-", "")}`;
  readonly #logToken = randomUUID();
  readonly #logs: { sequence: number; breakpointId: string; expressionSha256: string; status: "completed" | "threw"; value?: Record<string, unknown> }[] = [];
  #logSequence = 0;
  #droppedLogs = 0;
  #bindings: LiveBreakpointBinding[] = [];
  #pause: Pause | null = null;
  #state: "attaching" | "running" | "pause_requested" | "paused" | "terminated" | "action_required" = "attaching";
  #error: { code: string; message: string; retry: "after_action" } | null = null;
  #entryBreakpoint: string | undefined;
  #entryGateSeen = false;
  #readerId: string | undefined;
  #entryReaderId: string | undefined;
  #bootstrapScriptId: string | undefined;
  #bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  #inspectionFailed = false;
  #stepPending = false;
  #internalStepHops = 0;
  #stepDeadline = 0;
  #interruptPending = false;
  #closed = false;
  #events: Promise<void> = Promise.resolve();
  #controls: Promise<unknown> = Promise.resolve();
  #revision = 0;
  private constructor(options: HeadlessWorkerDebuggerOptions, connection: InspectorConnection) {
    this.#options = options; this.#connection = connection;
    this.sources = new HeadlessDebugSources(options.retainedCode, options.buildSha256);
    connection.onEvent = (method, params) => {
      this.#events = this.#events.then(() => this.#event(method, params)).catch(() => { this.#abortInspection(); });
    };
    connection.onFailure = () => this.#abortInspection();
  }
  static async create(options: HeadlessWorkerDebuggerOptions) {
    const connection = await InspectorConnection.connect(options.endpoint);
    const controller = new HeadlessWorkerDebugger(options, connection);
    try {
      await connection.request("Runtime.enable");
      await connection.request("Runtime.addBinding", { name: controller.#logBindingName });
      await connection.request("Debugger.enable", { maxScriptsCacheSize: 16 * 1024 * 1024 });
      await connection.request("Debugger.setPauseOnExceptions", { state: "none" });
      await controller.replaceBreakpoints(options.breakpoints ?? []);
      controller.#bootstrapTimer = setTimeout(() => controller.#abortInspection(), boundMs);
      controller.#bootstrapTimer.unref();
      controller.#state = "running"; controller.#changed();
      return controller;
    } catch (error) { await controller.close(); throw error; }
  }
  #changed() { this.#revision++; try { this.#options.onChange?.(); } catch { /* Observers do not own worker execution. */ } }
  #fail(code = "debugger_unavailable", message = "Live debugger state could not be confirmed. Inspect or cancel this case.") {
    if (this.#closed) return;
    this.#state = "action_required"; this.#error = { code, message, retry: "after_action" }; this.#changed();
  }
  #abortInspection() {
    if (this.#closed || this.#inspectionFailed) return;
    this.#inspectionFailed = true;
    clearTimeout(this.#bootstrapTimer); this.#invalidate();
    this.#fail("debugger_unavailable", "The worker was stopped because safe debugger inspection could not be confirmed.");
    // Kill through the owner before detaching: detaching can resume JavaScript.
    try { this.#options.onDisconnect(); } catch { /* Keep failure visible even if owner cleanup also fails. */ }
    finally { this.#connection.close(); }
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#controls.then(work); this.#controls = result.catch(() => {}); return result;
  }
  #text(value: string) {
    let text = value;
    for (const secret of this.#options.knownSecrets ?? []) if (secret) text = text.split(secret).join("[redacted]");
    text = text.replace(/(?:sk-[a-zA-Z0-9_-]{10,}|Bearer\s+[a-zA-Z0-9._-]{10,})/g, "[redacted]");
    const bytes = Buffer.from(text); let end = Math.min(bytes.length, 4096);
    while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return { text: bytes.subarray(0, end).toString("utf8"), truncated: bytes.length > end };
  }
  #location(frame: Frame): LiveSourceLocation | null {
    return (this.#scripts.get(frame.location.scriptId) ?? frame.url) === this.sources.scriptUrl
      ? this.sources.original(frame.location.lineNumber, frame.location.columnNumber) : null;
  }
  #ensurePause(pauseId: string) {
    if (!this.#pause) throw safeError("not_paused", "The workflow is not paused.");
    if (this.#pause.pauseId !== pauseId) throw safeError("stale_pause", "This pause is no longer current.");
    if (this.#closed) throw safeError();
  }
  #invalidate() {
    this.#pause = null; this.#frames.clear(); this.#objects.clear(); this.#simulatedVariableValues.clear();
    void this.#connection.request("Runtime.releaseObjectGroup", { objectGroup: "arkimux-simulated-evaluation" }).catch(() => {});
  }
  async #event(method: string, params: any) {
    if (this.#closed) return;
    if (method === "Runtime.bindingCalled") {
      if (params.name !== this.#logBindingName || typeof params.payload !== "string" || Buffer.byteLength(params.payload) > 32 * 1024) return;
      let item: any;
      try { item = JSON.parse(params.payload); } catch { return; }
      if (!item || item.token !== this.#logToken || typeof item.breakpointId !== "string"
        || !this.#bindings.some(binding => binding.breakpointId === item.breakpointId)
        || !["completed", "threw"].includes(item.status)) return;
      const binding = this.#bindings.find(candidate => candidate.breakpointId === item.breakpointId);
      if (!binding?.requested.logExpression) return;
      const value = item.status === "completed" ? this.#logValue(item.value) : undefined;
      this.#logs.push({ sequence: ++this.#logSequence, breakpointId: item.breakpointId,
        expressionSha256: this.#expressionReceipt(binding.requested.logExpression), status: item.status, ...(value ? { value } : {}) });
      if (this.#logs.length > 100) { this.#logs.shift(); this.#droppedLogs++; }
      this.#changed(); return;
    }
    if (method === "Debugger.scriptParsed") { this.#scripts.set(params.scriptId, params.url); return; }
    if (method === "Debugger.breakpointResolved") {
      const id = this.#remoteBreakpoints.get(params.breakpointId), binding = this.#bindings.find(b => b.breakpointId === id);
      if (binding) {
        const actual = this.sources.original(params.location.lineNumber, params.location.columnNumber);
        binding.actual = actual; binding.state = actual ? "bound" : "unbound"; binding.reason = actual ? null : "Exact retained source mapping is unavailable.";
        this.#changed();
      }
      return;
    }
    if (method === "Debugger.resumed") {
      if (this.#pause) { const id = this.#pause.pauseId; await this.#options.onResume?.(id); this.#invalidate(); }
      if (this.#state !== "action_required") this.#state = "running"; this.#changed(); return;
    }
    if (method !== "Debugger.paused") return;
    const frames = params.callFrames as Frame[];
    if (!Array.isArray(frames) || !frames[0]) throw safeError();
    const firstFrame = frames[0];
    const scriptUrl = this.#scripts.get(firstFrame.location.scriptId) ?? firstFrame.url;
    if (!this.#readerId) {
      if (this.#bootstrapScriptId || firstFrame.functionName !== "arkimuxHeadlessReaderGate" || !sameWorkerScript(scriptUrl, this.#options.workerScriptUrl)) throw safeError();
      this.#bootstrapScriptId = firstFrame.location.scriptId;
      const scope = firstFrame.scopeChain.find(item => item.type === "local");
      if (!scope?.object.objectId) throw safeError();
      // This is the only raw property request: trusted bootstrap arguments,
      // before any retained module has loaded. Never enumerate project scopes.
      const response = await this.#connection.request("Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true, generatePreview: false });
      if (!Array.isArray(response.result)) throw safeError();
      const pin = async (name: string) => {
        const remote = (response.result as Property[]).find(item => item.name === name)?.value;
        if (remote?.type !== "function" || !remote.objectId) throw safeError();
        const pinned = await this.#connection.request("Runtime.callFunctionOn", { objectId: remote.objectId,
          functionDeclaration: "function(){return this;}", throwOnSideEffect: true, returnByValue: false,
          objectGroup: "arkimux-fixed-reader", generatePreview: false });
        if (pinned.exceptionDetails || pinned.result?.type !== "function" || !pinned.result.objectId) throw safeError();
        return pinned.result.objectId as string;
      };
      this.#readerId = await pin("privateReader"); this.#entryReaderId = await pin("privateEntry");
      clearTimeout(this.#bootstrapTimer);
      await this.#connection.request("Debugger.resume"); return;
    }
    const gate = firstFrame.functionName === "arkimuxHeadlessEntryGate" && firstFrame.location.scriptId === this.#bootstrapScriptId;
    if (gate && !this.#entryGateSeen) {
      this.#entryGateSeen = true;
      if (this.#options.stopOnEntry) {
        const scope = firstFrame.scopeChain.find(item => item.type === "local");
        if (!scope?.object.objectId || !this.#entryReaderId) throw safeError();
        const captured = await this.#connection.request("Runtime.callFunctionOn", { objectId: this.#entryReaderId,
          functionDeclaration: entryCall, arguments: [{ objectId: scope.object.objectId }],
          throwOnSideEffect: true, returnByValue: false, generatePreview: false });
        if (captured.exceptionDetails) throw safeError();
        const target = captured.result as Remote | undefined;
        if (target?.type !== "function" || !target.objectId) throw safeError("inspection_unavailable");
        const result = await this.#connection.request("Debugger.setBreakpointOnFunctionCall", { objectId: target.objectId });
        this.#entryBreakpoint = result.breakpointId;
      }
      await this.#connection.request("Debugger.resume"); return;
    }
    const entry = !!this.#entryBreakpoint && (params.hitBreakpoints ?? []).includes(this.#entryBreakpoint);
    if (entry) { await this.#connection.request("Debugger.removeBreakpoint", { breakpointId: this.#entryBreakpoint }); this.#entryBreakpoint = undefined; }
    const location = this.#location(frames[0]);
    if (!location && this.#stepPending && this.#internalStepHops++ < 100 && Date.now() < this.#stepDeadline) {
      // Private host/engine frames are not user step targets. Return to a mapped
      // workflow caller, or let execution finish when no such caller remains.
      if (frames.slice(1).some(frame => this.#location(frame))) await this.#connection.request("Debugger.stepOut");
      else { this.#stepPending = false; await this.#connection.request("Debugger.resume"); }
      return;
    }
    const pauseId = `pause-${randomUUID()}`;
    this.#frames.clear(); this.#objects.clear();
    for (const frame of frames.slice(0, 100)) this.#frames.set(`frame-${randomUUID()}`, frame);
    this.#pause = { pauseId, reason: entry ? "entry" : this.#stepPending ? "step" : this.#interruptPending ? "interrupt" : "breakpoint",
      sourceId: location?.sourceId ?? null, line: location?.line ?? null, column: location?.column ?? null,
      breakpointIds: (params.hitBreakpoints ?? []).map((id: string) => this.#remoteBreakpoints.get(id)).filter(Boolean) };
    this.#stepPending = false; this.#interruptPending = false;
    await this.#options.onPause?.(pauseId);
    this.#state = "paused";
    if (!location) this.#error = { code: "inspection_unavailable", message: "The worker paused outside mapped workflow source. Framework scopes are not exposed.", retry: "after_action" };
    else this.#error = null;
    this.#changed();
  }
  inspect() { return { attemptId: this.#options.attemptId, debuggerRevision: this.#revision, state: this.#state,
    pause: this.#pause ? structuredClone(this.#pause) : null, breakpoints: structuredClone(this.#bindings),
    logs: { items: structuredClone(this.#logs), dropped: this.#droppedLogs, truncated: this.#droppedLogs > 0 },
    error: this.#error ? { ...this.#error } : null }; }
  #breakpointCondition(breakpoint: LiveBreakpoint): string | undefined {
    if (!breakpoint.logExpression) return breakpoint.condition;
    const condition = breakpoint.condition ? `(${breakpoint.condition})` : "true";
    const expression = breakpoint.logExpression;
    const completed = `value===null?{kind:'null',value:null}:typeof value==='string'?{kind:'scalar',type:'string',value:value.slice(0,4096),truncated:value.length>4096}:typeof value==='boolean'?{kind:'scalar',type:'boolean',value}:typeof value==='number'&&Number.isFinite(value)?{kind:'scalar',type:'number',value}:{kind:'opaque',type:Array.isArray(value)?'array':typeof value}`;
    const base = `{token:${JSON.stringify(this.#logToken)},breakpointId:${JSON.stringify(breakpoint.breakpointId)}}`;
    return `(()=>{try{if(!${condition})return false;const value=(${expression});${this.#logBindingName}(JSON.stringify({...${base},status:'completed',value:${completed}}))}catch{${this.#logBindingName}(JSON.stringify({...${base},status:'threw'}))}return false})()`;
  }
  #logValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unavailable" };
    const item = value as Record<string, unknown>;
    if (item.kind === "null" && item.value === null) return { kind: "null", value: null };
    if (item.kind === "scalar" && item.type === "boolean" && typeof item.value === "boolean") return { kind: "scalar", type: "boolean", value: item.value };
    if (item.kind === "scalar" && item.type === "number" && typeof item.value === "number" && Number.isFinite(item.value)) return { kind: "scalar", type: "number", value: item.value };
    if (item.kind === "scalar" && item.type === "string" && typeof item.value === "string" && typeof item.truncated === "boolean") {
      const redacted = this.#text(item.value); return { kind: "scalar", type: "string", value: redacted.text, truncated: item.truncated || redacted.truncated };
    }
    if (item.kind === "opaque" && typeof item.type === "string" && Buffer.byteLength(item.type) <= 100) return { kind: "opaque", type: item.type };
    return { kind: "unavailable" };
  }
  replaceBreakpoints(breakpoints: LiveBreakpoint[]) {
    return this.#serial(async () => {
      if (this.#closed || breakpoints.length > 100 || new Set(breakpoints.map(b => b.breakpointId)).size !== breakpoints.length) throw safeError("control_conflict");
      const mapped = breakpoints.map(b => ({ breakpoint: b, generated: this.sources.generated(b) }));
      try {
        for (const id of this.#remoteBreakpoints.keys()) await this.#connection.request("Debugger.removeBreakpoint", { breakpointId: id });
        this.#remoteBreakpoints.clear(); this.#bindings = [];
        for (const { breakpoint, generated } of mapped) {
          const result = await this.#connection.request("Debugger.setBreakpointByUrl", { url: this.sources.scriptUrl,
            lineNumber: generated.lineNumber, columnNumber: generated.columnNumber,
            ...(this.#breakpointCondition(breakpoint) ? { condition: this.#breakpointCondition(breakpoint) } : {}) });
          this.#remoteBreakpoints.set(result.breakpointId, breakpoint.breakpointId);
          const actual = result.locations?.[0] ? this.sources.original(result.locations[0].lineNumber, result.locations[0].columnNumber) : null;
          this.#bindings.push({ breakpointId: breakpoint.breakpointId, requested: { sourceId: breakpoint.sourceId, line: breakpoint.line, column: breakpoint.column,
            ...(breakpoint.condition ? { condition: breakpoint.condition } : {}), ...(breakpoint.logExpression ? { logExpression: breakpoint.logExpression } : {}) },
            actual, state: actual ? "bound" : "pending", reason: null });
        }
        this.#changed(); return structuredClone(this.#bindings);
      } catch { this.#fail("debugger_unavailable", "Breakpoint application could not be confirmed. Reconcile or cancel before continuing."); throw safeError(); }
    });
  }
  pause(attemptId: string) { return this.#serial(async () => {
    if (attemptId !== this.#options.attemptId) throw safeError("stale_attempt");
    if (this.#state !== "running") throw safeError("not_running");
    this.#interruptPending = true; this.#state = "pause_requested"; this.#changed();
    try { await this.#connection.request("Debugger.pause"); } catch { this.#fail(); throw safeError(); }
    return this.inspect();
  }); }
  continue(pauseId: string) { return this.#resume(pauseId, undefined); }
  step(pauseId: string, kind: "into" | "over" | "out") { return this.#resume(pauseId, kind); }
  #resume(pauseId: string, step: "into" | "over" | "out" | undefined) { return this.#serial(async () => {
    this.#ensurePause(pauseId);
    if (this.#state === "action_required") throw safeError();
    if (step !== undefined && !["into", "over", "out"].includes(step)) throw safeError("control_conflict");
    await this.#options.onResume?.(pauseId);
    this.#invalidate(); this.#state = "running"; this.#stepPending = !!step; this.#changed();
    this.#internalStepHops = 0; this.#stepDeadline = Date.now() + boundMs;
    try { await this.#connection.request(step ? { into: "Debugger.stepInto", over: "Debugger.stepOver", out: "Debugger.stepOut" }[step] : "Debugger.resume"); }
    catch { this.#fail(); throw safeError(); }
    return this.inspect();
  }); }
  async stack(pauseId: string, offset: number, limit: number) {
    this.#ensurePause(pauseId); if (!validPage(offset, limit)) throw safeError("inspection_unavailable");
    const frames = [...this.#frames.entries()];
    return { items: frames.slice(offset, offset + limit).map(([frameId, frame]) => ({ frameId, functionName: this.#text(frame.functionName).text,
      location: this.#location(frame), kind: this.#location(frame) ? "workflow" : "framework" })), total: frames.length,
      truncated: frames.length >= 100, nextOffset: offset + limit < frames.length ? offset + limit : null };
  }
  async scopes(pauseId: string, frameId: string) {
    this.#ensurePause(pauseId);
    const frame = this.#frames.get(frameId); if (!frame) throw safeError("stale_handle");
    if (!this.#location(frame)) throw safeError("inspection_unavailable", "Framework and runtime scopes are not inspection targets.");
    const scopes = frame.scopeChain.filter(scope => ["local", "closure", "block", "catch"].includes(scope.type));
    return { items: scopes.slice(0, 32).map(scope => ({ type: scope.type, name: this.#text(scope.name ?? "").text,
      value: scope.object.objectId ? this.#reference(scope.object.objectId, [], "object") : { kind: "unavailable" } })), truncated: scopes.length > 32 };
  }
  #reference(scopeId: string, path: string[], type: string): Record<string, unknown> {
    if (path.length > 32) return { kind: "unavailable", reason: "Live object path limit reached." };
    const existing = [...this.#objects.entries()].find(([, item]) => item.scopeId === scopeId && item.path.length === path.length && item.path.every((key, i) => key === path[i]))?.[0];
    if (existing) return { kind: "object", objectId: existing, type };
    if (this.#objects.size >= 10000) return { kind: "unavailable", reason: "Live object reference limit reached." };
    const objectId = `object-${randomUUID()}`; this.#objects.set(objectId, { scopeId, path });
    return { kind: "object", objectId, type };
  }
  #displayValue(value: any): Record<string, unknown> {
    // Build a fresh allowlisted public record, never forward reader internals.
    if (["undefined", "uninitialized", "unavailable", "redacted", "accessor"].includes(value.kind)) return { kind: value.kind };
    if (value.kind === "null") return { kind: "null", value: null };
    if (value.kind === "opaque" && typeof value.type === "string" && Buffer.byteLength(value.type) <= 100) return { kind: "opaque", type: value.type };
    if (value.kind === "scalar") {
      if (value.type === "boolean" && typeof value.value === "boolean" || value.type === "number" && typeof value.value === "number" && Number.isFinite(value.value)) {
        return { kind: "scalar", type: value.type, value: value.value };
      }
      if (value.type === "string" && typeof value.value === "string" && Buffer.byteLength(value.value) <= 4096 && typeof value.truncated === "boolean") {
        return { kind: "scalar", type: "string", value: value.value, truncated: value.truncated };
      }
      if (["number", "bigint"].includes(value.type) && typeof value.preview === "string" && Buffer.byteLength(value.preview) <= 4096) {
        return { kind: "scalar", type: value.type, preview: value.preview };
      }
    }
    throw safeError();
  }
  #workflowFrame(pauseId: string, frameId: string): Frame {
    this.#ensurePause(pauseId);
    const frame = this.#frames.get(frameId); if (!frame) throw safeError("stale_handle");
    if (!this.#location(frame)) throw safeError("inspection_unavailable", "Framework and runtime frames are not evaluation targets.");
    return frame;
  }
  #evaluatedValue(remote: Remote | undefined): Record<string, unknown> {
    if (!remote || typeof remote.type !== "string") throw safeError("inspection_unavailable");
    if (remote.type === "undefined") return { kind: "undefined" };
    if (remote.subtype === "null") return { kind: "null", value: null };
    if (remote.type === "boolean" && typeof remote.value === "boolean") return { kind: "scalar", type: "boolean", value: remote.value };
    if (remote.type === "number") {
      if (typeof remote.value === "number" && Number.isFinite(remote.value)) return { kind: "scalar", type: "number", value: remote.value };
      if (typeof remote.unserializableValue === "string" && Buffer.byteLength(remote.unserializableValue) <= 100) {
        return { kind: "scalar", type: "number", preview: remote.unserializableValue };
      }
    }
    if (remote.type === "bigint" && typeof remote.unserializableValue === "string" && Buffer.byteLength(remote.unserializableValue) <= 4096) {
      return { kind: "scalar", type: "bigint", preview: remote.unserializableValue };
    }
    if (remote.type === "string" && typeof remote.value === "string") {
      const preview = this.#text(remote.value); return { kind: "scalar", type: "string", value: preview.text, truncated: preview.truncated };
    }
    if (remote.type === "symbol" || remote.type === "function") return { kind: "opaque", type: remote.type };
    if (remote.type === "object" && remote.objectId) return this.#reference(remote.objectId, [], remote.subtype === "array" ? "array" : "object");
    return { kind: "unavailable" };
  }
  #expressionReceipt(expression: string) {
    return createHash("sha256").update(expression).digest("hex");
  }
  async #evaluateFrame(frame: Frame, expression: string): Promise<{ remote?: Remote; exception?: string }> {
    if (typeof expression !== "string" || expression.length < 1 || Buffer.byteLength(expression) > 4096) throw safeError("invalid_request");
    try {
      const response = await this.#connection.request("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression,
        objectGroup: "arkimux-simulated-evaluation", includeCommandLineAPI: false, silent: true, returnByValue: false,
        generatePreview: false, throwOnSideEffect: false, timeout: 1_000 });
      if (response.exceptionDetails) {
        const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "The simulated expression threw.";
        return { exception: this.#text(typeof detail === "string" ? detail : "The simulated expression threw.").text };
      }
      return { remote: response.result as Remote };
    } catch { throw safeError("inspection_unavailable", "The simulated expression could not be evaluated within the debugger limit."); }
  }
  async evaluate(pauseId: string, frameId: string, evaluationId: string, expression: string) {
    return this.#serial(async () => {
      const frame = this.#workflowFrame(pauseId, frameId), evaluated = await this.#evaluateFrame(frame, expression);
      this.#ensurePause(pauseId);
      return { evaluationId, expressionSha256: this.#expressionReceipt(expression), pauseId, frameId,
        changedSimulatedState: "unknown" as const, status: evaluated.exception ? "threw" as const : "completed" as const,
        ...(evaluated.exception ? { error: { message: evaluated.exception } } : { result: this.#evaluatedValue(evaluated.remote) }) };
    });
  }
  async #scopeContains(scopeId: string, name: string): Promise<boolean> {
    if (!this.#readerId || this.#inspectionFailed) throw safeError("inspection_unavailable");
    let offset = 0;
    while (offset < 10_000) {
      let page: any;
      try {
        const response = await this.#connection.request("Runtime.callFunctionOn", { objectId: this.#readerId,
          functionDeclaration: readerCall, arguments: [{ objectId: scopeId }, { value: [] }, { value: offset }, { value: 100 },
            { value: this.#options.knownSecrets ?? [] }], throwOnSideEffect: true, returnByValue: true, generatePreview: false });
        if (response.exceptionDetails || response.result?.type !== "string" || typeof response.result.value !== "string"
          || Buffer.byteLength(response.result.value) > 128 * 1024) throw safeError();
        page = JSON.parse(response.result.value);
      } catch { this.#abortInspection(); throw safeError(); }
      if (page?.kind !== "page" || !Number.isInteger(page.count) || page.count < 0 || page.count > 100
        || !page.items || typeof page.items !== "object" || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > 10_000) {
        this.#abortInspection(); throw safeError();
      }
      for (let index = 0; index < page.count; index++) if (page.items[index]?.name === name) return true;
      if (page.nextOffset === null) return false;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > page.total) {
        this.#abortInspection(); throw safeError();
      }
      offset = page.nextOffset;
    }
    return false;
  }
  async setVariable(pauseId: string, frameId: string, controlId: string, name: string, expression: string) {
    return this.#serial(async () => {
      const frame = this.#workflowFrame(pauseId, frameId);
      if (typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name)) throw safeError("invalid_request");
      let scopeNumber = -1, scopeId = "";
      for (let index = 0; index < frame.scopeChain.length; index++) {
        const scope = frame.scopeChain[index];
        if (!["local", "closure", "block", "catch"].includes(scope.type) || !scope.object.objectId) continue;
        if (await this.#scopeContains(scope.object.objectId, name)) { scopeNumber = index; scopeId = scope.object.objectId; break; }
      }
      if (scopeNumber < 0) throw safeError("stale_handle", "The selected variable is unavailable in this paused frame.");
      const evaluated = await this.#evaluateFrame(frame, expression);
      if (evaluated.exception || !evaluated.remote) return { controlId, expressionSha256: this.#expressionReceipt(expression), pauseId, frameId,
        name, changedSimulatedState: "unknown" as const, status: "rejected" as const,
        error: { message: evaluated.exception ?? "The simulated expression did not produce a value." } };
      const argument = evaluated.remote.objectId ? { objectId: evaluated.remote.objectId }
        : evaluated.remote.unserializableValue ? { unserializableValue: evaluated.remote.unserializableValue }
          : { value: evaluated.remote.value };
      try {
        await this.#connection.request("Debugger.setVariableValue", { scopeNumber, variableName: name, newValue: argument,
          callFrameId: frame.callFrameId });
      } catch { throw safeError("control_conflict", "The selected variable could not be changed in this paused frame."); }
      this.#ensurePause(pauseId); this.#changed();
      const displayed = this.#evaluatedValue(evaluated.remote);
      const scopeValues = this.#simulatedVariableValues.get(scopeId) ?? new Map<string, Record<string, unknown>>();
      scopeValues.set(name, displayed); this.#simulatedVariableValues.set(scopeId, scopeValues);
      return { controlId, expressionSha256: this.#expressionReceipt(expression), pauseId, frameId, name,
        changedSimulatedState: true, status: "applied" as const, result: displayed };
    });
  }
  async properties(pauseId: string, objectId: string, offset: number, limit: number) {
    return this.#serial(async () => {
    this.#ensurePause(pauseId); if (!validPage(offset, limit)) throw safeError("inspection_unavailable");
    const object = this.#objects.get(objectId); if (!object) throw safeError("stale_handle");
    if (!this.#readerId || this.#inspectionFailed) throw safeError("inspection_unavailable");
    let page: any;
    try {
      const response = await this.#connection.request("Runtime.callFunctionOn", { objectId: this.#readerId,
        functionDeclaration: readerCall, arguments: [{ objectId: object.scopeId }, { value: object.path },
          { value: offset }, { value: limit }, { value: this.#options.knownSecrets ?? [] }],
        throwOnSideEffect: true, returnByValue: true, generatePreview: false });
      if (response.exceptionDetails || response.result?.type !== "string" || typeof response.result.value !== "string"
        || Buffer.byteLength(response.result.value) > 128 * 1024) throw safeError();
      page = JSON.parse(response.result.value);
    } catch { this.#abortInspection(); throw safeError(); }
    this.#ensurePause(pauseId);
    if (page?.kind !== "page") throw safeError("inspection_unavailable", "This value cannot be inspected safely within the reader limits.");
    if (!Number.isInteger(page.count) || page.count < 0 || page.count > limit || !page.items || typeof page.items !== "object"
      || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > 10000
      || !(page.nextOffset === null || Number.isSafeInteger(page.nextOffset) && page.nextOffset === offset + page.count && page.nextOffset > offset && page.nextOffset < page.total)) {
      this.#abortInspection(); throw safeError();
    }
    const items: { name: string; value: Record<string, unknown>; nameTruncated?: boolean }[] = [];
    for (let index = 0; index < page.count; index++) {
      const item = page.items[index];
      if (typeof item?.name !== "string" || Buffer.byteLength(item.name) > 4096 || !item.value || typeof item.value.kind !== "string") { this.#abortInspection(); throw safeError(); }
      let value: Record<string, unknown>;
      try {
        if (item.value.kind === "object") {
          if (typeof item.key !== "string" || item.key !== item.name || !["object", "array"].includes(item.value.type)) throw safeError();
          value = this.#reference(object.scopeId, [...object.path, item.key], item.value.type);
        } else value = this.#displayValue(item.value);
      } catch { this.#abortInspection(); throw safeError(); }
      items.push({ name: item.name, value, ...(item.nameTruncated ? { nameTruncated: true } : {}) });
    }
    if (object.path.length === 0) {
      const overrides = this.#simulatedVariableValues.get(object.scopeId);
      if (overrides) for (const item of items) {
        const replacement = overrides.get(item.name); if (replacement) item.value = replacement;
      }
    }
    return { items, total: page.total, nextOffset: page.nextOffset };
    });
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true; clearTimeout(this.#bootstrapTimer); this.#invalidate(); this.#state = "terminated";
    this.#connection.close(); this.#changed();
    // The runner terminates the owned child before releasing its authority.
  }
}
export const createHeadlessWorkerDebugger = (options: HeadlessWorkerDebuggerOptions) => HeadlessWorkerDebugger.create(options);
