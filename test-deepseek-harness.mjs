import assert from 'node:assert/strict';
import { parseHarnessArgs, resolveHarnessOptions, validateLocalURL, discoverConnection, buildHarnessPatch, auditControlEvents, withDefaultHarnessLocale } from './deepseek-harness.mjs';
import { projectNativeResult } from './deepseek-native-provider.mjs';
import { createRestartHandler } from './deepseek-restart-guard.mjs';

let closedInitiators = 0;
let busy = true;
const restartHandler = createRestartHandler({
  list: () => [{ status: busy ? 'running' : 'idle' }],
  closeInitiators: () => { closedInitiators++; },
}, 'test-key');
function restartRequest(headers) {
  const response = { status: 0, body: '',
    writeHead(status) { this.status = status; return this; },
    end(body = '') { this.body = body; },
  };
  restartHandler({ method: 'POST', headers }, response);
  return response;
}
assert.equal(restartRequest({}).status, 401);
assert.equal(restartRequest({ authorization: 'Bearer test-key', 'x-ollamaforge-parent-pid': '-1' }).status, 412);
assert.equal(restartRequest({ authorization: 'Bearer test-key' }).status, 409);
assert.equal(closedInitiators, 0, 'Busy and unauthorized checks must not change admission.');
busy = false;
assert.equal(restartRequest({ authorization: 'Bearer test-key' }).status, 200);
assert.equal(closedInitiators, 1, 'Reserve the idle runtime before signaling it.');

assert.equal(withDefaultHarnessLocale()[0].config.preference, 'zh', 'Fresh deployments default to Chinese.');
const englishPreference = [{ id: 'locale', config: { preference: 'en' } }, { id: 'other', config: { untouched: true } }];
assert.equal(withDefaultHarnessLocale(englishPreference), englishPreference, 'An explicit later language choice is preserved without rewriting its file.');
const unrelatedPreference = [{ id: 'other', config: { untouched: true } }, { id: 'locale', config: { custom: true } }];
const seededPreference = withDefaultHarnessLocale(unrelatedPreference);
assert.deepEqual(seededPreference[0], unrelatedPreference[0]);
assert.deepEqual(seededPreference[1].config, { custom: true, preference: 'zh' });
assert.equal(withDefaultHarnessLocale(seededPreference), seededPreference, 'Redeployment keeps the saved locale.');
assert.throws(() => withDefaultHarnessLocale({ locale: 'en' }), /patch list/);

assert.equal(parseHarnessArgs(['launch', '--port', '3081', '--no-open']).port, 3081);
assert.equal(parseHarnessArgs(['launch', '--no-open']).noOpen, true);
assert.throws(() => parseHarnessArgs(['launch', '--tool-profile', 'unknown']), /tool profile/);
const savedConnection = {
  baseURL: 'http://127.0.0.1:11434/v1', model: 'local-128k', contextWindow: 131072,
  api: 'openai-responses', port: 3081, workspace: '/example/project', toolProfile: 'local-controls',
  additionalModels: [{ model: 'local-64k', contextWindow: 65536 }],
};
const remembered = resolveHarnessOptions(parseHarnessArgs(['launch']), savedConnection);
assert.equal(remembered.model, 'local-128k');
assert.equal(remembered.context, 131072);
assert.equal(remembered.port, 3081);
assert.equal(remembered['extra-model'], 'local-64k');
assert.equal(remembered['tool-profile'], 'local-controls');
assert.equal(resolveHarnessOptions(parseHarnessArgs(['launch', '--port', '3080']), savedConnection, true).port, 3080);
assert.equal(resolveHarnessOptions(parseHarnessArgs(['connect', '--model', 'another', '--context', '8192']), savedConnection)['extra-model'], undefined);
assert.equal(parseHarnessArgs(['launch', '--workspace', 'project with spaces']).workspace, 'project with spaces');
assert.equal(parseHarnessArgs(['repair-workspace', '--apply']).apply, true);
assert.throws(() => parseHarnessArgs(['launch', '--apply']));
for (const args of [['launch', '--port', 'abc'], ['connect', '--model'], ['connect', '--context', 'x'], ['connect', '--api', 'bad'], ['bad']]) assert.throws(() => parseHarnessArgs(args));
for (const url of ['https://example.com/v1', 'http://127.0.0.1.evil.test/v1', 'http://user:secret@localhost/v1', 'http://localhost/v1?token=secret']) assert.throws(() => validateLocalURL(url));
assert.equal(validateLocalURL('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1');
const strata = await discoverConnection({}, async () => ({ service: 'strata', model: 'installed-iq3', max_context: 131072 }));
assert.equal(strata.contextWindow, 131072);
const reconnect = { 'base-url': 'http://127.0.0.1:8080/v1', model: 'installed-iq3', context: 131072 };
const readSavedStrata = async url => url.endsWith('/models') ? { data: [{ id: 'installed-iq3' }] }
  : { service: 'strata', model: 'installed-iq3', max_context: 131072, images: true };
assert.equal((await discoverConnection(reconnect, readSavedStrata)).images, true, 'Saved launch retains verified screenshot support.');
await assert.rejects(() => discoverConnection({ ...reconnect, context: 262144 }, readSavedStrata), /no longer matches/);
const patch = buildHarnessPatch(strata);
assert.equal(patch[3].config.modelPolicies[0].maxTokens, 2048);
assert.equal(patch[3].config.modelPolicies[0].headroomTokens, 8192);
assert.equal(patch[3].config.modelPolicies[0].provider, 'ollamaforge-local');
assert.equal(patch[2].insert.length, 4);
const controls = buildHarnessPatch({ ...strata, toolProfile: 'local-controls' });
assert.ok(controls[2].insert.some(plugin => plugin.name?.endsWith('/deepseek-local-tools.mjs')));
assert.equal(patch[2].insert[3].config.mode, 'launch');
assert.equal(patch[2].insert[3].config.headless, false);
const vision = await discoverConnection({}, async () => ({ service: 'strata', model: 'vision-iq3', max_context: 131072, images: true }));
assert.deepEqual(buildHarnessPatch(vision)[0].config.providers['ollamaforge-local'].models[0].input, ['text', 'image']);
assert.equal(patch[0].config.providers['ollamaforge-local'].models[0].input[0], 'text');
assert.deepEqual(patch[0].config.providers['ollamaforge-local'].models[0].reasoningEfforts, { off: 'none', high: 'high' });
assert.deepEqual(patch[1].config, { provider: 'ollamaforge-local', model: 'installed-iq3', reasoningEffort: 'off' });
const rawState = { content: [{ type: 'text', text: 'window tree' }, { type: 'image', data: 'keep-image' }], structuredContent: {
  snapshot_id: 's00000012', pid: 12, window_id: 42, elements_complete: true,
  elements: [{ element_index: 3, element_token: 's00000012:3', label: 'Editor', frame: { x: 1, y: 2 }, actions: ['text'] }],
} };
const projected = projectNativeResult(rawState);
assert.deepEqual(projected.structuredContent, rawState.structuredContent);
assert.deepEqual(projected.content.slice(0, 2), rawState.content);
assert.match(projected.content[2].text, /s00000012:3/);
assert.equal(rawState.content.length, 2);
assert.deepEqual(projectNativeResult({ content: [] }), { content: [] });
const windowResult = projectNativeResult({
  content: [{ type: 'text', text: 'Found 1 window(s).' }],
  structuredContent: { windows: [
    { app_name: 'Chrome', title: 'Local fixture', pid: 43, window_id: 7, is_on_screen: true, layer: 0 },
  ] },
});
assert.deepEqual(JSON.parse(windowResult.content[1].text.split('\n')[1]), {
  total: 1,
  windows: [{ app_name: 'Chrome', title: 'Local fixture', pid: 43, window_id: 7, is_on_screen: true }],
});
const uiEvents = [{ type: 'tool_call', tool: 'cua_driver_native__click', input: {} },
  { type: 'tool_call', tool: 'cua_driver_native__type_text', input: { text: 'NATIVE_fixture' } },
  { type: 'tool_call', tool: 'mcp__chrome-devtools-mcp__click', input: {} },
  { type: 'final', text: 'NATIVE_AND_CHROME_PASS' }];
const uiReceipts = { native: { passed: true }, chrome: { passed: true } };
assert.equal(auditControlEvents(uiEvents, 'fixture', uiReceipts).allPassed, true);
assert.equal(auditControlEvents(uiEvents, 'fixture', {}).allPassed, false);
assert.equal(auditControlEvents(uiEvents.slice(2), 'fixture', uiReceipts).allPassed, false);
assert.equal(auditControlEvents([...uiEvents, { type: 'tool_call', tool: 'mcp__chrome-devtools-mcp__fill', input: { value: 'NATIVE_fixture' } }], 'fixture', uiReceipts).allPassed, false);
assert.equal(auditControlEvents([...uiEvents, { type: 'tool_call', tool: 'pwsh', input: {} }], 'fixture', uiReceipts).allPassed, false);
const readOllama = async url => {
  if (url.includes('/health')) throw new Error('No Strata here');
  return { models: [{ name: 'cloud:cloud' }, { name: 'tiny:latest' }, { name: 'qwen:27b' }] };
};
const ollama = await discoverConnection({}, readOllama);
assert.equal(ollama.model, 'qwen:27b');
assert.equal(ollama.api, 'openai-completions');
assert.equal((await discoverConnection({ model: 'tiny:latest', context: '8192' }, readOllama)).contextWindow, 8192);
await assert.rejects(() => discoverConnection({ model: 'missing' }, readOllama), /No matching/);
await assert.rejects(() => discoverConnection({}, async () => ({ models: [] })), /No matching/);
await assert.rejects(() => discoverConnection({ 'base-url': 'http://localhost:9999/v1' }), /require/);
await assert.rejects(() => discoverConnection({ 'base-url': 'http://localhost:9999/v1', model: 'missing', context: 8192 }, async () => ({ data: [] })), /not listed/);
const custom = await discoverConnection({ 'base-url': 'http://localhost:9999/v1', model: 'custom', context: 8192 }, async () => ({ data: [{ id: 'custom' }] }));
assert.equal(custom.model, 'custom');
assert.throws(() => parseHarnessArgs(['launch', '--extra-model', 'long']), /extra model/);
assert.throws(() => parseHarnessArgs(['launch', '--base-url', 'http://localhost:9999/v1', '--extra-model', 'long', '--extra-context', '0']), /Context/);
const selectable = await discoverConnection({
  'base-url': 'http://localhost:9999/v1', model: 'short', context: 65536,
  'extra-model': 'long', 'extra-context': 131072,
}, async () => ({ data: [{ id: 'short' }, { id: 'long' }] }));
const selectablePatch = buildHarnessPatch(selectable);
assert.deepEqual(selectablePatch[0].config.providers['ollamaforge-local'].models.map(model => [model.id, model.contextWindow]),
  [['short', 65536], ['long', 131072]]);
assert.equal(selectablePatch[1].config.model, 'short');
assert.deepEqual(selectablePatch[3].config.modelPolicies.map(policy => policy.model), ['short', 'long']);
await assert.rejects(() => discoverConnection({
  'base-url': 'http://localhost:9999/v1', model: 'short', context: 65536,
  'extra-model': 'missing', 'extra-context': 131072,
}, async () => ({ data: [{ id: 'short' }] })), /Extra model/);
console.log('PASS: DeepSeek Harness local endpoint validation, installed-model discovery, 128K capacity, non-vision declaration and isolated profile patch. No runtime download or inference in unit tests.');
