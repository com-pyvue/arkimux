import { assertSafeIdentifier } from "../domain/identifiers.ts";
import { validateRunRef, type RunRef } from "../domain/runIdentity.ts";
import { assertExactKeys, isRecord } from "../domain/validation.ts";

export interface PublishedResultEnvelope<TPayload = unknown> {
  envelopeSchemaVersion: 1;
  resultKind: string;
  runRef: RunRef;
  payload: TPayload;
}

export interface PublishedResultRef {
  runRef: RunRef;
  resultKind: string;
  resultId: string;
}

export interface PublishedResultStore {
  publish<TPayload>(result: PublishedResultEnvelope<TPayload>): Promise<PublishedResultRef>;
}

export function validatePublishedResultEnvelope(
  value: unknown,
): PublishedResultEnvelope {
  if (!isRecord(value)) throw new Error("Published result envelope must be an object.");
  assertExactKeys(
    value,
    ["envelopeSchemaVersion", "resultKind", "runRef", "payload"],
    "Published result envelope",
  );
  if (value.envelopeSchemaVersion !== 1) {
    throw new Error("Published result envelope.envelopeSchemaVersion must be 1.");
  }
  assertSafeIdentifier(value.resultKind, "Published result envelope.resultKind");
  return {
    envelopeSchemaVersion: 1,
    resultKind: value.resultKind,
    runRef: validateRunRef(value.runRef),
    payload: structuredClone(value.payload),
  };
}
