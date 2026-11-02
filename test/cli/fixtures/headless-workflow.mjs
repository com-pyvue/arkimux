const identity = { parse: value => value };
const recordExecution = { schemaVersion: 1, operationId: 'record-fixture', definitionVersion: 'v1',
  safety: 'idempotent-write', input: identity, output: identity };
export const input = { parse(value) {
  if (!Number.isInteger(value?.count) || !['complete', 'wait', 'hang', 'invalid-result'].includes(value?.mode)) throw new Error('Invalid fixture input');
  return { count: value.count, mode: value.mode };
} };
export const output = { parse(value) {
  if (value?.schemaVersion !== 1 || !Number.isInteger(value?.count) || typeof value?.city !== 'string'
    || value?.marker !== 'original' || value?.asset !== 'retained asset') throw new Error('Invalid fixture result');
  return value;
} };

export function construct(context) {
  return { agentPrompts: {}, workflow: {
    workflow: { kind: 'headless-fixture', version: 1 }, workflowContractVersion: '1', resultKind: 'headless-fixture.result', input, output,
    async execute(ctx, value) {
      const first = await ctx.steps.run({ schemaVersion: 1, id: 'calculate', definitionVersion: 'v1', input: identity, output: identity,
        async execute(stepContext) {
          await stepContext.effects.run(recordExecution, { count: value.count, pid: process.pid });
          return { count: value.count + 1 };
        },
      }, value);
      if (value.mode === 'hang') await new Promise(() => {});
      let city = '';
      if (value.mode === 'wait') {
        const answer = await ctx.steps.waitForInput({ id: 'ask', title: 'City', expiresAfter: '366d', form: {
          descriptor: { schemaVersion: 1, id: 'city', version: 'v1', fields: [{ id: 'city', label: 'City', type: 'text', required: true, maxLength: 30 }] },
          output: { parse(v) { if (v.fields.city === 'reject') throw new Error('Rejected by retained validator'); return { ...v, fields: { city: v.fields.city.toUpperCase() } }; } },
        } });
        city = answer.output.fields.city;
      }
      return { schemaVersion: 1, count: value.mode === 'invalid-result' ? 'wrong' : first.output.count,
        city, marker: context.runConfiguration.marker, asset: new TextDecoder().decode(context.readAsset('proof.txt')) };
    },
  } };
}
