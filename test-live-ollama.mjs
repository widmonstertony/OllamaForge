import assert from 'node:assert/strict';

const effortByModel = new Map([
  ['qwen3.5-codex-fast-16k', 'none'],
  ['qwen3.8-codex-16k', 'low'],
]);
const requestedModels = process.argv.slice(2);
const models = requestedModels.length > 0 ? requestedModels : ['qwen3.5-codex-fast-16k'];

for (const model of models) {
  const effort = effortByModel.get(model);
  if (!effort) throw new Error(`Unknown local model: ${model}`);
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:11435/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning: { effort },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply PING.' }] }],
      stream: false,
      max_output_tokens: 48,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `${model}: ${JSON.stringify(payload)}`);
  assert.equal(payload.model?.replace(/:latest$/, ''), model);
  assert.ok(payload.output?.some((item) => item.type === 'message'), `${model}: no message output`);

  const toolResponse = await fetch('http://127.0.0.1:11435/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning: { effort },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Call the ping tool exactly once with value "ok".' }] }],
      tools: [{
        type: 'namespace',
        name: 'self_test',
        tools: [{
          type: 'function',
          name: 'ping',
          description: 'Return a test value.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        }],
      }],
      tool_choice: { type: 'function', namespace: 'self_test', name: 'ping' },
      stream: false,
      max_output_tokens: 128,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const toolPayload = await toolResponse.json();
  assert.equal(toolResponse.status, 200, `${model} tool call: ${JSON.stringify(toolPayload)}`);
  const toolCall = toolPayload.output?.find((item) => item.type === 'function_call');
  assert.ok(toolCall, `${model}: no function_call output: ${JSON.stringify(toolPayload)}`);
  assert.equal(toolCall.name, 'ping');
  assert.equal(toolCall.namespace, 'self_test');
  assert.equal(JSON.parse(toolCall.arguments).value, 'ok');
  console.log(`${model}: text and namespaced tool call passed in ${(Date.now() - started) / 1000}s.`);
}
