import assert from 'node:assert/strict';
import { parseHarnessArgs, validateLocalURL, discoverConnection, buildHarnessPatch, auditControlEvents } from './deepseek-harness.mjs';
import { projectNativeResult } from './deepseek-native-provider.mjs';

assert.equal(parseHarnessArgs(['launch', '--port', '3081', '--no-open']).port, 3081);
assert.equal(parseHarnessArgs(['launch', '--no-open']).noOpen, true);
assert.equal(parseHarnessArgs(['launch', '--workspace', 'project with spaces']).workspace, 'project with spaces');
assert.equal(parseHarnessArgs(['repair-workspace', '--apply']).apply, true);
assert.throws(() => parseHarnessArgs(['launch', '--apply']));
for (const args of [['launch', '--port', 'abc'], ['connect', '--model'], ['connect', '--context', 'x'], ['connect', '--api', 'bad'], ['bad']]) assert.throws(() => parseHarnessArgs(args));
for (const url of ['https://example.com/v1', 'http://127.0.0.1.evil.test/v1', 'http://user:secret@localhost/v1', 'http://localhost/v1?token=secret']) assert.throws(() => validateLocalURL(url));
assert.equal(validateLocalURL('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1');
const strata = await discoverConnection({}, async () => ({ service: 'strata', model: 'installed-iq3', max_context: 131072 }));
assert.equal(strata.contextWindow, 131072);
const patch = buildHarnessPatch(strata);
assert.equal(patch[3].config.modelPolicies[0].maxTokens, 2048);
assert.equal(patch[3].config.modelPolicies[0].headroomTokens, 8192);
assert.equal(patch[3].config.modelPolicies[0].provider, 'ollamaforge-local');
assert.equal(patch[2].insert.length, 4);
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
console.log('PASS: DeepSeek Harness local endpoint validation, installed-model discovery, 128K capacity, non-vision declaration and isolated profile patch. No runtime download or inference in unit tests.');
