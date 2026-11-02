/** Public input-wait@1 contracts. Execution is supplied by a V2-capable host, not the V1 engine. */
import type {
  CompletedStepV1,
  ValueValidatorV1,
  WorkflowExecutionContextV1,
  WorkflowStepOperationsV1,
} from "./durableWorkflow.ts";
import { assertDurableIdentifier, hashJson, immutableJson, type DeepReadonly, type JsonValue } from "./durableWorkflow.ts";
import { assertExactKeys } from "../domain/validation.ts";
import { canonicalTimestamp, record } from "./recordValidation.ts";

type FieldBase = { id: string; label: string; required: boolean };
export type InputFieldV1 = FieldBase & (
  | { type: "text"; maxLength: number }
  | { type: "number"; min: number; max: number; integer: boolean }
  | { type: "boolean" }
  | { type: "date" }
  | { type: "choice"; options: string[] }
  | { type: "files"; maxFiles: number; maxBytesPerFile: number; mediaTypes: string[] }
);
export type InputFormDescriptorV1 = {
  schemaVersion: 1;
  id: string;
  version: string;
  fields: InputFieldV1[];
};
export type ImmutableInputFileRefV1 = {
  objectId: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
};
export type InputResponseV1 = {
  schemaVersion: 1;
  fields: { [id: string]: string | number | boolean };
  files: { [id: string]: ImmutableInputFileRefV1[] };
};
export const INPUT_UPLOAD_MAX_FILES_PER_FIELD = 10;
export const INPUT_UPLOAD_MAX_BYTES_PER_FILE = 25 * 1024 * 1024;
export const INPUT_UPLOAD_MAX_BYTES_PER_REQUEST = 100 * 1024 * 1024;
export const INPUT_UPLOAD_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export interface InputFormV1<Response extends InputResponseV1> {
  readonly descriptor: InputFormDescriptorV1;
  readonly output: ValueValidatorV1<Response>;
}
/** Fixed definition, not the mutable request-state record. */
export type InputRequestV1 = {
  schemaVersion: 1;
  requestId: string;
  stepId: string;
  title: string;
  form: InputFormDescriptorV1;
  formSha256: string;
  executableBindingId: string;
  createdAt: string;
  expiresAt: string;
};
/** Runtime validation must enforce positive integers and the 366-day maximum. */
export type InputWaitDurationV1 = `${number}${"s" | "m" | "h" | "d"}`;
export interface WorkflowStepOperationsV2 extends WorkflowStepOperationsV1 {
  waitForInput<Response extends InputResponseV1>(options: {
    id: string;
    title: string;
    form: InputFormV1<Response>;
    expiresAfter: InputWaitDurationV1;
  }): Promise<CompletedStepV1<InputRequestV1, Response>>;
}
export interface WorkflowExecutionContextV2 extends WorkflowExecutionContextV1 {
  readonly steps: WorkflowStepOperationsV2;
}

const maximumWaitMs = 366 * 24 * 60 * 60 * 1000;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const text = (value: unknown): void => require(typeof value === "string" && value.length > 0, "Input form text must be nonempty.");
const integer = (value: unknown, minimum: number): void => require(Number.isSafeInteger(value) && (value as number) >= minimum, "Input form count must be a safe integer within its bounds.");
const identifier = (value: unknown): void => {
  require(typeof value === "string", "Input identifier must be a string.");
  assertDurableIdentifier(value as string, "Input identifier");
  require(!["__proto__", "prototype", "constructor"].includes(value as string), "Input identifier is reserved.");
};

/** Reject non-wire JavaScript values before using the shared immutable JSON/hash helpers. */
export function inputWaitJsonSnapshot(value: unknown): JsonValue {
  const active = new Set<object>();
  function check(item: unknown): void {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") { require(Number.isFinite(item), "Input must contain finite JSON numbers."); return; }
    require(typeof item === "object" && item !== null, "Input must be plain JSON.");
    const object = item as object;
    require(!active.has(object), "Input must not contain cycles.");
    const array = Array.isArray(object);
    require(array || [null, Object.prototype].includes(Object.getPrototypeOf(object)), "Input must use plain objects.");
    active.add(object);
    const keys = Reflect.ownKeys(object);
    if (array) require(keys.length === object.length + 1, "Input arrays must be dense and have no extra properties.");
    for (const key of keys) {
      if (array && key === "length") continue;
      require(typeof key === "string", "Input must not contain symbol keys.");
      if (array) require(/^(0|[1-9]\d*)$/.test(key as string) && Number(key) < object.length, "Input array has an invalid index.");
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      require(descriptor.enumerable && own(descriptor, "value"), "Input must not contain accessors or hidden values.");
      check(descriptor.value);
    }
    active.delete(object);
  }
  check(value);
  return structuredClone(value) as JsonValue;
}

export function parseInputWaitDurationV1(value: unknown): number {
  require(typeof value === "string", "Input wait duration must use a positive integer and s, m, h or d.");
  const match = /^([1-9]\d*)(s|m|h|d)$/.exec(value as string);
  require(match !== null, "Input wait duration must use a positive integer and s, m, h or d.");
  const amount = Number(match![1]), unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match![2]]!;
  const duration = amount * unit;
  require(Number.isSafeInteger(duration) && duration <= maximumWaitMs, "Input wait duration must not exceed 366 days.");
  return duration;
}

export function validateInputFormDescriptorV1(value: unknown): InputFormDescriptorV1 {
  const form = record(inputWaitJsonSnapshot(value), "Input form");
  assertExactKeys(form, ["schemaVersion", "id", "version", "fields"], "Input form");
  require(form.schemaVersion === 1, "Input form schema version must be 1."); identifier(form.id); identifier(form.version);
  require(Array.isArray(form.fields), "Input form fields must be an array.");
  const ids = new Set<string>();
  for (const item of form.fields as unknown[]) {
    const field = record(item, "Input field");
    const extra: Record<string, string[]> = { text: ["maxLength"], number: ["min", "max", "integer"], boolean: [], date: [], choice: ["options"], files: ["maxFiles", "maxBytesPerFile", "mediaTypes"] };
    require(typeof field.type === "string" && own(extra, field.type), "Input field type is unsupported.");
    assertExactKeys(field, ["id", "label", "required", "type", ...extra[field.type as string]], "Input field");
    identifier(field.id); text(field.label); require(typeof field.required === "boolean", "Input required must be boolean.");
    require(!ids.has(field.id as string), "Input field IDs must be unique."); ids.add(field.id as string);
    switch (field.type) {
      case "text": integer(field.maxLength, 1); break;
      case "number":
        require(typeof field.min === "number" && Number.isFinite(field.min) && typeof field.max === "number" && Number.isFinite(field.max) && field.min <= field.max, "Input number bounds are invalid.");
        require(typeof field.integer === "boolean", "Input integer must be boolean."); break;
      case "choice":
        require(Array.isArray(field.options) && field.options.length > 0 && field.options.every(option => typeof option === "string") && new Set(field.options).size === field.options.length, "Input choices must be unique strings."); break;
      case "files":
        integer(field.maxFiles, 1); integer(field.maxBytesPerFile, 1);
        require((field.maxFiles as number) <= INPUT_UPLOAD_MAX_FILES_PER_FIELD, `Input file count must not exceed ${INPUT_UPLOAD_MAX_FILES_PER_FIELD}.`);
        require((field.maxBytesPerFile as number) <= INPUT_UPLOAD_MAX_BYTES_PER_FILE, `Input file size must not exceed ${INPUT_UPLOAD_MAX_BYTES_PER_FILE} bytes.`);
        require(Array.isArray(field.mediaTypes) && field.mediaTypes.length > 0 && field.mediaTypes.every(media => typeof media === "string" && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(media)) && new Set(field.mediaTypes).size === field.mediaTypes.length, "Input file media types must be unique exact types."); break;
    }
  }
  return form as unknown as InputFormDescriptorV1;
}

export function inputFormDigestV1(value: unknown): string { return hashJson(validateInputFormDescriptorV1(value)); }

export function defineInputForm<Response extends InputResponseV1>(form: InputFormV1<Response>): InputFormV1<Response> {
  const descriptor = immutableJson(validateInputFormDescriptorV1(form.descriptor));
  require(typeof form.output?.parse === "function", "Input form needs an output validator.");
  // Preserve validators with methods relying on their receiver while pinning this function.
  const parse = form.output.parse.bind(form.output);
  return Object.freeze({ descriptor: descriptor as InputFormDescriptorV1, output: Object.freeze({ parse }) });
}

export class InputResponseShapeError extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}

/** Shape validation only. The upload service must separately verify retained bytes and Run/request ownership. */
export function validateInputResponseShapeV1(descriptor: unknown, value: unknown): InputResponseV1 {
  const form = validateInputFormDescriptorV1(descriptor);
  let invalidField = "$form";
  try {
    const response = record(inputWaitJsonSnapshot(value), "Input response");
    assertExactKeys(response, ["schemaVersion", "fields", "files"], "Input response");
    require(response.schemaVersion === 1, "Input response schema version must be 1.");
    const fields = record(response.fields, "Input response fields"), files = record(response.files, "Input response files");
    for (const [key, fieldValue] of Object.entries(fields)) {
      const field = form.fields.find(item => item.id === key && item.type !== "files");
      invalidField = field?.id ?? "$form";
      require(field !== undefined, "Input response contains an undeclared scalar field.");
      switch (field!.type) {
        case "text": require(typeof fieldValue === "string" && [...fieldValue].length <= field!.maxLength, "Input text exceeds its type or length bounds."); break;
        case "number": require(typeof fieldValue === "number" && fieldValue >= field!.min && fieldValue <= field!.max && (!field!.integer || Number.isInteger(fieldValue)), "Input number exceeds its type or value bounds."); break;
        case "boolean": require(typeof fieldValue === "boolean", "Input boolean has the wrong type."); break;
        case "choice": require(typeof fieldValue === "string" && field!.options.includes(fieldValue), "Input choice is not declared."); break;
        case "date": {
          require(typeof fieldValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fieldValue), "Input date must be YYYY-MM-DD.");
          const date = new Date(`${fieldValue}T00:00:00.000Z`);
          require(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === fieldValue, "Input date must be a real calendar date."); break;
        }
      }
    }
    for (const [key, list] of Object.entries(files)) {
      const field = form.fields.find(item => item.id === key);
      invalidField = field?.id ?? "$form";
      require(field?.type === "files", "Input response contains an undeclared file field.");
      if (field?.type !== "files") throw new Error("Input file field is missing.");
      require(Array.isArray(list) && list.length <= field.maxFiles && (!field.required || list.length > 0), "Input file count is invalid.");
      for (const item of list as unknown[]) {
        const file = record(item, "Input file reference");
        assertExactKeys(file, ["objectId", "mediaType", "byteLength", "sha256"], "Input file reference");
        identifier(file.objectId); integer(file.byteLength, 0);
        require(typeof file.mediaType === "string" && field.mediaTypes.includes(file.mediaType) && (file.byteLength as number) <= field.maxBytesPerFile, "Input file type or size is invalid.");
        require(typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256), "Input file digest must be SHA-256.");
      }
    }
    for (const field of form.fields) {
      invalidField = field.id;
      require(!field.required || own(field.type === "files" ? files : fields, field.id), "A required input field is missing.");
    }
    return response as unknown as InputResponseV1;
  } catch (error) { throw new InputResponseShapeError(invalidField, error instanceof Error ? error.message : "Invalid input response."); }
}

export function validateInputResponseV1<Response extends InputResponseV1>(form: InputFormV1<Response>, value: unknown): DeepReadonly<Response> {
  const fixed = defineInputForm(form);
  const raw = validateInputResponseShapeV1(fixed.descriptor, value);
  const parsed = fixed.output.parse(immutableJson(raw));
  const result = validateInputResponseShapeV1(fixed.descriptor, parsed);
  require(hashJson(raw.files) === hashJson(result.files), "Input output validator must preserve every file reference.");
  return immutableJson(result as Response);
}

export function validateInputRequestV1(value: unknown): InputRequestV1 {
  const request = record(inputWaitJsonSnapshot(value), "Input request");
  assertExactKeys(request, ["schemaVersion", "requestId", "stepId", "title", "form", "formSha256", "executableBindingId", "createdAt", "expiresAt"], "Input request");
  require(request.schemaVersion === 1, "Input request schema version must be 1.");
  for (const key of ["requestId", "stepId", "executableBindingId"]) identifier(request[key]);
  text(request.title); const form = validateInputFormDescriptorV1(request.form);
  require(request.formSha256 === inputFormDigestV1(form), "Input request form digest differs.");
  canonicalTimestamp(request.createdAt, "Input request creation"); canonicalTimestamp(request.expiresAt, "Input request expiry");
  const duration = Date.parse(request.expiresAt) - Date.parse(request.createdAt);
  require(duration > 0 && duration <= maximumWaitMs, "Input request expiry must be positive and at most 366 days after creation.");
  return { ...request, form } as InputRequestV1;
}
