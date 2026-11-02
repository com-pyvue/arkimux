import type { ComponentType } from "react";
import type {
  JsonValue,
  PublishedResultDto,
} from "@com-pyvue/agent-execution-run-contract";

const resultKindPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export interface ResultRendererProps<TPayload extends JsonValue = JsonValue> {
  result: PublishedResultDto<TPayload>;
}

export interface ResultReactPlugin<TPayload extends JsonValue = JsonValue> {
  resultKind: string;
  payloadSchemaVersion: number;
  Component: ComponentType<ResultRendererProps<TPayload>>;
  validatePayload(payload: unknown): TPayload;
}

/** Type-erased registration shape for a heterogeneous build-time plugin list. */
export type AnyResultReactPlugin = ResultReactPlugin<any>;

export class ResultRendererRegistry {
  readonly #plugins: ReadonlyMap<string, AnyResultReactPlugin>;
  readonly unavailableReason?: string;
  readonly unavailableTone?: "error" | "warning";

  constructor(plugins: readonly AnyResultReactPlugin[] = [], options: { unavailableReason?: string; unavailableTone?: "error" | "warning" } = {}) {
    this.unavailableReason = options.unavailableReason;
    this.unavailableTone = options.unavailableTone;
    const registered = new Map<string, AnyResultReactPlugin>();
    for (const plugin of plugins) {
      const key = resultRendererKey(plugin.resultKind, plugin.payloadSchemaVersion);
      if (registered.has(key)) {
        throw new Error(`Duplicate result renderer registration for ${key}.`);
      }
      registered.set(key, plugin);
    }
    this.#plugins = registered;
  }

  resolve(resultKind: string, schemaVersion: number): AnyResultReactPlugin | undefined {
    return this.#plugins.get(resultRendererKey(resultKind, schemaVersion));
  }

  list(): readonly AnyResultReactPlugin[] {
    return [...this.#plugins.values()];
  }
}

export function resultRendererKey(resultKind: string, schemaVersion: number): string {
  if (!resultKindPattern.test(resultKind)) {
    throw new Error(`Invalid result kind ${JSON.stringify(resultKind)}.`);
  }
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`Invalid payload schema version ${JSON.stringify(schemaVersion)}.`);
  }
  return `${resultKind}@${schemaVersion}`;
}

export function payloadSchemaVersion(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = Reflect.get(payload, "schemaVersion");
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}
