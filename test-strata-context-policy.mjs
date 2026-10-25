import assert from 'node:assert/strict';
import { optimizeContext, describeContext } from './strata-context.mjs';

const fn = (name, text = 'Tool documentation.') => ({ type: 'function', name, description: text, parameters: { type: 'object', properties: { value: { type: 'string', description: 'Keep this parameter documentation.' } } } });
const ns = (name, count = 2, description = 'Shared namespace documentation. '.repeat(70)) => ({ type: 'namespace', name, description, tools: Array.from({ length: count }, (_, i) => fn(`call_${i}`)) });
const tools = [ns('mcp__node_repl'), ns('mcp__cua_repl'), ns('mcp__codex_apps__github', 89), ns('mcp__codex_apps__chatgpt_space', 38), ns('mcp__codex_apps__sites', 25), ns('mcp__codex_apps__pets'), fn('exec_command')];
const long = 'HEAD '.repeat(4000) + 'TAIL '.repeat(4000);
const envelope = { content: [{ type: 'text', text: long }, { type: 'image', data: 'unchanged-image-data' }], continuation: 'keep-cursor', count: 42 };
const source = { instructions: 'Preserve all original instructions.', reasoning: { effort: 'high' }, tools, input: [
  { type: 'message', role: 'user', content: long },
  { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: JSON.stringify({ command: long }) },
  { type: 'function_call_output', call_id: 'c1', output: long },
  { type: 'custom_tool_call_output', call_id: 'c2', output: JSON.stringify(envelope) },
  { type: 'additional_tools', tools: [ns('mcp__codex_apps__github'), ns('mcp__codex_apps__sites')] },
] };
const original = structuredClone(source);
const out = optimizeContext(source);
assert.match(out.instructions, /DESKTOP-CONTROL\.md/);
assert.match(out.instructions, /app approval timeouts require user action/);
assert.match(out.instructions, /GitHub connector writes return 403/);
assert.deepEqual(source, original, 'Do not mutate request/history objects.');
assert.deepEqual(out.tools.map(t => t.name), ['mcp__node_repl', 'mcp__cua_repl', 'mcp__codex_apps__github', 'exec_command']);
for (const name of ['mcp__node_repl', 'mcp__cua_repl', 'mcp__codex_apps__github']) {
  assert.deepEqual(out.tools.find(t => t.name === name).tools, tools.find(t => t.name === name).tools, `${name}: preserve every function, parameter and description.`);
  assert.ok(out.instructions.includes(tools.find(t => t.name === name).description));
}
assert.deepEqual(out.input[0], source.input[0]);
assert.deepEqual(out.input[1], source.input[1]);
assert.match(out.input[2].output, /characters omitted/);
assert.ok(out.input[2].output.length <= 16000);
assert.match(out.input[2].output, /^HEAD/);
assert.match(out.input[2].output, /TAIL $/);
const bounded = JSON.parse(out.input[3].output);
assert.equal(bounded.count, 42);
assert.equal(bounded.continuation, 'keep-cursor');
assert.deepEqual(bounded.content[1], envelope.content[1]);
assert.ok(bounded.content[0].text.length <= 16000);
assert.deepEqual(out.input[4].tools.map(t => t.name), ['mcp__codex_apps__github']);
assert.equal(out.reasoning.effort, 'high');
assert.equal(out.reasoning_budget_tokens, 4096);
assert.equal(optimizeContext({ reasoning: { effort: 'high' }, reasoning_budget_tokens: 1000 }).reasoning_budget_tokens, 1000);
assert.equal(optimizeContext({ reasoning: { effort: 'high' }, reasoning_budget_tokens: 0 }).reasoning_budget_tokens, 0);
assert.equal(optimizeContext({ reasoning: { effort: 'high' }, thinking_budget_tokens: 500 }).reasoning_budget_tokens, undefined);
assert.equal(optimizeContext({ reasoning: { effort: 'none' } }).reasoning_budget_tokens, undefined);
assert.equal(optimizeContext({ client_metadata: { 'x-codex-turn-metadata': '{"request_kind":"compaction"}' }, max_output_tokens: 90000 }).max_output_tokens, 4096);
assert.equal(optimizeContext({ max_output_tokens: 90000 }).max_output_tokens, 90000);
assert.deepEqual(optimizeContext(out), out, 'The optimization must be idempotent.');
const before = describeContext(source), after = describeContext(out);
assert.ok(after.repeatedNamespaceCharacters < before.repeatedNamespaceCharacters / 10);
assert.ok(after.toolCharacters < before.toolCharacters);
assert.ok(!JSON.stringify(after).includes('unchanged-image-data'), 'Diagnostics must contain no tool content.');
console.log('PASS: all Chrome/computer/GitHub functions preserved; duplicate schemas, large tool output and unbounded thinking reduced; original instructions, arguments, images, cursors and cloud-independent policy preserved.');
