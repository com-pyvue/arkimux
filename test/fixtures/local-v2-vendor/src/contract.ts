import { z } from "zod";
const text = (max: number) => z.string().min(1).max(max).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  "Must be trimmed text without control characters.",
);
const uniqueText = (maxItems: number, maxLength: number, minItems = 1) => z.array(text(maxLength))
  .min(minItems).max(maxItems).refine(
    (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
    "Items must be unique ignoring case.",
  );
export const vendorInputSchema = z.object({
  schemaVersion: z.literal(1),
  vendors: uniqueText(5, 120, 2),
  requirements: uniqueText(10, 300),
}).strict();
export const vendorResultSchema = z.object({
  schemaVersion: z.literal(1),
  recommendation: z.object({
    status: z.literal("needs-evidence"),
    vendor: z.null(),
    rationale: text(1500),
  }).strict(),
  alternatives: z.array(z.object({ vendor: text(120), rationale: text(1000) }).strict()).min(2).max(5),
  risks: z.array(z.object({ risk: text(500), mitigation: text(500) }).strict()).min(1).max(8),
  nextSteps: uniqueText(8, 500),
}).strict();

export function validateVendorResultForInput(inputValue: unknown, resultValue: unknown) {
  const input = vendorInputSchema.parse(inputValue);
  const result = vendorResultSchema.parse(resultValue);
  const actual = result.alternatives.map(({ vendor }) => vendor);
  if (actual.length !== input.vendors.length
    || new Set(actual).size !== actual.length
    || actual.some((vendor) => !input.vendors.includes(vendor))) {
    throw new Error("Vendor alternatives must name each input vendor exactly once.");
  }
  return result;
}


export type VendorInput = z.infer<typeof vendorInputSchema>;
