import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProjectResultViewSource } from "@com-pyvue/arkimux";
import { assertLocalWorkflowDeclarations } from "@com-pyvue/agent-execution-local";
import { describeGraphV1, describeGraphEntryV1, admitGraphInvocationV1 } from "@com-pyvue/agent-execution-core";
import { constructWeatherAdvisor } from "../workflows/weather-advisor/src/construction.js";
import { weatherInputSchema, weatherResultSchema, readableWeatherResultSchema, WTTR_HTTP_FALLBACK_WARNING, critiqueSchema } from "../workflows/weather-advisor/src/contract.js";
import { createWeatherEffect, weatherRequestUrl } from "../workflows/weather-advisor/src/weather-effect.js";

const raw = { current_condition: [{ weatherDesc: [{ value: "Clear" }], temp_C: "20", FeelsLikeC: "19", windspeedKmph: "8", precipMM: "0.2" }] };
const context = { stableOperationId: "fixture", deadlineAt: new Date(Date.now() + 60_000).toISOString(), cancellation: { aborted: false } };
const weather = { summary: "Clear", temperatureC: 20, feelsLikeC: 19, windKph: 8, precipitationMm: 0.2 };
const adapterContext = (base: string) => ({ environment: { WEATHER_API_URL: base }, credentials: {}, runConfiguration: null });

test("Weather Advisor declares its diagram and retained prompt construction without executing providers", async () => {
  const assets: string[] = [];
  const { graph, agentPrompts } = constructWeatherAdvisor({
    runConfiguration: null,
    readAsset(name) { assets.push(name); return new TextEncoder().encode(`Pinned ${name}`); } });
  assert.equal(graph.workflowContractVersion, "4");
  assert.deepEqual(graph.input.validator.parse({ schemaVersion: 1, city: "Istanbul" }), weatherInputSchema.parse({ schemaVersion: 1, city: "Istanbul" }));
  assert.throws(() => graph.input.validator.parse({ schemaVersion: 1, city: " " }));
  assert.throws(() => graph.output.validator.parse({ schemaVersion: 1 }));
  assert.deepEqual(graph.nodes.map(node => node.id), ["read-weather", "recommend-clothing", "critique-clothing", "assemble-result"]);
  const diagram = describeGraphV1(graph);
  assert.equal(diagram.scopes.length, 1);
  assert(diagram.nodes.some(node => node.id === "root/node/read-weather"));
  assert.equal(assets.length, 2);
  assert(agentPrompts.recommendation.includes("Recommendation schema:"));
  assert(agentPrompts.critique.includes("Critique schema:"));
  const entry = { kind: "default" } as const;
  const plan = describeGraphEntryV1(graph, entry);
  assert.deepEqual(plan.requirements.map(requirement => requirement.id), ["entry"]);
  assert.equal(admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "supplied", entry,
    values: { entry: { schemaVersion: 1, city: "Istanbul" } } }).acquisition, "supplied");
  assert.equal(admitGraphInvocationV1(graph, { schemaVersion: 1, acquisition: "deferred", entry, wait: { duration: "1d" } }).acquisition, "deferred");
});

test("loaded workflow registration matches its declared result version without starting a server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "weather-registration-"));
  try {
    const source = fileURLToPath(new URL("../", import.meta.url));
    for (const directory of ["src", "workflows"]) await cp(path.join(source, directory), path.join(root, directory), { recursive: true });
    // Resolve the same installed packages while keeping the developer's .env and Runs untouched.
    const dependencies = createRequire(import.meta.url).resolve.paths("@com-pyvue/agent-execution-local")
      ?.find(directory => existsSync(path.join(directory, "@com-pyvue/agent-execution-local")));
    assert(dependencies, "Installed ArkiMux packages are required");
    await symlink(dependencies, path.join(root, "node_modules"));
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await writeFile(path.join(root, ".env"), "WEATHER_API_URL=https://wttr.in\n");
    const { loadProjectWorkflows, workflowDeclarations } = await import(pathToFileURL(path.join(root, "src/arkimux.workflows.ts")).href);
    const workflows = await loadProjectWorkflows(root);
    assert.equal(workflows[0].invocationModel, "graph-entry");
    await assertLocalWorkflowDeclarations({ repositoryRoot: root, declarations: workflowDeclarations, workflows });
    await assert.rejects(assertLocalWorkflowDeclarations({ repositoryRoot: root, workflows,
      declarations: workflowDeclarations.map((declaration: { result: object }) => ({ ...declaration, result: { ...declaration.result, schemaVersion: 1 } })),
    }), /metadata/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("city, weather and critique contracts reject ambiguous or invalid data", () => {
  for (const city of ["", " ", " Istanbul", ".", "..", "x\n", "a".repeat(121)]) assert.equal(weatherInputSchema.safeParse({ schemaVersion: 1, city }).success, false);
  assert.equal(weatherInputSchema.safeParse({ schemaVersion: 1, city: "São Paulo" }).success, true);
  assert.equal(critiqueSchema.safeParse({ verdict: "needs-review", issues: [], adjustedAdvice: "Review it" }).success, false);
});

test("URL uses the configured path and query with exactly one encoded city segment", () => {
  assert.equal(weatherRequestUrl("https://weather.example/base/?token=fixture&format=old#fragment", "São Paulo/a?b").href,
    "https://weather.example/base/S%C3%A3o%20Paulo%2Fa%3Fb?token=fixture&format=j1");
  for (const base of ["", "weather.example", "ftp://example.org", "https://u:p@example.org", "https://example.org\\x"]) {
    assert.throws(() => createWeatherEffect(adapterContext(base)), /WEATHER_API_URL/);
  }
});

test("one bounded HTTP GET normalizes weather; failures disclose no URL and do not redirect", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    assert.equal(request.method, "GET");
    if (request.url!.startsWith("/redirect/")) { response.writeHead(302, { location: "/ok/elsewhere" }); response.end(); }
    else if (request.url!.startsWith("/large/")) response.end("x".repeat(262_145));
    else if (request.url!.startsWith("/invalid/")) response.end(JSON.stringify({ current_condition: [{}] }));
    else if (request.url!.startsWith("/slow/")) { response.writeHead(200); response.write("{"); }
    else response.end(JSON.stringify(raw));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.deepEqual(await createWeatherEffect(adapterContext(`${base}/ok?source=fixture`)).execute(context, { schemaVersion: 1, city: "São Paulo" }), weather);
    assert.equal(requests[0], "/ok/S%C3%A3o%20Paulo?source=fixture&format=j1");
    for (const route of ["redirect", "large", "invalid", "slow"]) {
      const before = requests.length;
      await assert.rejects(createWeatherEffect(adapterContext(`${base}/${route}?private=test`)).execute({ ...context, deadlineAt: new Date(Date.now() + 300).toISOString() }, { schemaVersion: 1, city: "Istanbul" }), (error: unknown) => {
        assert(error instanceof Error); assert(!error.message.includes(base)); assert(!error.message.includes("private")); return true;
      });
      assert.equal(requests.length, before + 1, "No retry or followed redirect");
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("result renderer preserves needs-review and units, and escapes untrusted text", async () => {
  const payload = weatherResultSchema.parse({ schemaVersion: 2, city: "<script>alert(1)</script>", weather,
    recommendation: { summary: "Take a jacket", clothing: [{ item: "Jacket", reason: "Cool wind" }], cautions: [] },
    critique: { verdict: "needs-review", issues: ["Check evening temperature"], adjustedAdvice: "Bring a warmer layer" } });
  // Use Local's public loader so supported component/CSS imports work in tests too.
  const source = await createProjectResultViewSource(fileURLToPath(new URL("../", import.meta.url)));
  try {
    const snapshot = source.snapshot();
    assert.equal(snapshot.status, "ready");
    const view = snapshot.views.find((entry) => entry.resultKind === "weather-advisor.result" && entry.payloadSchemaVersion === 2);
    assert(view, "Weather Advisor result renderer is registered");
    const html = await view.render(payload);
    for (const text of ["needs-review", "°C", "km/h", "mm", "Check evening temperature", "Bring a warmer layer", "&lt;script&gt;"]) assert(html.includes(text));
    assert(!html.includes("<script>"));
    assert(!html.includes('role="alert"'));
    const insecure = weatherResultSchema.parse({ ...payload, weather: { ...weather, transportWarning: WTTR_HTTP_FALLBACK_WARNING } });
    const insecureHtml = await view.render(insecure);
    assert(insecureHtml.includes('role="alert"'));
    assert(insecureHtml.includes("Warning: insecure weather connection"));
    assert(insecureHtml.includes(WTTR_HTTP_FALLBACK_WARNING));
    const legacy = { ...payload, schemaVersion: 1 };
    assert.deepEqual(readableWeatherResultSchema.parse(legacy), legacy);
    assert.equal(weatherResultSchema.safeParse(legacy).success, false);
    assert.equal(readableWeatherResultSchema.safeParse({ ...insecure, schemaVersion: 1 }).success, false);
    assert.equal(weatherResultSchema.safeParse({ ...payload, weather: { ...weather, transportWarning: "untrusted warning" } }).success, false);
    await assert.rejects(async () => view.render({}));
  } finally { await source.close(); }
});
