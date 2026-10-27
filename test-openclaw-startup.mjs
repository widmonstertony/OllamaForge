import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectGateway, gatewayReply, loadGatewayIdentity } from './openclaw-gateway.mjs';
import { warmOpenClaw } from './openclaw-startup.mjs';
import { openClawEnvironment, openClawToolDirectories, strataModelDefinition, withOpenClawPerformanceDefaults } from './openclaw-performance.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamaforge-openclaw-'));
const identity = loadGatewayIdentity(path.join(directory, 'identity.json'));
assert.deepEqual(loadGatewayIdentity(path.join(directory, 'identity.json')), identity);
const config = { gateway: { port: 18789, auth: { mode: 'token', token: 'fixture-only' } }, tools: { profile: 'full' }, agents: { defaults: { model: { primary: 'strata/test' } } } };
const original = JSON.stringify(config);
const defaults = withOpenClawPerformanceDefaults(config);
assert.equal(JSON.stringify(config), original);
assert.deepEqual(defaults.tools, config.tools);
assert.deepEqual(defaults.agents.defaults.model, config.agents.defaults.model);
assert.equal(defaults.agents.defaults.heartbeat.every, '0m');
assert(defaults.skills.allowBundled.includes('github'));
assert(defaults.skills.allowBundled.includes('control-ui'));
assert.equal(defaults.skills.load.watch, false);
const custom = { ...config, agents: { defaults: { ...config.agents.defaults, heartbeat: { every: '10m' } } }, skills: { allowBundled: ['my-choice'], load: { watch: true, extraDirs: ['D:/my-skills'] } } };
assert.deepEqual(withOpenClawPerformanceDefaults(custom), custom);
const env = openClawEnvironment({ Path: 'C:\\Windows;C:\\WINDOWS\\;D:\\Tools;D:\\Missing;.;.;C:;C:\\', OTHER: 'unchanged' });
assert.equal(env.Path, 'C:\\Windows;D:\\Tools;D:\\Missing;.;C:;C:\\');
assert.equal(env.OTHER, 'unchanged');
assert.equal(env.OPENCLAW_NO_RESPAWN, '1');
const desktopGit = path.join(directory, 'GitHubDesktop', 'app-3.6.7', 'resources', 'app', 'git', 'cmd');
fs.mkdirSync(desktopGit, { recursive: true }); fs.writeFileSync(path.join(desktopGit, 'git.exe'), 'fixture');
assert(openClawToolDirectories({ LOCALAPPDATA: directory, Path: '' }).includes(desktopGit));
const resolvedEnv = openClawEnvironment({ Path: 'C:\\Windows;C:\\WINDOWS' }, ['D:\\Git\\cmd']);
assert.equal(resolvedEnv.Path, 'D:\\Git\\cmd;C:\\Windows');
const mixedCasePath = openClawEnvironment({ Path: 'ignored-shadow', PATH: 'C:\\Windows;C:\\WINDOWS' });
assert.equal(mixedCasePath.PATH, 'C:\\Windows');
assert.equal(mixedCasePath.Path, undefined);
const qwen = strataModelDefinition({ model: 'qwen3.8-flash-next-iq3_s', max_context: 131072, images: true });
assert.equal(qwen.reasoning, true);
assert.equal(qwen.compat.thinkingFormat, 'qwen-chat-template');
assert.equal(qwen.contextTokens, 131072);
assert.deepEqual(qwen.input, ['text', 'image']);
assert.equal(strataModelDefinition({ model: 'other-model', max_context: 8192 }).compat, undefined);

let finalText = 'FIXTURE_OK', malformedChallenge = false, replyDelay = 5, connectFrame, settledStatus = 'ok', sockets = 0, startupRejections = 0;
class FakeSocket extends EventTarget {
  constructor(url) {
    super(); sockets++; assert.equal(url, 'ws://127.0.0.1:18789');
    queueMicrotask(() => this.emit({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fresh-nonce', ts: malformedChallenge ? -1 : 1000 } }));
  }
  emit(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  send(raw) {
    const message = JSON.parse(raw);
    if (message.method === 'connect') {
      connectFrame = message.params;
      const params = message.params;
      assert.deepEqual(params.scopes, ['operator.read', 'operator.write']);
      assert(!params.scopes.includes('operator.admin'));
      assert.equal(params.device.nonce, 'fresh-nonce');
      const payload = ['v3', identity.deviceId, 'cli', 'cli', 'operator', params.scopes.join(','), '1000', 'fixture-only', 'fresh-nonce', 'win32', ''].join('|');
      assert(crypto.verify(null, Buffer.from(payload), identity.publicKeyPem, Buffer.from(params.device.signature, 'base64url')));
      queueMicrotask(() => this.emit({ type: 'res', id: message.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } }));
    } else if (message.method === 'agent.wait') {
      assert.equal(message.params.runId, 'fixture-run');
      queueMicrotask(() => this.emit({ type: 'res', id: message.id, ok: true, payload: { status: settledStatus } }));
    } else if (message.method === 'chat.send') {
      assert.equal(message.params.sessionKey, 'agent:main:ollamaforge-startup-check');
      if (startupRejections > 0) {
        startupRejections--;
        queueMicrotask(() => this.emit({ type: 'res', id: message.id, ok: false, error: { code: 'UNAVAILABLE', message: 'Agent startup admission pending' } }));
        return;
      }
      queueMicrotask(() => this.emit({ type: 'res', id: message.id, ok: true, payload: { runId: 'fixture-run', status: 'started' } }));
      setTimeout(() => this.emit({ type: 'event', event: 'chat', payload: { sessionKey: message.params.sessionKey, runId: 'fixture-run', state: 'final', message: { content: [{ type: 'text', text: finalText }] } } }), replyDelay);
    }
  }
  close() { this.dispatchEvent(new Event('close')); }
}

try {
  let client = await connectGateway({ config, identity, WebSocketClass: FakeSocket });
  const reply = await gatewayReply(client, { sessionKey: 'agent:main:ollamaforge-startup-check', message: 'local test', marker: 'FIXTURE_OK', timeoutMs: 1000 });
  assert.equal(reply.text, 'FIXTURE_OK'); assert(reply.firstTextMs >= 0);
  assert.equal(connectFrame.auth.token, 'fixture-only'); client.close();

  finalText = 'wrong result';
  client = await connectGateway({ config, identity, WebSocketClass: FakeSocket });
  await assert.rejects(gatewayReply(client, { sessionKey: 'agent:main:ollamaforge-startup-check', message: 'local test', marker: 'FIXTURE_OK', timeoutMs: 1000 }), /verification marker/);
  client.close();
  malformedChallenge = true;
  await assert.rejects(connectGateway({ config, identity, WebSocketClass: FakeSocket }), /Invalid Gateway challenge/);
  malformedChallenge = false;
  await assert.rejects(connectGateway({ config: { gateway: { port: 70000 } }, identity, WebSocketClass: FakeSocket }), /Invalid local Gateway port/);

  const previousFetch = globalThis.fetch, previousSocket = globalThis.WebSocket;
  const configFile = path.join(directory, 'config.json'), receiptFile = path.join(directory, 'ready.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  globalThis.fetch = async url => {
    if (url === 'http://127.0.0.1:18789/readyz') return { ok: true };
    assert.equal(url, 'http://127.0.0.1:8080/health');
    return { ok: true, json: async () => ({ service: 'strata', loaded: true, model: 'test' }) };
  };
  globalThis.WebSocket = FakeSocket;
  finalText = 'OLLAMAFORGE_OPENCLAW_READY'; replyDelay = 60;
  try {
    const args = { configFile, identityFile: path.join(directory, 'identity.json'), receiptFile, pid: 123, model: 'test', log: () => {} };
    const preparation = warmOpenClaw({ ...args, signal: new AbortController().signal });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert(!fs.existsSync(receiptFile), 'HTTP/handshake alone must not publish readiness');
    await preparation;
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.pid, 123); assert.equal(receipt.model, 'test');
    fs.unlinkSync(receiptFile);
    finalText = 'incorrect answer';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await warmOpenClaw({ ...args, signal: controller.signal });
    assert(!fs.existsSync(receiptFile), 'failed inference must never publish readiness');
    finalText = 'OLLAMAFORGE_OPENCLAW_READY'; settledStatus = 'error';
    const failedCommit = new AbortController(); setTimeout(() => failedCommit.abort(), 150);
    await warmOpenClaw({ ...args, signal: failedCommit.signal });
    assert(!fs.existsSync(receiptFile), 'a visible reply without successful run settlement is not ready');
    settledStatus = 'ok';
    const fetchHealthy = globalThis.fetch, before = sockets;
    globalThis.fetch = async url => url.endsWith('/readyz') ? { ok: false } : fetchHealthy(url);
    const notReady = new AbortController(); setTimeout(() => notReady.abort(), 20);
    await warmOpenClaw({ ...args, signal: notReady.signal });
    assert.equal(sockets, before, 'startup must not hammer auth/SQLite before Gateway readiness');
    globalThis.fetch = fetchHealthy;
    startupRejections = 4; replyDelay = 5;
    await warmOpenClaw({ ...args, signal: new AbortController().signal, wait: async () => {} });
    assert.equal(startupRejections, 0);
    assert(fs.existsSync(receiptFile), 'transient agent startup refusals must not exhaust inference failure attempts');
  } finally { globalThis.fetch = previousFetch; globalThis.WebSocket = previousSocket; }
  console.log('PASS: signed local Gateway auth, reply validation, genuine inference readiness, failed-warmup refusal, PATH deduplication and user settings/tool preservation.');
} finally {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert(path.basename(directory).startsWith('ollamaforge-openclaw-'));
  fs.rmSync(directory, { recursive: true });
}
