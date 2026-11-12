import assert from 'node:assert/strict';
import { createLocalTokenCounter, fitMetalContext, localContextNotice, trimStoredHistory } from './codex-local-context.mjs';

const message = (role, text) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const call = (id) => ({ type: 'function_call', call_id: id, name: 'exec_command', arguments: '{"cmd":"pwd"}' });
const result = (id, output) => ({ type: 'function_call_output', call_id: id, output });
const text = (item) => item.content?.map((part) => part.text ?? '').join('\n') ?? '';
const count = async (request) => Math.ceil(JSON.stringify({ input: request.input, tools: request.tools }).length / 3);
const basic = (input, tools = []) => ({ model: 'qwen3.5-codex-metal-8k', input, tools });

const latest = '继续修改，保留我刚刚要求的行为。'.repeat(60);
const history = [message('system', 'Respect user approval boundaries.')];
for (let index = 0; index < 24; index++) {
  history.push(message('user', `old task ${index} ${'history '.repeat(400)}`), call(`call_${index}`), result(`call_${index}`, 'completed'));
}
history.push(message('user', '<environment_context><cwd>/safe/repo</cwd></environment_context>'));
history.push(message('user', latest), call('recent'), result('recent', 'Recent successful output; use this instead of repeating the check.'));
const limited = await fitMetalContext(basic(history), count);
assert.ok(limited.omittedItems > 0);
assert.ok(limited.measuredTokens <= limited.inputBudget);
assert.equal(text(limited.normalized.input.find((item) => text(item) === latest)), latest);
assert.ok(limited.normalized.input.some((item) => text(item).includes('<cwd>/safe/repo</cwd>')));
assert.ok(limited.normalized.input.some((item) => text(item).startsWith(localContextNotice) && text(item).includes('Do not claim to remember omitted history')));
assert.ok(limited.normalized.input.slice(1).every((item) => item.role !== 'system'), 'Qwen requires the sole system message at the beginning.');
assert.ok(limited.normalized.input.some((item) => item.call_id === 'recent' && item.type === 'function_call'));
assert.ok(limited.normalized.input.some((item) => item.call_id === 'recent' && item.type === 'function_call_output'));
for (const item of limited.normalized.input.filter((item) => item.type === 'function_call_output')) {
  assert.ok(limited.normalized.input.some((candidate) => candidate.type === 'function_call' && candidate.call_id === item.call_id));
}

const contextAfterRequest = await fitMetalContext(basic([
  message('system', 'Necessary constraints.'), message('user', 'old '.repeat(20_000)),
  message('user', 'Actual latest task request'),
  message('user', '<environment_context><cwd>/safe/repo</cwd></environment_context>'),
]), count);
assert.ok(contextAfterRequest.normalized.input.some((item) => text(item) === 'Actual latest task request'));

const tool = { type: 'function', name: 'exec_command', description: 'Useful tool. '.repeat(3000), parameters: {
  type: 'object', properties: { cmd: { type: 'string', description: 'The exact command.' } }, required: ['cmd'], additionalProperties: false,
} };
const schema = structuredClone(tool.parameters);
const shortTools = await fitMetalContext(basic([message('system', 'Use tools safely.'), message('user', 'List this directory.')], [tool]), count);
assert.ok(shortTools.normalized.tools[0].description.length < 1000);
assert.deepEqual(shortTools.normalized.tools[0].parameters, schema);
assert.equal(tool.description.length, 'Useful tool. '.repeat(3000).length);

const largeResult = await fitMetalContext(basic([
  message('system', 'Do not bypass approvals.'), message('user', 'Summarize the command output.'), call('big'), result('big', 'HEAD\n' + 'x'.repeat(60_000) + '\nTAIL'),
]), count);
assert.ok(largeResult.normalized.input.some((item) => item.type === 'function_call' && item.call_id === 'big'));
const retainedResult = largeResult.normalized.input.find((item) => item.type === 'function_call_output');
assert.match(retainedResult.output, /^HEAD/);
assert.match(retainedResult.output, /TAIL$/);
assert.match(retainedResult.output, /middle of tool output omitted/);
assert.ok(largeResult.measuredTokens <= largeResult.inputBudget);

const oversizedMessage = '用户的新消息不可静默截断🙂'.repeat(6000);
const oversizedInput = basic([message('system', 'Important constraints.'), message('user', oversizedMessage)]);
await assert.rejects(fitMetalContext(oversizedInput, count), /user message was not truncated.*explicitly select a cloud model/i);
assert.equal(text(oversizedInput.input[1]), oversizedMessage);
await assert.rejects(fitMetalContext(basic([message('system', 'mandatory '.repeat(15_000)), message('user', 'Do it.')]), count), /required environment\/permission instructions/);

const orphan = await fitMetalContext(basic([message('user', 'What happened?'), result('missing', 'Important result from before restart')]), count);
assert.ok(orphan.normalized.input.some((item) => item.role === 'assistant' && /invocation unavailable: missing/.test(text(item))));
assert.ok(orphan.normalized.input.some((item) => text(item).startsWith(localContextNotice)));
assert.ok(!orphan.normalized.input.some((item) => item.type === 'function_call_output'));

const cloudHistory = await fitMetalContext(basic([
  { type: 'compaction', encrypted_content: 'opaque'.repeat(50_000) },
  { type: 'reasoning', encrypted_content: 'opaque', summary: [] },
  { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
  { type: 'custom_tool_call_output', call_id: 'patch', output: 'Applied successfully.' },
  message('user', 'Continue this task locally.'),
]), count);
assert.ok(cloudHistory.normalized.input.some((item) => /Earlier cloud history is encrypted/.test(text(item))));
assert.ok(cloudHistory.normalized.input.some((item) => /Applied successfully/.test(text(item))));
assert.ok(!JSON.stringify(cloudHistory.normalized).includes('opaque'));

const stored = trimStoredHistory([
  message('user', 'old '.repeat(1000)), call('old'), result('old', 'old result'),
  message('user', 'latest'), call('new'), result('new', 'new result'), message('assistant', 'complete'),
], 100, (input) => JSON.stringify(input).length / 3);
assert.ok(stored.some((item) => text(item).startsWith(localContextNotice)));
assert.ok(stored.every((item) => item.role !== 'system'), 'Persisted budget notices must remain usable with a fresh leading system message.');
assert.ok(stored.some((item) => text(item) === 'latest'));
const storedResults = stored.filter((item) => item.type === 'function_call_output');
assert.ok(storedResults.every((item) => stored.some((candidate) => candidate.type === 'function_call' && candidate.call_id === item.call_id)));

let lastUrl;
let countedRequest;
const exactCounter = createLocalTokenCounter('http://127.0.0.1:11436', async (url, options) => {
  lastUrl = String(url);
  countedRequest = JSON.parse(options.body);
  return new Response(JSON.stringify({ input_tokens: 123 }), { status: 200 });
});
assert.equal(await exactCounter(basic([message('user', 'Count me.')], [tool])), 123);
assert.equal(lastUrl, 'http://127.0.0.1:11436/v1/responses/input_tokens');
assert.deepEqual(countedRequest.tools[0].parameters, schema);
assert.equal(countedRequest.stream, false);

let unavailableCalls = 0;
const conservativeCounter = createLocalTokenCounter('http://127.0.0.1:11436', async () => {
  unavailableCalls++;
  return new Response('{}', { status: 404 });
});
assert.ok(await conservativeCounter(basic([message('user', '中文 test')])) > 256);
await conservativeCounter(basic([message('user', 'Another request.')]));
assert.equal(unavailableCalls, 1);

const invalidCounter = createLocalTokenCounter('http://127.0.0.1:11436', async () => new Response('Bad schema', { status: 400 }));
await assert.rejects(invalidCounter(basic([message('user', 'test')])), /tokenizer rejected.*No inference was started/);
const offlineCounter = createLocalTokenCounter('http://127.0.0.1:11436', async () => { throw new Error('offline'); });
await assert.rejects(offlineCounter(basic([message('user', 'test')])), /Start the local runtime or switch to a cloud model explicitly/);

console.log('PASS: local exact token budget, recent context, atomic tool pairs, full user messages, permission context, explicit omissions and no cloud fallback.');
