const json = { parse: value => structuredClone(value) };
const step = (id, execute) => ({ schemaVersion: 1, id, definitionVersion: "v1", input: json, output: json, execute });
const operation = id => ({ schemaVersion: 1, operationId: id, slotId: "author", output: json });
function defineInputWorkflow(construction) { return {
  workflow: { kind: "input-demo", version: 1 }, workflowContractVersion: "input-demo-v1", resultKind: "input-demo-result-v1",
  input: json, output: json,
  async execute(context, input) {
    const before = await context.steps.run(step("before", async c => c.agents.invoke(operation("before-agent"), input)), input);
    const answer = await context.steps.waitForInput({ id: "ask", title: "Your city", expiresAfter: "366d", form: {
      descriptor: { schemaVersion: 1, id: "city-form", version: "v1", fields: [{ id: "city", label: "City", type: "text", required: true, maxLength: 50 }] }, output: json,
    } });
    const after = await context.steps.run(step("after", async (c, value) => c.agents.invoke(operation("after-agent"), value)), answer.output);
    return { before: before.output, answer: answer.output, after: after.output, originalInput: input, marker: "original", construction };
  },
}; }

export function createInputWorkflow(context) {
  const prompt = new TextDecoder().decode(context.readAsset("src/prompt.md"));
  return { workflow: defineInputWorkflow({ config: context.runConfiguration.marker, prompt }),
    agentPrompts: { author: prompt } };
}
