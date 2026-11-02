import { headlessExpectationSchema, type HeadlessExpectation } from "../../local/src/headlessDebuggerContracts.ts";

export type DockerMockDebuggerJson = null | boolean | number | string | DockerMockDebuggerJson[]
  | { [key: string]: DockerMockDebuggerJson };

export type DockerMockDebuggerMockFixture =
  | { kind: "result"; value: DockerMockDebuggerJson; delayMs?: number }
  | { kind: "error"; error: { code: string; message: string }; delayMs?: number };

export interface DockerMockDebuggerBootstrap {
  schemaVersion: 1;
  kind: "arkimux-mock-debugger-bootstrap";
  caseId: string;
  buildSha256: string;
  construction: { schemaVersion: 1; export: string };
  invocation: Record<string, DockerMockDebuggerJson>;
  graph?: {
    request: DockerMockDebuggerJson;
    identity: Record<string, DockerMockDebuggerJson>;
    agentSlotIds: string[];
  };
  runConfiguration: DockerMockDebuggerJson;
  assets: DockerMockDebuggerAssetDescriptor[];
  mocks: Record<string, DockerMockDebuggerMockFixture>;
  expectations: HeadlessExpectation[];
  stopOnEntry: true;
}

export interface DockerMockDebuggerAssetDescriptor {
  path: string;
  byteLength: number;
  sha256: string;
}

export type DockerMockDebuggerBridgeMethod = "session.inspect" | "session.close" | "debug.sources" | "debug.source.read"
  | "case.respond" | "debug.breakpoints.set" | "debug.inspect" | "debug.pause" | "debug.continue" | "debug.step"
  | "debug.stack" | "debug.scopes" | "debug.properties" | "debug.evaluate" | "debug.variable.set";
type BridgeBase = { schemaVersion: 1; id: string };
type DockerMockDebuggerBridgeParamsByMethod = {
  "session.inspect": Record<string, never>;
  "session.close": Record<string, never>;
  "case.respond": { caseId: string; requestId: string; submissionId: string; expectedRevision: number;
    response: { schemaVersion: 1; fields: Record<string, string | number | boolean>;
      files: Record<string, { objectId: string; mediaType: string; byteLength: number; sha256: string }[]> } };
  "debug.inspect": Record<string, never>;
  "debug.pause": { attemptId: string };
  "debug.sources": { offset: number; limit: number };
  "debug.source.read": { sourceId: string; offset: number; limit: number };
  "debug.breakpoints.set": { breakpoints: { breakpointId: string; sourceId: string; line: number; column: number;
    condition?: string; logExpression?: string }[] };
  "debug.continue": { pauseId: string };
  "debug.step": { pauseId: string; kind: "into" | "over" | "out" };
  "debug.stack": { pauseId: string; offset: number; limit: number };
  "debug.scopes": { pauseId: string; frameId: string };
  "debug.properties": { pauseId: string; objectId: string; offset: number; limit: number };
  "debug.evaluate": { pauseId: string; frameId: string; evaluationId: string; expression: string };
  "debug.variable.set": { pauseId: string; frameId: string; controlId: string; name: string; expression: string };
};
export type DockerMockDebuggerBridgeParams<M extends DockerMockDebuggerBridgeMethod> = DockerMockDebuggerBridgeParamsByMethod[M];
export type DockerMockDebuggerBridgeRequest = {
  [M in DockerMockDebuggerBridgeMethod]: BridgeBase & { method: M; params: DockerMockDebuggerBridgeParams<M> }
}[DockerMockDebuggerBridgeMethod];

export const dockerMockDebuggerBridgeMessageByteLimit = 1024 * 1024;
export const dockerMockDebuggerBootstrapByteLimit = 1024 * 1024;
export const dockerMockDebuggerRetainedCodeByteLimit = 32 * 1024 * 1024;
export const dockerMockDebuggerAssetCountLimit = 256;
export const dockerMockDebuggerAssetByteLimit = 16 * 1024 * 1024;
export const dockerMockDebuggerAssetsTotalByteLimit = 64 * 1024 * 1024;

const boundedId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const digest = /^[a-f0-9]{64}$/;
const mockOperationId = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

export function validDockerMockDebuggerAssetPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && !value.startsWith("/") && !value.includes("\\") && !value.includes(":")
    && /^(?:src|workflows)\//.test(value)
    && value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("."));
}

function validJson(value: unknown): value is DockerMockDebuggerJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJson);
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(validJson);
}

function validMockFixture(value: unknown): value is DockerMockDebuggerMockFixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>, delayMs = item.delayMs;
  if (delayMs !== undefined && (!Number.isInteger(delayMs) || Number(delayMs) < 0 || Number(delayMs) > 60_000)) return false;
  if (item.kind === "result") {
    return Object.keys(item).sort().join(",") === (delayMs === undefined ? "kind,value" : "delayMs,kind,value")
      && validJson(item.value);
  }
  if (item.kind !== "error" || Object.keys(item).sort().join(",") !== (delayMs === undefined ? "error,kind" : "delayMs,error,kind")
    || !item.error || typeof item.error !== "object" || Array.isArray(item.error)) return false;
  const error = item.error as Record<string, unknown>;
  return Object.keys(error).sort().join(",") === "code,message"
    && typeof error.code === "string" && /^[a-z0-9][a-z0-9._-]{0,199}$/.test(error.code)
    && typeof error.message === "string" && error.message.length > 0 && Buffer.byteLength(error.message) <= 4096;
}

export function parseDockerMockDebuggerBootstrap(value: unknown): DockerMockDebuggerBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mock debug bootstrap must be an object.");
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort().join(",");
  const expectedKeys = source.graph === undefined
    ? "assets,buildSha256,caseId,construction,expectations,invocation,kind,mocks,runConfiguration,schemaVersion,stopOnEntry"
    : "assets,buildSha256,caseId,construction,expectations,graph,invocation,kind,mocks,runConfiguration,schemaVersion,stopOnEntry";
  if (keys !== expectedKeys
    || source.schemaVersion !== 1 || source.kind !== "arkimux-mock-debugger-bootstrap" || source.stopOnEntry !== true
    || typeof source.caseId !== "string" || !boundedId.test(source.caseId)
    || typeof source.buildSha256 !== "string" || !digest.test(source.buildSha256)
    || !source.construction || typeof source.construction !== "object" || Array.isArray(source.construction)
    || !source.invocation || typeof source.invocation !== "object" || Array.isArray(source.invocation)
    || !Array.isArray(source.expectations) || !Array.isArray(source.assets)
    || !source.mocks || typeof source.mocks !== "object" || Array.isArray(source.mocks)) throw new Error("Mock debug bootstrap is invalid.");
  if (source.graph !== undefined) {
    if (!source.graph || typeof source.graph !== "object" || Array.isArray(source.graph)
      || Object.keys(source.graph as object).sort().join(",") !== "agentSlotIds,identity,request") throw new Error("Mock debug graph bootstrap is invalid.");
    const graph = source.graph as Record<string, unknown>;
    if (!validJson(graph.request) || !graph.identity || typeof graph.identity !== "object" || Array.isArray(graph.identity)
      || !validJson(graph.identity) || !Array.isArray(graph.agentSlotIds)
      || graph.agentSlotIds.some(value => typeof value !== "string" || !boundedId.test(value))
      || new Set(graph.agentSlotIds).size !== graph.agentSlotIds.length) throw new Error("Mock debug graph bootstrap is invalid.");
  }
  const construction = source.construction as Record<string, unknown>;
  if (construction.schemaVersion !== 1 || typeof construction.export !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(construction.export)
    || Object.keys(construction).sort().join(",") !== "export,schemaVersion") throw new Error("Mock debug construction descriptor is invalid.");
  let assetBytes = 0;
  const assetPaths = new Set<string>();
  if (source.assets.length > dockerMockDebuggerAssetCountLimit || source.assets.some(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value as object).sort().join(",") !== "byteLength,path,sha256") return true;
    const item = value as Record<string, unknown>;
    if (!validDockerMockDebuggerAssetPath(item.path) || assetPaths.has(item.path)
      || !Number.isSafeInteger(item.byteLength) || Number(item.byteLength) < 0
      || Number(item.byteLength) > dockerMockDebuggerAssetByteLimit
      || typeof item.sha256 !== "string" || !digest.test(item.sha256)) return true;
    assetPaths.add(item.path); assetBytes += Number(item.byteLength); return false;
  }) || assetBytes > dockerMockDebuggerAssetsTotalByteLimit) throw new Error("Mock debug retained assets are invalid.");
  const entries = Object.entries(source.mocks as Record<string, unknown>);
  if (entries.length > 100 || entries.some(([operationId, fixture]) => !mockOperationId.test(operationId)
    || !validMockFixture(fixture))) throw new Error("Mock debug fixtures are invalid.");
  const expectationIds = new Set<string>();
  if (source.expectations.length > 100 || source.expectations.some(item => {
    const parsed = headlessExpectationSchema.safeParse(item);
    if (!parsed.success || expectationIds.has(parsed.data.id)) return true;
    expectationIds.add(parsed.data.id); return false;
  })) throw new Error("Mock debug expectations are invalid.");
  return source as unknown as DockerMockDebuggerBootstrap;
}

export function parseDockerMockDebuggerBridgeRequest(value: unknown): DockerMockDebuggerBridgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridge request must be an object.");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "id,method,params,schemaVersion" || source.schemaVersion !== 1
    || typeof source.id !== "string" || !boundedId.test(source.id)
    || !source.params || typeof source.params !== "object" || Array.isArray(source.params)) throw new Error("Bridge request is invalid.");
  const params = source.params as Record<string, unknown>, keys = Object.keys(params).sort().join(",");
  const page = (offset: unknown, limit: unknown, max: number) => Number.isSafeInteger(offset) && Number(offset) >= 0
    && Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= max;
  const location = (item: unknown) => !!item && typeof item === "object" && !Array.isArray(item)
    && Object.keys(item as object).every(key => ["breakpointId", "sourceId", "line", "column", "condition", "logExpression"].includes(key))
    && ["breakpointId", "sourceId", "line", "column"].every(key => Object.hasOwn(item as object, key))
    && typeof (item as Record<string, unknown>).breakpointId === "string" && boundedId.test((item as Record<string, unknown>).breakpointId as string)
    && typeof (item as Record<string, unknown>).sourceId === "string" && boundedId.test((item as Record<string, unknown>).sourceId as string)
    && Number.isSafeInteger((item as Record<string, unknown>).line) && Number((item as Record<string, unknown>).line) > 0
    && Number.isSafeInteger((item as Record<string, unknown>).column) && Number((item as Record<string, unknown>).column) > 0
    && ["condition", "logExpression"].every(key => (item as Record<string, unknown>)[key] === undefined
      || typeof (item as Record<string, unknown>)[key] === "string" && String((item as Record<string, unknown>)[key]).length > 0
        && String((item as Record<string, unknown>)[key]).length <= 4096);
  const empty = ["session.inspect", "session.close", "debug.inspect"].includes(String(source.method)) && keys === "";
  const inputFile = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).sort().join(",") === "byteLength,mediaType,objectId,sha256"
    && typeof (value as Record<string, unknown>).objectId === "string" && boundedId.test((value as Record<string, unknown>).objectId as string)
    && typeof (value as Record<string, unknown>).mediaType === "string" && String((value as Record<string, unknown>).mediaType).length > 0
    && String((value as Record<string, unknown>).mediaType).length <= 200
    && Number.isSafeInteger((value as Record<string, unknown>).byteLength) && Number((value as Record<string, unknown>).byteLength) >= 0
    && typeof (value as Record<string, unknown>).sha256 === "string" && digest.test((value as Record<string, unknown>).sha256 as string);
  const inputResponse = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value as object).sort().join(",") !== "fields,files,schemaVersion") return false;
    const response = value as Record<string, unknown>;
    if (response.schemaVersion !== 1 || !response.fields || typeof response.fields !== "object" || Array.isArray(response.fields)
      || !response.files || typeof response.files !== "object" || Array.isArray(response.files)) return false;
    return Object.entries(response.fields as Record<string, unknown>).every(([key, item]) => boundedId.test(key)
      && (typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)))
      && Object.entries(response.files as Record<string, unknown>).every(([key, item]) => boundedId.test(key)
        && Array.isArray(item) && item.length <= 10 && item.every(inputFile));
  };
  const respond = source.method === "case.respond" && keys === "caseId,expectedRevision,requestId,response,submissionId"
    && typeof params.caseId === "string" && boundedId.test(params.caseId)
    && typeof params.requestId === "string" && boundedId.test(params.requestId)
    && typeof params.submissionId === "string" && boundedId.test(params.submissionId)
    && Number.isSafeInteger(params.expectedRevision) && Number(params.expectedRevision) > 0 && inputResponse(params.response);
  const sources = source.method === "debug.sources" && keys === "limit,offset" && page(params.offset, params.limit, 100);
  const read = source.method === "debug.source.read" && keys === "limit,offset,sourceId" && typeof params.sourceId === "string"
    && boundedId.test(params.sourceId) && page(params.offset, params.limit, 262144);
  const breakpoints = source.method === "debug.breakpoints.set" && keys === "breakpoints" && Array.isArray(params.breakpoints)
    && params.breakpoints.length <= 100 && params.breakpoints.every(location)
    && new Set(params.breakpoints.map(item => (item as Record<string, unknown>).breakpointId)).size === params.breakpoints.length;
  const pause = source.method === "debug.pause" && keys === "attemptId" && typeof params.attemptId === "string" && boundedId.test(params.attemptId);
  const resume = source.method === "debug.continue" && keys === "pauseId" && typeof params.pauseId === "string" && boundedId.test(params.pauseId);
  const step = source.method === "debug.step" && keys === "kind,pauseId" && typeof params.pauseId === "string" && boundedId.test(params.pauseId)
    && ["into", "over", "out"].includes(String(params.kind));
  const stack = source.method === "debug.stack" && keys === "limit,offset,pauseId" && typeof params.pauseId === "string"
    && boundedId.test(params.pauseId) && page(params.offset, params.limit, 100);
  const scopes = source.method === "debug.scopes" && keys === "frameId,pauseId"
    && typeof params.pauseId === "string" && boundedId.test(params.pauseId)
    && typeof params.frameId === "string" && boundedId.test(params.frameId);
  const properties = source.method === "debug.properties" && keys === "limit,objectId,offset,pauseId"
    && typeof params.pauseId === "string" && boundedId.test(params.pauseId)
    && typeof params.objectId === "string" && boundedId.test(params.objectId)
    && page(params.offset, params.limit, 100);
  const expression = (value: unknown) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096;
  const evaluate = source.method === "debug.evaluate" && keys === "evaluationId,expression,frameId,pauseId"
    && typeof params.pauseId === "string" && boundedId.test(params.pauseId)
    && typeof params.frameId === "string" && boundedId.test(params.frameId)
    && typeof params.evaluationId === "string" && boundedId.test(params.evaluationId) && expression(params.expression);
  const setVariable = source.method === "debug.variable.set" && keys === "controlId,expression,frameId,name,pauseId"
    && typeof params.pauseId === "string" && boundedId.test(params.pauseId)
    && typeof params.frameId === "string" && boundedId.test(params.frameId)
    && typeof params.controlId === "string" && boundedId.test(params.controlId)
    && typeof params.name === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(params.name) && expression(params.expression);
  if (!empty && !respond && !sources && !read && !breakpoints && !pause && !resume && !step && !stack && !scopes && !properties
    && !evaluate && !setVariable) {
    throw new Error("Bridge request is invalid.");
  }
  return source as unknown as DockerMockDebuggerBridgeRequest;
}
