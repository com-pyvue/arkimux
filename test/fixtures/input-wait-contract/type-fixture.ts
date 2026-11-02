import type { CompletedStepV1 } from "../../../core/src/application/durableWorkflow.ts";
import type {
  ImmutableInputFileRefV1,
  InputFormV1,
  InputRequestV1,
  InputWaitDurationV1,
  WorkflowExecutionContextV2,
} from "./contracts.d.ts";

type TripResponse = {
  schemaVersion: 1;
  fields: { travelDate: string };
  files: { itinerary: ImmutableInputFileRefV1[] };
};

declare const context: WorkflowExecutionContextV2;
declare const form: InputFormV1<TripResponse>;

async function example() {
  const supplied = await context.steps.waitForInput({
    id: "collect-trip-details", title: "Add trip details", form, expiresAfter: "24h",
  });
  const envelope: CompletedStepV1<InputRequestV1, TripResponse> = supplied;
  const date: string = envelope.output.fields.travelDate;
  const fileId: string | undefined = envelope.output.files.itinerary[0]?.objectId;
  // @ts-expect-error Accepted answers cannot be edited through the completed envelope.
  supplied.output.fields.travelDate = "2026-10-02";
  // @ts-expect-error Accepted file references are immutable, including their array.
  supplied.output.files.itinerary.push({ objectId: "another" });
  // @ts-expect-error The inferred response does not include undeclared fields.
  const unknownField = supplied.output.fields.city;
  return { date, fileId, unknownField };
}

// @ts-expect-error Calendar months are not a supported fixed wait duration.
const invalidDuration: InputWaitDurationV1 = "1month";
// @ts-expect-error Paths cannot substitute for immutable uploaded object references.
const invalidFile: ImmutableInputFileRefV1 = { path: "/tmp/itinerary.txt" };
void example;
void invalidDuration;
void invalidFile;
