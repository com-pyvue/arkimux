import { graphResultSchema } from "./contract.js";

export function GraphInvocationResult({ payload }: { payload: unknown }) {
  const result = graphResultSchema.parse(payload);
  return <article style={{ fontFamily: "system-ui", padding: 24, lineHeight: 1.5 }}>
    <h1>Graph invocation result</h1>
    <p>Step 1: {result.output1.original} → {result.output1.incremented}</p>
    <p>Step 2 base: {result.output2.base}</p>
    <p>Branch: {result.branch.selected} → {result.branch.value}</p>
    <p>Ordered map: {result.mapped.join(", ")}</p>
    <p>Reduce: {result.reduced}</p>
    <p>Loop: {result.looped}</p>
  </article>;
}
