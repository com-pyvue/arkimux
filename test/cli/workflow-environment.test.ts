import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadLocalWorkflowEnvironment,
  resolveWorkflowEnvironment,
  validateWorkflowEnvironmentDeclaration,
  type WorkflowEnvironmentDeclaration,
} from "../../local/src/workflowEnvironment.ts";

const weatherDeclaration: WorkflowEnvironmentDeclaration = {
  schemaVersion: 1,
  variables: [{ name: "WEATHER_API_URL", required: true, secret: false, type: "url" }],
};

const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow environment declarations", () => {
  it("validates versioned declarations without changing the source", () => {
    const validated = validateWorkflowEnvironmentDeclaration(weatherDeclaration);
    expect(validated).toEqual(weatherDeclaration);
    expect(validated).not.toBe(weatherDeclaration);
    expect(validated.variables[0]).not.toBe(weatherDeclaration.variables[0]);
  });

  it.each([
    null,
    [],
    { schemaVersion: 2, variables: [] },
    { schemaVersion: 1, variables: {} },
    { schemaVersion: 1, variables: [], value: "must-not-appear" },
    { schemaVersion: 1, variables: [], default: "must-not-appear" },
    { schemaVersion: 1, variables: [weatherDeclaration.variables[0], weatherDeclaration.variables[0]] },
  ])("rejects an invalid declaration without retaining values (%#)", (declaration) => {
    expect(() => validateWorkflowEnvironmentDeclaration(declaration)).toThrow();
    expect(errorText(() => validateWorkflowEnvironmentDeclaration(declaration))).not.toContain("must-not-appear");
  });

  it.each([
    { name: "weather_api_url" },
    { name: "1WEATHER" },
    { name: "WEATHER-API" },
    { name: "" },
    { name: "must-not-appear" },
    { required: "must-not-appear" },
    { secret: "must-not-appear" },
    { type: "must-not-appear" },
    { default: "must-not-appear" },
    { value: "must-not-appear" },
  ])("rejects invalid variable fields without echoing them (%#)", (patch) => {
    const declaration = { schemaVersion: 1, variables: [{ ...weatherDeclaration.variables[0], ...patch }] };
    expect(() => validateWorkflowEnvironmentDeclaration(declaration)).toThrow();
    expect(errorText(() => validateWorkflowEnvironmentDeclaration(declaration))).not.toContain("must-not-appear");
  });

  it("requires every variable field and rejects values hidden in unknown field names", () => {
    expect(() => validateWorkflowEnvironmentDeclaration({ schemaVersion: 1, variables: [{ name: "X" }] })).toThrow();
    const declaration = { ...weatherDeclaration, "must-not-appear": "ignored" };
    expect(errorText(() => validateWorkflowEnvironmentDeclaration(declaration))).not.toContain("must-not-appear");
    expect(() => validateWorkflowEnvironmentDeclaration({ ...weatherDeclaration, [Symbol("unknown")]: true })).toThrow();
    expect(() => validateWorkflowEnvironmentDeclaration(Object.defineProperty({ ...weatherDeclaration }, "default", { value: "must-not-appear" }))).toThrow();
  });
});

describe("workflow environment resolution", () => {
  it("returns only declared own values, preserving strings and not changing inputs", () => {
    const declaration: WorkflowEnvironmentDeclaration = {
      schemaVersion: 1,
      variables: [
        ...weatherDeclaration.variables,
        { name: "WORKFLOW_SECRET", required: true, secret: true, type: "string" },
        { name: "OPTIONAL_VALUE", required: false, secret: false, type: "string" },
      ],
    };
    const values = { WEATHER_API_URL: "http://127.0.0.1:8123/weather", WORKFLOW_SECRET: "  sensitive value  ", UNDECLARED: "excluded" };
    const original = { ...values };
    expect(resolveWorkflowEnvironment(declaration, values)).toEqual({ WEATHER_API_URL: values.WEATHER_API_URL, WORKFLOW_SECRET: values.WORKFLOW_SECRET });
    expect(values).toEqual(original);
    expect(Object.isFrozen(resolveWorkflowEnvironment(declaration, values))).toBe(true);
    expect(() => resolveWorkflowEnvironment(weatherDeclaration, Object.create(values))).toThrow("WEATHER_API_URL is missing");
  });

  it.each([undefined, "", "   "])("rejects missing required values with no fallback (%#)", (value) => {
    vi.stubEnv("WEATHER_API_URL", "https://shell-only.example");
    expect(() => resolveWorkflowEnvironment(weatherDeclaration, { WEATHER_API_URL: value })).toThrow("WEATHER_API_URL is missing");
  });

  it.each([
    "/relative/must-not-appear", "ftp://must-not-appear.example", "https:must-not-appear.example",
    "https://user:must-not-appear@example.test", "https://@must-not-appear.example",
    " https://must-not-appear.example", "https://must-not-appear.example/a b",
    "https://must-not-appear.example\\path", "https://must-not-appear.example/\u0000", "https://", "must-not-appear",
  ])("rejects invalid URLs without returning or retaining the value (%#)", (value) => {
    const message = errorText(() => resolveWorkflowEnvironment(weatherDeclaration, { WEATHER_API_URL: value }));
    expect(message).toContain("absolute HTTP(S) URL without userinfo");
    expect(message).not.toContain("must-not-appear");
  });

  it("accepts HTTP(S) URLs including loopback fixtures and keeps optional blanks absent", () => {
    expect(resolveWorkflowEnvironment(weatherDeclaration, { WEATHER_API_URL: "https://weather.example/v1" })).toEqual({ WEATHER_API_URL: "https://weather.example/v1" });
    expect(resolveWorkflowEnvironment(weatherDeclaration, { WEATHER_API_URL: "http://[::1]:8123" })).toEqual({ WEATHER_API_URL: "http://[::1]:8123" });
    expect(resolveWorkflowEnvironment({ schemaVersion: 1, variables: [{ name: "OPTIONAL", required: false, secret: false, type: "string" }] }, { OPTIONAL: " " })).toEqual({});
  });

  it("rejects non-string declared values without serializing them", () => {
    const values = { WEATHER_API_URL: { secret: "must-not-appear" } } as unknown as Record<string, string>;
    expect(errorText(() => resolveWorkflowEnvironment(weatherDeclaration, values))).toBe("Workflow environment variable WEATHER_API_URL must be a string.");
  });
});

describe("local workflow .env loading", () => {
  it("loads Node .env syntax, returns only declared values, and never mutates the host environment", async () => {
    const root = await fixtureRoot();
    vi.stubEnv("WEATHER_API_URL", "https://host-only.example");
    vi.stubEnv("UNDECLARED", "host-secret");
    const before = { ...process.env };
    await writeFile(path.join(root, ".env"), '# Local fixture\nexport WEATHER_API_URL="http://127.0.0.1:8123/weather"\nUNDECLARED=local-secret\n');
    expect(await loadLocalWorkflowEnvironment(root, weatherDeclaration)).toEqual({ WEATHER_API_URL: "http://127.0.0.1:8123/weather" });
    expect(process.env).toEqual(before);
  });

  it("does not fall back to .env.example, a parent .env, or process.env", async () => {
    const root = await fixtureRoot();
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(root, ".env"), "WEATHER_API_URL=https://parent.example\n");
    await writeFile(path.join(project, ".env.example"), "WEATHER_API_URL=https://example.example\n");
    vi.stubEnv("WEATHER_API_URL", "https://host.example");
    const invokeWeather = vi.fn();
    const invokeModel = vi.fn();
    await expect(loadLocalWorkflowEnvironment(project, weatherDeclaration).then((environment) => {
      invokeWeather(environment);
      invokeModel(environment);
    })).rejects.toThrow("WEATHER_API_URL is missing");
    expect(invokeWeather).not.toHaveBeenCalled();
    expect(invokeModel).not.toHaveBeenCalled();
  });

  it("accepts a missing .env only when no variables are required", async () => {
    const root = await fixtureRoot();
    vi.stubEnv("OPTIONAL", "host-value");
    expect(await loadLocalWorkflowEnvironment(root, { schemaVersion: 1, variables: [] })).toEqual({});
    expect(await loadLocalWorkflowEnvironment(root, { schemaVersion: 1, variables: [{ name: "OPTIONAL", required: false, secret: true, type: "string" }] })).toEqual({});
  });

  it("fails invalid file values before callbacks without exposing the value", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, ".env"), "WEATHER_API_URL=https://user:must-not-appear@example.test\n");
    const callback = vi.fn();
    const result = loadLocalWorkflowEnvironment(root, weatherDeclaration).then(callback);
    await expect(result).rejects.toThrow("absolute HTTP(S) URL without userinfo");
    await expect(result).rejects.not.toThrow("must-not-appear");
    expect(callback).not.toHaveBeenCalled();
  });

  it("reads changes only on another explicit load and leaves earlier snapshots unchanged", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, ".env"), "WEATHER_API_URL=https://first.example\n");
    const first = await loadLocalWorkflowEnvironment(root, weatherDeclaration);
    await writeFile(path.join(root, ".env"), "WEATHER_API_URL=https://second.example\n");
    expect(first).toEqual({ WEATHER_API_URL: "https://first.example" });
    expect(await loadLocalWorkflowEnvironment(root, weatherDeclaration)).toEqual({ WEATHER_API_URL: "https://second.example" });
  });

  it("sanitizes file read failures", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".env"));
    const result = loadLocalWorkflowEnvironment(root, weatherDeclaration);
    await expect(result).rejects.toThrow("Could not read the project's .env file.");
    await expect(result).rejects.not.toThrow(root);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-workflow-environment-"));
  temporaryRoots.push(root);
  return root;
}

function errorText(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("cause");
    return (error as Error).message;
  }
  throw new Error("Expected validation to fail.");
}
