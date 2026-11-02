import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWeatherAdvisor } from "../../cli/scaffold/workflows/weather-advisor/src/workflow.ts";
import { weatherCurrentEffect } from "../../cli/scaffold/workflows/weather-advisor/src/weather-effect-contract.ts";
import { WTTR_HTTP_FALLBACK_WARNING, type WeatherSnapshot } from "../../cli/scaffold/workflows/weather-advisor/src/contract.ts";
import { DurableWorkflowEngineV2 } from "../../core/src/application/durableWorkflowEngine.ts";
import { DurableGraphSchedulerV1 } from "../../core/src/application/durableGraphScheduler.ts";
import { createLocalDurableExecutionStorage } from "../../local/src/localDurableWorkflowRuntime.ts";
import type { JsonValue } from "../../core/src/application/durableWorkflow.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const weather = { summary: "Clear", temperatureC: 20, feelsLikeC: 19, windKph: 8, precipitationMm: 0.2 };
const recommendation = { summary: "Layers", clothing: [{ item: "Jacket", reason: "Wind" }], cautions: [] };
const critique = { verdict: "needs-review", issues: ["Check later weather"], adjustedAdvice: "Bring a warmer layer" };

describe("generated Weather Advisor durable workflow", () => {
  async function fixture(failure?: "weather" | "recommendation" | "critique", weatherOutput: WeatherSnapshot = weather) {
    const root = await mkdtemp(path.join(tmpdir(), "weather-workflow-")); roots.push(root);
    const calls: string[] = [];
    const definition = defineWeatherAdvisor(weatherCurrentEffect);
    const storage = createLocalDurableExecutionStorage(root, { executionId: "weather-test" });
    const run = (fence = 1) => {
      const engine = new DurableWorkflowEngineV2({ storage, effects: {
      async execute<EffectInput extends JsonValue, EffectOutput extends JsonValue>(request: {
        definition: { operationId: string }; context: { deadlineAt: string }; input: EffectInput;
      }) {
        expect(request.definition.operationId).toBe("weather.current");
        expect(Date.parse(request.context.deadlineAt) - Date.now()).toBeLessThanOrEqual(540_000);
        calls.push("weather"); if (failure === "weather") throw new Error("Weather read failed");
        return weatherOutput as unknown as EffectOutput;
      },
      async reconcile() { throw new Error("No reconcilable effects expected."); },
    }, agents: {
      resolve: () => ({ providerId: "fixture", authProviderId: "fixture-session", configurationSha256: "a".repeat(64) }),
      async invoke(request) {
        calls.push(request.operation.slotId);
        expect(request.input).toMatchObject({ city: "Istanbul", weather: weatherOutput });
        const output: JsonValue = request.operation.slotId === failure ? {} : request.operation.slotId === "recommendation" ? recommendation : critique;
        return { output: request.operation.output.parse(output) };
      },
      } });
      const host = {
      schemaVersion: 1, runRef: { executionId: "weather-test" }, attemptId: `attempt-${fence}`, fence,
      deadlineAt: new Date(Date.now() + 540_000).toISOString(), finalizationReserveMs: 50_000,
      scratchDirectory: path.join(root, "scratch"), limits: { maxDurationMs: 540_000, maxScratchBytes: 1_000_000 },
      cancellation: { aborted: false }, heartbeat: async () => {},
      } as const;
      return new DurableGraphSchedulerV1({ engine }).execute({ graph: definition, host,
        input: { schemaVersion: 1, city: "Istanbul" } });
    };
    return { run, calls, root };
  }
  it("completes three steps, preserves a needs-review result and replays without effects or inference", async () => {
    const { run, calls, root } = await fixture();
    const result = await run();
    expect(result).toEqual({ schemaVersion: 2, city: "Istanbul", weather, recommendation, critique });
    expect(calls).toEqual(["weather", "recommendation", "critique"]);
    expect(await run(2)).toEqual(result);
    expect(calls).toHaveLength(3);
    const files = await readTree(path.join(root, ".arkimux/local/runs/weather-test/durable"));
    expect(files.filter(({ name }) => name.includes("/steps/") && name.endsWith(".json")).length).toBeGreaterThanOrEqual(4);
    expect(files.some(({ name }) => name.includes("/effects/"))).toBe(true);
    expect(files.some(({ name }) => name.includes("/agents/"))).toBe(true);
  });
  it.each([
    ["weather", ["weather"]],
    ["recommendation", ["weather", "recommendation"]],
    ["critique", ["weather", "recommendation", "critique"]],
  ] as const)("stops after invalid %s with no downstream callback", async (failure, expected) => {
    const { run, calls } = await fixture(failure);
    await expect(run()).rejects.toThrow();
    expect(calls).toEqual(expected);
  });
  it("persists the weather-only warning through completed steps, results and replay without repeating inference", async () => {
    const warnedWeather = { ...weather, transportWarning: WTTR_HTTP_FALLBACK_WARNING };
    const { run, calls, root } = await fixture(undefined, warnedWeather);
    const result = await run();
    expect(result).toEqual({ schemaVersion: 2, city: "Istanbul", weather: warnedWeather, recommendation, critique });
    expect(await run(2)).toEqual(result);
    expect(calls).toEqual(["weather", "recommendation", "critique"]);
    const files = await readTree(path.join(root, ".arkimux/local/runs/weather-test/durable"));
    const weatherStep = files.find(({ name, text }) => name.includes("/steps/") && text.includes(WTTR_HTTP_FALLBACK_WARNING));
    expect(weatherStep?.text).toContain(WTTR_HTTP_FALLBACK_WARNING);
  });
});
async function readTree(root: string): Promise<{ name: string; text: string }[]> {
  const files: { name: string; text: string }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await readTree(name));
    else files.push({ name, text: await readFile(name, "utf8") });
  }
  return files;
}
