import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileAgentAuthProviderStore, FilePlaintextAgentCredentialStore, createStoreBackedAgentAuthProviderRegistry, resolveAgentProviderConfigDocument, withStoredAgentAuthProviders } from "../../core/src/index.ts";
import { CodexCliAgentRunner } from "../../core/src/infrastructure/agents/codexCliAgentRunner.ts";
import { PiCliAgentRunner } from "../../core/src/infrastructure/agents/piCliAgentRunner.ts";
import defaults from "../../core/config/agent-providers.default.json";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "native-setup-")); roots.push(root); return root; }

it("loads new native definitions without restart, requires the selected OAuth session and preserves credentials separately", async () => {
  const root = await temporary();
  const config = resolveAgentProviderConfigDocument(defaults, {});
  config.executionProviders['pi-cli'].agentDirectory = root;
  const definitions = new FileAgentAuthProviderStore(path.join(root, 'definitions'));
  const credentials = new FilePlaintextAgentCredentialStore(path.join(root, 'credentials'));
  const registry = createStoreBackedAgentAuthProviderRegistry(config, definitions, credentials, {});
  const definition = { schemaVersion: 2 as const, authProviderId: 'my-pi-claude', displayName: 'My Pi Claude', kind: 'runtime-native' as const, executionProviderId: 'pi-cli' as const, modelProvider: 'anthropic' };
  await definitions.create(definition);
  const target = { cwd: root, executionProviderId: 'pi-cli', modelProvider: 'anthropic' };
  for (const session of [{}, {anthropic:{type:'api_key',key:'synthetic-key'}}, {'openai-codex':{type:'oauth',access:'synthetic-access',refresh:'synthetic-refresh',expires:0}}]) {
    await writeFile(path.join(root,'auth.json'),JSON.stringify(session));
    expect(await registry.get(definition.authProviderId).preflight(target)).toMatchObject({available:false,reason:'session-missing'});
  }
  await writeFile(path.join(root,'auth.json'),JSON.stringify({anthropic:{type:'oauth',access:'synthetic-access',refresh:'synthetic-refresh',expires:0}}));
  expect(await registry.get(definition.authProviderId).preflight(target)).toMatchObject({available:true,kind:'runtime-native'});
  expect((await credentials.list()).items).toEqual([]);
  expect(withStoredAgentAuthProviders(config,[definition]).authProviders[definition.authProviderId]).toEqual({kind:'runtime-native',runtime:'pi-cli',modelProvider:'anthropic'});
  await definitions.setLifecycleStatus(definition.authProviderId,'archived');
  expect(await registry.get(definition.authProviderId).preflight(target)).toMatchObject({available:false});
});

it.each([['codex-cli',CodexCliAgentRunner],['pi-cli',PiCliAgentRunner]] as const)("%s rejects a wrong CLI version before touching authentication", async (providerId, Runner) => {
  const root = await temporary();
  const command = path.join(root,'fake-cli');
  await writeFile(command,'#!/bin/sh\nprintf "fake-cli 0.0.1\\n"\n',{mode:0o700});
  const preflight = vi.fn();
  const runner = new Runner({ command, requiredVersion:'0.0.2', heartbeatIntervalMs:1000,environmentAllowlist:[] }, {get: () => ({authProviderId:'test',kind:'runtime-native',preflight,prepare:vi.fn()})}, {});
  expect(await runner.preflight({cwd:root,authProviderId:'test',parameters:{provider:'anthropic',model:'test'}})).toMatchObject({providerId,available:false,message:expect.stringContaining('does not match required version')});
  expect(preflight).not.toHaveBeenCalled();
});
