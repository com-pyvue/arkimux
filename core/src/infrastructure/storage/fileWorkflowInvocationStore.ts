import { promises as fs } from "node:fs";
import path from "node:path";
import {
  validateWorkflowInvocationV1,
  type WorkflowInvocationStoreV1,
  type WorkflowInvocationV1,
} from "../../application/durableWorkflowInvocation.ts";
import { hashJson, type JsonValue } from "../../application/durableWorkflow.ts";
import { DurableRecordConflictError } from "../../application/durableExecution.ts";
import { validateRunRef, type RunRef } from "../../domain/runIdentity.ts";

export interface FileWorkflowInvocationStoreOptions { readonly root: string }

/** Stores exactly one immutable invocation at `<run>/durable/invocation.json`. */
export class FileWorkflowInvocationStoreV1 implements WorkflowInvocationStoreV1 {
  readonly #file: string;

  constructor(options: FileWorkflowInvocationStoreOptions) {
    this.#file = path.join(path.resolve(options.root), "invocation.json");
  }

  async create<Input extends JsonValue>(invocation: WorkflowInvocationV1<Input>): Promise<void> {
    const validated = validateWorkflowInvocationV1<Input>(invocation);
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    try {
      await fs.writeFile(this.#file, serialize(validated), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stored = await this.read<Input>(validated.runRef);
      if (stored && hashJson(stored) === hashJson(validated)) return;
      throw new DurableRecordConflictError("Workflow invocation already exists with different content.");
    }
  }

  async read<Input extends JsonValue>(runRef: RunRef): Promise<WorkflowInvocationV1<Input> | undefined> {
    const expected = validateRunRef(runRef);
    try {
      const invocation = validateWorkflowInvocationV1<Input>(JSON.parse(await fs.readFile(this.#file, "utf8")) as unknown);
      if (invocation.runRef.executionId !== expected.executionId) {
        throw new DurableRecordConflictError("Workflow invocation Run reference does not match its storage boundary.");
      }
      return invocation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
