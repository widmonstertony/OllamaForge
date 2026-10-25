import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { startBridge, STRATA_MODEL, BRIDGE_BASE } from './strata-codex-bridge.mjs';
import { configureStrata } from './strata-config.mjs';
import { adoptOllamaIntegration, connect } from './connect.mjs';

const seen = [];
let reportedModel = STRATA_MODEL;
const mock = (route) => http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ loaded: true, model: reportedModel, max_context: 131072 }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  seen.push({ route, headers: req.headers, url: req.url, body });
  if (req.headers.accept === 'text/event-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  } else {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ route }));
  }
});
const local = mock('strata').listen(0, '127.0.0.1');
const cloud = mock('gateway').listen(0, '127.0.0.1');
await Promise.all([once(local, 'listening'), once(cloud, 'listening')]);
const bridge = startBridge({ port: 0, strataBase: `http://127.0.0.1:${local.address().port}`, ollamaBase: `http://127.0.0.1:${cloud.address().port}` });
await once(bridge, 'listening');
const base = `http://127.0.0.1:${bridge.address().port}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamaforge-strata-test-'));
try {
  const payload = { model: STRATA_MODEL, input: 'ping', tools: [{ type: 'namespace', name: 'test', tools: [{ type: 'function', name: 'ping' }] }] };
  const compressed = zlib.gzipSync(JSON.stringify(payload));
  const response = await fetch(`${base}/api/codex/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer must-not-reach-local', 'chatgpt-account-id': 'private-account', cookie: 'private-cookie', 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: compressed });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).route, 'strata');
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers['chatgpt-account-id'], undefined);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].url, '/v1/responses');
  assert.deepEqual(JSON.parse(seen[0].body).tools, payload.tools);
  assert.equal(JSON.parse(seen[0].body).store, false);

  const cloudBody = Buffer.from(JSON.stringify({ model: 'gpt-new-from-native-catalog', input: 'ping' }));
  const cloudResponse = await fetch(`${base}/api/codex/v1/responses?client_version=1`, { method: 'POST', headers: { authorization: 'Bearer cloud-token', 'chatgpt-account-id': 'cloud-account', 'content-type': 'application/json' }, body: cloudBody });
  assert.equal((await cloudResponse.json()).route, 'gateway');
  assert.equal(seen[1].headers.authorization, 'Bearer cloud-token');
  assert.equal(seen[1].headers['chatgpt-account-id'], 'cloud-account');
  assert.deepEqual(seen[1].body, cloudBody);
  assert.equal(seen[1].url, '/api/codex/v1/responses?client_version=1');
  const stream = await fetch(`${base}/api/codex/v1/responses`, { method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.match(await stream.text(), /event: response.completed/);
  reportedModel = 'qwen3.8-flash-next-iq2_xs';
  const before = seen.length;
  const mismatch = await fetch(`${base}/api/codex/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(mismatch.status, 409);
  assert.equal(seen.length, before, 'Never silently serve Q2 when the user selected Q3.');
  reportedModel = STRATA_MODEL;

  const catalogPath = path.join(work, 'models.json');
  const configPath = path.join(work, 'config.toml');
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: 'gpt-fresh', display_name: 'Newest native cloud model' }, { slug: 'qwen-local', context_window: 16384 }, { slug: 'qwen3.8-flash-next-iq2_xs', display_name: 'Strata old Q2 preset' }, {slug:'qwen3.8-flash-next-iq3_xxs',display_name:'My installed Ollama model'}] }));
  fs.writeFileSync(configPath, `model = "gpt-fresh"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n\n[model_providers.ollamaforge]\nname = "Bridge"\nbase_url = "http://127.0.0.1:11434/api/codex/v1"\nwire_api = "responses"\n`);
  configureStrata(configPath);
  configureStrata(configPath);
  const catalog = JSON.parse(fs.readFileSync(catalogPath));
  assert.equal(catalog.models[0].slug, 'gpt-fresh');
  assert.equal(catalog.models.filter((model) => model.slug === STRATA_MODEL).length, 1);
  assert.equal(catalog.models.at(-1).context_window, 131072);
  assert.match(catalog.models.at(-1).display_name, /IQ3_S/);
  assert.ok(!catalog.models.some((model) => model.slug === 'qwen3.8-flash-next-iq2_xs'), 'Do not leave a misleading Q2 option after switching the runtime to Q3.');
  assert.ok(catalog.models.some((model) => model.slug === 'qwen3.8-flash-next-iq3_xxs'), 'Do not remove another valid model installed in Ollama.');
  assert.match(fs.readFileSync(configPath, 'utf8'), /model = "gpt-fresh"/);
  assert.ok(fs.readFileSync(configPath, 'utf8').includes(`base_url = ${JSON.stringify(BRIDGE_BASE)}`));
  const fakeHome = path.join(work, 'user');
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), `model = "qwen-local"\nopenai_base_url = "http://127.0.0.1:11434/api/codex/v1"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`);
  const actualDir = path.join(work, 'custom-codex-home');
  fs.mkdirSync(actualDir);
  const actualConfig = path.join(actualDir, 'config.toml');
  fs.writeFileSync(actualConfig, 'model = "gpt-fresh"\n[plugins.personal]\nenabled = true\n');
  assert.equal(adoptOllamaIntegration(actualConfig, fakeHome), true);
  const adopted = fs.readFileSync(actualConfig, 'utf8');
  assert.match(adopted, /model = "gpt-fresh"/);
  assert.match(adopted, /\[plugins.personal\]/);
  assert.ok(fs.existsSync(path.join(actualDir, 'ollama-launch-models.json')));
  // A new computer may install Strata without ever installing an Ollama model.
  const freshUser = path.join(work, 'Another User With Spaces');
  const freshConfigDir = path.join(freshUser, 'Custom Codex Home');
  fs.mkdirSync(freshConfigDir, { recursive: true });
  const freshConfig = path.join(freshConfigDir, 'config.toml');
  const originalConfig = 'model = "gpt-native"\n[plugins.personal]\nenabled = true\n';
  fs.writeFileSync(freshConfig, originalConfig);
  fs.writeFileSync(path.join(freshConfigDir, 'ollamaforge-strata.json'), JSON.stringify({ model: STRATA_MODEL }));
  const calls = [];
  const dependencies = {
    platform: 'win32', homeDir: freshUser, environment: { CODEX_HOME: freshConfigDir }, ollamaExecutable: 'ollama',
    refreshCloudCatalog: () => ({ models: [{ slug: 'gpt-native' }, { slug: 'gpt-future' }] }),
    runCommand: (_exe, args) => {
      calls.push(args);
      assert.deepEqual(args, ['list'], 'Strata-only setup must never invoke Ollama launch/pull.');
      return { stdout: 'NAME ID SIZE MODIFIED\n', status: 0 };
    },
  };
  const freshResult = connect({ noShortcut: true, dependencies });
  assert.equal(freshResult.strata, STRATA_MODEL);
  assert.equal(freshResult.defaultModel, 'gpt-native');
  const freshCatalog = JSON.parse(fs.readFileSync(path.join(freshConfigDir, 'ollama-launch-models.json')));
  assert.deepEqual(freshCatalog.models.map((entry) => entry.slug), ['gpt-native', 'gpt-future', STRATA_MODEL]);
  assert.equal(freshCatalog.models.at(-1).include_apps_usage_instructions, true);
  assert.match(fs.readFileSync(freshConfig, 'utf8'), /\[plugins.personal\]\nenabled = true/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(freshUser, '.codex', 'ollama-launch-codex-routing.json'))), { models: [] });
  // Provider settings must not be appended accidentally to a following plugin.
  fs.appendFileSync(freshConfig, '\n[plugins.after_provider]\nenabled = true\n');
  configureStrata(freshConfig);
  const freshText = fs.readFileSync(freshConfig, 'utf8');
  assert.match(freshText, /\[model_providers\.ollamaforge\]\nstream_idle_timeout_ms = 600000/);
  assert.match(freshText, /\[plugins.after_provider\]\nenabled = true/);
  connect({ disconnect: true, dependencies });
  assert.equal(fs.readFileSync(freshConfig, 'utf8'), originalConfig, 'Strata-only disconnect restores the original user configuration.');
  assert.equal(fs.existsSync(path.join(freshConfigDir, 'ollamaforge-strata.json')), false);
  assert.equal(calls.length, 1);
  assert.throws(() => connect({ noShortcut: true, dependencies }), /No local Ollama model is installed/);
  assert.equal(fs.readFileSync(freshConfig, 'utf8'), originalConfig);
  console.log('PASS: fresh Strata-only PC, custom home/username, cloud updates, template fallback, provider scope and restore.');
  console.log('PASS: Strata routing, cloud passthrough, credential isolation, compression, SSE and idempotent 128K catalog.');
} finally {
  for (const server of [bridge, local, cloud]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  fs.rmSync(work, { recursive: true, force: true });
}
