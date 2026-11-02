import { z } from "zod";

const text = (max: number) => z.string().min(1).max(max).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value), "Must be trimmed text without control characters.");
const city = text(120).refine((value) => value !== "." && value !== "..", "City must name a location.");
export const weatherInputSchema = z.object({ schemaVersion: z.literal(1), city: city.describe("City whose current weather is used for clothing advice.") }).strict()
  .meta({ title: "Weather location", description: "Choose the city for this Weather Advisor Run.", examples: [{ schemaVersion: 1, city: "Istanbul" }] });
export const WTTR_HTTP_FALLBACK_WARNING = "Weather fetched over unencrypted HTTP because the HTTPS certificate expired.";
const weatherSnapshotV1Schema = z.object({
  summary: text(200), temperatureC: z.number().finite().min(-100).max(70),
  feelsLikeC: z.number().finite().min(-100).max(70), windKph: z.number().finite().min(0).max(500),
  precipitationMm: z.number().finite().min(0).max(1000),
}).strict();
export const weatherSnapshotSchema = weatherSnapshotV1Schema.extend({
  transportWarning: z.literal(WTTR_HTTP_FALLBACK_WARNING).optional(),
});
export const recommendationSchema = z.object({
  summary: text(1000),
  clothing: z.array(z.object({ item: text(120), reason: text(500) }).strict()).min(1).max(8),
  cautions: z.array(text(500)).max(8),
}).strict();
export const critiqueSchema = z.object({
  verdict: z.enum(["reasonable", "needs-review"]), issues: z.array(text(500)).max(8), adjustedAdvice: text(1000),
}).strict().refine((value) => value.verdict !== "needs-review" || value.issues.length > 0, "A needs-review critique must explain an issue.");
const weatherResultV1Schema = z.object({
  schemaVersion: z.literal(1), city, weather: weatherSnapshotV1Schema,
  recommendation: recommendationSchema, critique: critiqueSchema,
}).strict();
export const weatherResultSchema = weatherResultV1Schema.extend({
  schemaVersion: z.literal(2), weather: weatherSnapshotSchema,
});
// Retained results keep their original payload version; never rewrite them.
export const readableWeatherResultSchema = z.discriminatedUnion("schemaVersion", [weatherResultV1Schema, weatherResultSchema]);
export const WEATHER_RESULT_KIND = "weather-advisor.result";
export type WeatherInput = z.infer<typeof weatherInputSchema>;
export type WeatherSnapshot = z.infer<typeof weatherSnapshotSchema>;
export type WeatherResult = z.infer<typeof weatherResultSchema>;
