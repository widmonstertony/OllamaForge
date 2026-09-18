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
  incoming.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
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
  assert.equal(fast.headers['x-codex-local-preset'], undefined);

  const quality = await send('qwen3.8-codex-16k', 'max', 'qwen3.5-codex-fast-16k');
  assert.equal(quality.body.model, 'qwen3.8-codex-16k');
  assert.equal(quality.body.reasoning, undefined);
  assert.equal(quality.body.reasoning_effort, 'xhigh');
  const fastWithoutHeader = await send('qwen3.5-codex-fast-16k', 'none', null);
  assert.equal(fastWithoutHeader.body.model, 'qwen3.5-codex-fast-16k');
  console.log('PASS: requested 9B/27B models remain selected even with conflicting legacy headers; reasoning, system, and tools normalized.');
} finally {
  child.kill();
  await new Promise((resolve) => upstream.close(resolve));
}
