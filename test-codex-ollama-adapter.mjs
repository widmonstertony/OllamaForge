import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const incoming = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  incoming.push({ headers: req.headers, body });
  const testMode = req.headers['x-test-mode'];
  const bridgedTool = body.tools?.find((tool) => tool.name?.startsWith('t_'));
  if (testMode === 'json-call') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'test-response',
      output: [{ type: 'function_call', id: 'fc_json', call_id: 'call_json', name: bridgedTool.name, arguments: '{"code":"true"}' }],
    }));
    return;
  }
  if (testMode === 'stream-call') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const item = { type: 'function_call', id: 'fc_stream', call_id: 'call_stream', name: bridgedTool.name, arguments: '' };
    res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`);
    const doneItem = { ...item, arguments: '{"url":"https://example.test"}' };
    res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: doneItem })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'test-stream', output: [doneItem] } })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'test-response', output: [] }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamPort = upstream.address().port;

const portProbe = http.createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const adapterPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));

const child = spawn(process.execPath, [fileURLToPath(new URL('./codex-ollama-adapter.mjs', import.meta.url))], {
  env: {
    ...process.env,
    CODEX_OLLAMA_ADAPTER_PORT: String(adapterPort),
    OLLAMA_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childError = '';
child.stderr.on('data', (chunk) => { childError += chunk.toString(); });

try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${adapterPort}/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* Startup race. */ }
    if (child.exitCode !== null) throw new Error(`Adapter exited: ${childError}`);
    await delay(100);
  }
  assert.ok(ready, `Adapter did not start: ${childError}`);

  async function send(model, effort, legacyPreset) {
    const response = await fetch(`http://127.0.0.1:${adapterPort}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(legacyPreset ? { 'x-codex-local-preset': legacyPreset } : {}),
      },
      body: JSON.stringify({
        model,
        reasoning: { effort },
        instructions: 'Developer instruction',
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'More instruction' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply TEST' }] },
        ],
        tools: [{ type: 'web_search' }, { type: 'function', name: 'shell' }],
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
    return incoming.at(-1);
  }

  const fast = await send('qwen3.5-codex-fast-16k', 'none', 'qwen3.8-codex-16k');
  assert.equal(fast.body.model, 'qwen3.5-codex-fast-16k');
  assert.equal(fast.body.reasoning.effort, 'none');
  assert.equal(fast.body.input[0].role, 'system');
  assert.equal(fast.body.input[0].content[0].text.includes('Developer instruction'), true);
  assert.equal(fast.body.input[0].content[0].text.includes('More instruction'), true);
  assert.equal(fast.body.input[1].role, 'user');
  assert.equal(fast.body.tools.length, 1);
  assert.equal(fast.body.parallel_tool_calls, false);
  assert.equal(fast.headers['x-codex-local-preset'], undefined);

  const quality = await send('qwen3.8-codex-16k', 'max', 'qwen3.5-codex-fast-16k');
  assert.equal(quality.body.model, 'qwen3.8-codex-16k');
  assert.equal(quality.body.reasoning, undefined);
  assert.equal(quality.body.reasoning_effort, 'xhigh');
  const fastWithoutHeader = await send('qwen3.5-codex-fast-16k', 'none', null);
  assert.equal(fastWithoutHeader.body.model, 'qwen3.5-codex-fast-16k');

  const bridgeResponse = await fetch(`http://127.0.0.1:${adapterPort}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-mode': 'json-call' },
    body: JSON.stringify({
      model: 'qwen3.5-codex-fast-16k',
      input: [
        { type: 'function_call', call_id: 'old_call', name: 'js', namespace: 'cua_repl', arguments: '{"code":"1"}' },
        { type: 'function_call_output', call_id: 'old_call', output: [
          { type: 'input_text', text: 'screen' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ] },
      ],
      tools: [
        { type: 'function', name: 'shell' },
        { type: 'namespace', name: 'cua_repl', description: 'Computer control', tools: [
          { type: 'function', name: 'js', description: 'Run one CUA JavaScript action', parameters: { type: 'object' }, defer_loading: true },
          { type: 'function', name: 'js_reset', description: 'Reset CUA', parameters: { type: 'object' } },
        ] },
        { type: 'namespace', name: 'codex_apps', tools: [
          { type: 'function', name: 'read_item', parameters: { type: 'object' } },
        ] },
        { type: 'web_search' },
        { type: 'mcp', server_label: 'remote-secret', server_url: 'https://mcp.example.test', authorization: 'DO_NOT_FORWARD' },
      ],
      tool_choice: { type: 'function', name: 'js', namespace: 'cua_repl' },
    }),
  });
  assert.equal(bridgeResponse.status, 200);
  const bridgePayload = await bridgeResponse.json();
  assert.equal(bridgePayload.output[0].name, 'js');
  assert.equal(bridgePayload.output[0].namespace, 'cua_repl');
  const bridgeIncoming = incoming.at(-1).body;
  assert.equal(bridgeIncoming.tools.length, 4);
  const cuaTools = bridgeIncoming.tools.filter((tool) => tool.description?.includes('[cua_repl.'));
  assert.equal(cuaTools.length, 2);
  assert.equal(cuaTools.every((tool) => tool.type === 'function' && tool.name.startsWith('t_')), true);
  assert.equal(cuaTools.some((tool) => 'defer_loading' in tool), false);
  assert.equal(bridgeIncoming.input[1].name.startsWith('t_'), true);
  assert.equal('namespace' in bridgeIncoming.input[1], false);
  assert.equal(bridgeIncoming.input[2].output[1].type, 'input_image');
  assert.equal(bridgeIncoming.input[2].output[1].image_url, 'data:image/png;base64,AAAA');
  assert.equal(bridgeIncoming.tool_choice.name, bridgeIncoming.input[1].name);
  assert.equal('namespace' in bridgeIncoming.tool_choice, false);
  assert.equal(JSON.stringify(bridgeIncoming).includes('DO_NOT_FORWARD'), false);
  assert.equal(bridgeIncoming.parallel_tool_calls, false);

  const streamResponse = await fetch(`http://127.0.0.1:${adapterPort}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-mode': 'stream-call' },
    body: JSON.stringify({
      model: 'qwen3.5-codex-fast-16k',
      stream: true,
      input: 'Open the test page',
      tools: [{ type: 'namespace', name: 'browser', tools: [
        { type: 'function', name: 'open', description: 'Open a URL', parameters: { type: 'object' } },
      ] }],
    }),
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  const streamEvents = streamText.split(/\r?\n/)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(5)));
  assert.equal(streamEvents[0].item.name, 'open');
  assert.equal(streamEvents[0].item.namespace, 'browser');
  assert.equal(streamEvents[1].item.name, 'open');
  assert.equal(streamEvents[1].item.namespace, 'browser');
  assert.equal(streamEvents[2].response.output[0].name, 'open');
  assert.equal(streamEvents[2].response.output[0].namespace, 'browser');
  const streamWireName = incoming.at(-1).body.tools[0].name;
  assert.equal(streamText.includes(streamWireName), false, streamText);

  console.log('PASS: model routing, reasoning, namespace/App/CUA bridge, history, images, credentials, and streaming output translation.');
} finally {
  child.kill();
  await new Promise((resolve) => upstream.close(resolve));
}
