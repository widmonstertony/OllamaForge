import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { createHybridGateway, startHybridGateway, LOCAL_MODEL_ALIAS } from './codex-hybrid-gateway.mjs';

async function fakeServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

async function fixture(t, cloudHandler, localHandler = (req, res) => res.end('local'), options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hybrid-gateway-'));
  const localCatalogPath = path.join(directory, 'local.json');
  const cloudCachePath = path.join(directory, 'cache.json');
  fs.writeFileSync(localCatalogPath, JSON.stringify({ models: [{ slug: LOCAL_MODEL_ALIAS,
    display_name: 'Local Radeon Metal Qwen', context_window: 8192, custom: { preserved: true } }] }));
  const cloud = await fakeServer(cloudHandler);
  const local = await fakeServer(localHandler);
  const gateway = await startHybridGateway({ port: 0, allowTestUpstreams: true,
    cloudBaseUrl: `${cloud.url}/backend-api/codex`, localBaseUrl: `${local.url}/v1`,
    localCatalogPath, cloudCachePath, ...options });
  t.after(async () => {
    await gateway.close();
    await cloud.close();
    await local.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { gateway, url: `http://127.0.0.1:${gateway.server.address().port}`, localCatalogPath, cloudCachePath, cloud, local };
}

function collect(req, callback) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => callback(Buffer.concat(chunks)));
}

test('production upstream validation prevents redirecting credentials to arbitrary origins', () => {
  for (const cloudBaseUrl of ['https://example.com', 'http://127.0.0.1:1',
    'https://chatgpt.com/backend-api/codex?token=secret', 'https://user:pass@chatgpt.com/backend-api/codex']) {
    assert.throws(() => createHybridGateway({ cloudBaseUrl }));
  }
  assert.throws(() => createHybridGateway({ cloudBaseUrl: 'https://example.com', allowTestUpstreams: true }));
  assert.throws(() => createHybridGateway({ localBaseUrl: 'http://example.com/v1' }));
});

test('live catalogs retain cloud schema, include local metadata, and update models and ETags', async (t) => {
  let version = 1;
  let calls = 0;
  const fixtureData = await fixture(t, (req, res) => {
    calls++;
    assert.equal(req.url, '/backend-api/codex/models?client_version=0.162.0');
    assert.equal(req.headers['if-none-match'], undefined);
    assert.equal(req.headers.authorization, 'Bearer test-only');
    res.setHeader('etag', '"cloud-unchanged"');
    res.end(JSON.stringify({ models: [{ slug: `gpt-test-${version}`, opaque: { schema: 'intact' } }],
      opaqueCatalogField: ['preserved'] }));
  });
  const headers = { authorization: 'Bearer test-only' };
  const first = await fetch(`${fixtureData.url}/models?client_version=0.162.0`, { headers });
  const catalog = await first.json();
  assert.deepEqual(catalog.opaqueCatalogField, ['preserved']);
  assert.deepEqual(catalog.models[0].opaque, { schema: 'intact' });
  assert.equal(catalog.models[1].slug, LOCAL_MODEL_ALIAS);
  assert.deepEqual(catalog.models[1].custom, { preserved: true });
  const etag = first.headers.get('etag');
  const unchanged = await fetch(`${fixtureData.url}/models?client_version=0.162.0`, {
    headers: { ...headers, 'if-none-match': etag },
  });
  assert.equal(unchanged.status, 304);
  version++;
  const updated = await fetch(`${fixtureData.url}/models?client_version=0.162.0`, {
    headers: { ...headers, 'if-none-match': etag },
  });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.headers.get('etag'), etag);
  assert.equal((await updated.json()).models[0].slug, 'gpt-test-2');
  assert.equal(calls, 3);
  assert.equal(fixtureData.gateway.getHealth().catalog.stale, false);
});

test('explicit alias additions are live; unrelated catalog names cannot hijack cloud models', async (t) => {
  let localCalls = 0;
  let cloudCalls = 0;
  const secondAlias = 'local-test-next';
  const f = await fixture(t, (req, res) => {
    if (req.url.includes('/models')) res.end(JSON.stringify({ models: [{ slug: 'gpt-future' }] }));
    else { cloudCalls++; res.end('cloud'); }
  }, (req, res) => { localCalls++; res.end('local'); }, { localModelAliases: [LOCAL_MODEL_ALIAS, secondAlias] });
  fs.writeFileSync(f.localCatalogPath, JSON.stringify({ models: [
    { slug: LOCAL_MODEL_ALIAS }, { slug: secondAlias, newCapability: true }, { slug: 'gpt-future', malicious: true },
  ] }));
  const catalog = await (await fetch(`${f.url}/models`)).json();
  assert.deepEqual(catalog.models.map((model) => model.slug), ['gpt-future', LOCAL_MODEL_ALIAS, secondAlias]);
  assert.equal(catalog.models[0].malicious, undefined);
  assert.equal(catalog.models[2].newCapability, true);
  assert.equal(await (await fetch(`${f.url}/responses`, { method: 'POST', body: JSON.stringify({ model: secondAlias }) })).text(), 'local');
  assert.equal(await (await fetch(`${f.url}/responses`, { method: 'POST', body: JSON.stringify({ model: 'gpt-future' }) })).text(), 'cloud');
  assert.equal(localCalls, 1);
  assert.equal(cloudCalls, 1);
});

test('cloud response requests preserve compressed bytes, OAuth headers, SSE and error statuses', async (t) => {
  const payload = Buffer.from(JSON.stringify({ model: 'gpt-a-new-model', input: 'test-only prompt' }));
  const body = zlib.zstdCompressSync(payload);
  const f = await fixture(t, (req, res) => collect(req, (received) => {
    assert.deepEqual(received, body);
    assert.equal(req.headers['content-encoding'], 'zstd');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    assert.equal(req.headers['chatgpt-account-id'], 'test-account');
    assert.equal(req.headers['x-openai-actor-authorization'], 'Bearer actor-test');
    if (req.url.endsWith('/compact')) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end('{"error":"expired"}');
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"response.created"}\n\n');
      setTimeout(() => res.end('data: {"type":"response.completed"}\n\n'), 10);
    }
  }));
  const init = { method: 'POST', body, headers: { 'content-encoding': 'zstd', 'content-type': 'application/json',
    authorization: 'Bearer test-token', 'chatgpt-account-id': 'test-account',
    'x-openai-actor-authorization': 'Bearer actor-test' } };
  const response = await fetch(`${f.url}/responses`, init);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await response.text(), 'data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n');
  const compact = await fetch(`${f.url}/responses/compact`, init);
  assert.equal(compact.status, 401);
  assert.equal(compact.headers.get('www-authenticate'), 'Bearer');
  assert.equal(await compact.text(), '{"error":"expired"}');
  const health = JSON.stringify(f.gateway.getHealth());
  for (const secret of ['test-token', 'test-account', 'actor-test', 'test-only prompt']) assert.equal(health.includes(secret), false);
});

test('local inference receives only allowlisted headers and no cloud credentials', async (t) => {
  let headers;
  const f = await fixture(t, (req, res) => res.end('unexpected cloud'), (req, res) => {
    headers = req.headers;
    assert.equal(req.url, '/v1/responses');
    collect(req, (body) => { assert.equal(JSON.parse(body).model, LOCAL_MODEL_ALIAS); res.end('local ready'); });
  });
  const response = await fetch(`${f.url}/responses`, { method: 'POST', body: JSON.stringify({ model: LOCAL_MODEL_ALIAS }),
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', cookie: 'session=secret',
      'chatgpt-account-id': 'secret', 'x-openai-account-routing-override': 'secret',
      'x-openai-actor-authorization': 'secret', 'x-api-key': 'secret', 'x-arbitrary-token': 'secret',
      'proxy-authorization': 'secret' } });
  assert.equal(await response.text(), 'local ready');
  for (const key of ['authorization', 'cookie', 'chatgpt-account-id', 'x-openai-account-routing-override',
    'x-openai-actor-authorization', 'x-api-key', 'x-arbitrary-token', 'proxy-authorization']) assert.equal(headers[key], undefined);
  assert.equal(headers['content-type'], 'application/json');
});

test('cloud catalog failures use successful memory or disk data and report stale state', async (t) => {
  let fail = false;
  const f = await fixture(t, (req, res) => {
    if (fail) { res.writeHead(503); res.end('offline'); }
    else res.end(JSON.stringify({ models: [{ slug: 'gpt-last-success' }], extra: 'saved' }));
  });
  await (await fetch(`${f.url}/models`)).json();
  fail = true;
  const fallback = await fetch(`${f.url}/models`);
  assert.equal(fallback.headers.get('x-codex-hybrid-catalog-stale'), 'true');
  assert.equal((await fallback.json()).extra, 'saved');
  assert.equal(f.gateway.getHealth().catalog.source, 'memory');
  const disk = await fixture(t, (req, res) => { res.writeHead(502); res.end('offline'); });
  fs.writeFileSync(disk.cloudCachePath, JSON.stringify({ models: [{ slug: 'gpt-cache' }, { slug: LOCAL_MODEL_ALIAS }], fetched_at: '2026-10-11T00:00:00Z' }));
  const fromDisk = await (await fetch(`${disk.url}/models`)).json();
  assert.deepEqual(fromDisk.models.map((model) => model.slug), ['gpt-cache', LOCAL_MODEL_ALIAS]);
  assert.equal(disk.gateway.getHealth().catalog.source, 'disk-cache');
});

test('catalog authentication errors reach Codex for native OAuth recovery', async (t) => {
  const f = await fixture(t, (req, res) => { res.writeHead(401, { 'www-authenticate': 'Bearer' }); res.end('expired'); });
  fs.writeFileSync(f.cloudCachePath, JSON.stringify({ models: [{ slug: 'gpt-cache' }] }));
  const response = await fetch(`${f.url}/models`);
  assert.equal(response.status, 401);
  assert.equal(await response.text(), 'expired');
});

test('websocket upgrade returns 426 and never opens an upstream socket', async (t) => {
  let calls = 0;
  const f = await fixture(t, (req, res) => { calls++; res.end(); });
  const response = await new Promise((resolve, reject) => {
    const client = net.connect(f.gateway.server.address().port, '127.0.0.1');
    let data = '';
    client.on('connect', () => client.write('GET /responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
    client.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 426 Upgrade Required/);
  assert.equal(calls, 0);
});

test('oversized bodies and malformed paths do not reach either upstream', async (t) => {
  let calls = 0;
  const f = await fixture(t, (req, res) => { calls++; res.end(); }, (req, res) => { calls++; res.end(); }, { maxRequestBytes: 64 });
  const response = await fetch(`${f.url}/responses`, { method: 'POST', body: 'x'.repeat(100) });
  assert.equal(response.status, 413);
  const pathStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${f.url}`, { path: '/%2e%2e/credentials' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(pathStatus, 400);
  assert.equal(calls, 0);
});

test('upstream inactivity is bounded and unknown cloud endpoints retain their path', async (t) => {
  const paths = [];
  const f = await fixture(t, (req, res) => {
    paths.push(req.url);
    if (req.url.endsWith('/new-cloud-feature?version=2')) {
      res.writeHead(429, { 'retry-after': '7' });
      res.end('rate limited');
    }
  }, undefined, { requestTimeoutMs: 50 });
  const unknown = await fetch(`${f.url}/new-cloud-feature?version=2`, { method: 'POST', body: 'opaque wire body' });
  assert.equal(unknown.status, 429);
  assert.equal(unknown.headers.get('retry-after'), '7');
  assert.equal(await unknown.text(), 'rate limited');
  const timedOut = await fetch(`${f.url}/responses`, { method: 'POST', body: JSON.stringify({ model: 'gpt-test' }) });
  assert.equal(timedOut.status, 502);
  assert.equal((await timedOut.json()).error.type, 'cloud_upstream_error');
  assert.deepEqual(paths, ['/backend-api/codex/new-cloud-feature?version=2', '/backend-api/codex/responses']);
});

test('a client cancellation aborts upstream work and releases active request state', async (t) => {
  let upstreamDisconnected;
  const disconnected = new Promise((resolve) => { upstreamDisconnected = resolve; });
  let upstreamStarted;
  const started = new Promise((resolve) => { upstreamStarted = resolve; });
  const f = await fixture(t, (req, res) => {
    res.on('close', upstreamDisconnected);
    upstreamStarted();
  });
  const request = http.request(`${f.url}/responses`, { method: 'POST' });
  request.on('error', () => {});
  request.end(JSON.stringify({ model: 'gpt-test' }));
  await started;
  request.destroy();
  await Promise.race([disconnected, new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Upstream was not cancelled.')), 2000);
    timeout.unref();
  })]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.gateway.getHealth().requests.active, 0);
  assert.equal(f.gateway.getHealth().requests.aborted, 1);
});

test('on-demand GPU lifecycle is confined to local requests, including compact and token endpoints', async t => {
  let starts = 0;
  let ends = 0;
  let readyCalls = 0;
  let active = 0;
  const runtime = {
    onRequestStart() { starts++; active++; },
    onRequestEnd() { ends++; active--; },
    async ensureReady() { readyCalls++; },
    getStatus() { return { active }; },
    close() {},
  };
  const localPaths = [];
  const f = await fixture(t, (req, res) => res.end('cloud unaffected'), (req, res) => {
    localPaths.push(req.url);
    assert.equal(req.headers.authorization, undefined);
    res.end('local ready');
  }, { localRuntimeController: runtime });
  const cloud = await fetch(`${f.url}/responses`, { method: 'POST', body: JSON.stringify({ model: 'gpt-future' }) });
  assert.equal(await cloud.text(), 'cloud unaffected');
  assert.equal(starts, 0);
  assert.equal(readyCalls, 0);
  for (const endpoint of ['/responses', '/responses/compact', '/responses/input_tokens']) {
    const response = await fetch(`${f.url}${endpoint}`, { method: 'POST',
      headers: { authorization: 'Bearer test-only' }, body: JSON.stringify({ model: LOCAL_MODEL_ALIAS }) });
    assert.equal(await response.text(), 'local ready');
  }
  assert.deepEqual(localPaths, ['/v1/responses', '/v1/responses/compact', '/v1/responses/input_tokens']);
  assert.equal(starts, 3);
  assert.equal(ends, 3);
  assert.equal(readyCalls, 3);
  assert.equal(active, 0);
});

test('GPU startup failure returns a local error while the cloud still works', async t => {
  let active = 0;
  let localCalls = 0;
  const f = await fixture(t, (req, res) => res.end('cloud ready'), (req, res) => { localCalls++; res.end('unexpected'); }, {
    localRuntimeController: {
      onRequestStart() { active++; }, onRequestEnd() { active--; },
      ensureReady: async () => { throw new Error('simulated backend failure'); },
      getStatus: () => ({ active }), close() {},
    },
  });
  const local = await fetch(`${f.url}/responses`, { method: 'POST', body: JSON.stringify({ model: LOCAL_MODEL_ALIAS }) });
  assert.equal(local.status, 503);
  assert.equal((await local.json()).error.type, 'local_runtime_unavailable');
  assert.equal(active, 0);
  assert.equal(localCalls, 0);
  const cloud = await fetch(`${f.url}/responses`, { method: 'POST', body: JSON.stringify({ model: 'gpt-test' }) });
  assert.equal(await cloud.text(), 'cloud ready');
});

test('a cancelled GPU wake wait never forwards the abandoned request', async t => {
  let active = 0;
  let releaseReady;
  let readyStarted;
  const started = new Promise(resolve => { readyStarted = resolve; });
  let localCalls = 0;
  let wakeSignal;
  const f = await fixture(t, (req, res) => res.end('cloud ready'), (req, res) => { localCalls++; res.end(); }, {
    localRuntimeController: {
      onRequestStart() { active++; }, onRequestEnd() { active--; },
      ensureReady({ signal }) { wakeSignal = signal; readyStarted(); return new Promise(resolve => { releaseReady = resolve; }); },
      getStatus: () => ({ active }), close() {},
    },
  });
  const request = http.request(`${f.url}/responses`, { method: 'POST' });
  request.on('error', () => {});
  request.end(JSON.stringify({ model: LOCAL_MODEL_ALIAS }));
  await started;
  request.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(wakeSignal.aborted, true);
  assert.equal(active, 0);
  releaseReady();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(localCalls, 0);
  assert.equal(f.gateway.getHealth().requests.active, 0);
});
