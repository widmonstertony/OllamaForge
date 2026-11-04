import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { connectCodex, resolveCodexEntrypoint } from './codex-app-server.mjs';
import { threadId, configurationSnapshot, repairThread, historyFingerprint, turnsFingerprint, verifyContinuation, pages } from './repair-codex-thread.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamaforge-thread-'));
const oldId = '01000000-0000-7000-8000-000000000001', newId = '01000000-0000-7000-8000-000000000002';
try {
  assert.equal(threadId(`codex://threads/${oldId}`), oldId);
  assert.throws(() => threadId('../config.toml'), /UUID/);
  fs.writeFileSync(path.join(directory, 'config.toml'), 'model_provider="openai"\nmodel="cloud-new"\n');
  fs.writeFileSync(path.join(directory, 'ollama-launch-models.json'), '{"local":"qwen","cloud":"cloud-new"}');
  const rollout = path.join(directory, 'source.jsonl'); fs.writeFileSync(rollout, 'private original history\n');
  const original = { id: oldId, modelProvider: 'ollamaforge', cwd: directory, path: rollout, status: { type: 'idle' } };
  let child, forks = 0, goal = null, resumeError;
  const turns = [{ id: 'turn-1', status: 'completed' }, { id: 'empty-failed-turn', status: 'failed', error: { message: 'old connection failure' } }];
  const items = [
    { turnId: 'turn-1', item: { id: 'user-1', type: 'userMessage', content: [{ text: 'Keep my progress' }] } },
    { turnId: 'turn-1', item: { id: 'tool-1', type: 'commandExecution', command: 'read existing state', output: 'completed work' } },
    { turnId: 'turn-1', item: { id: 'answer-1', type: 'agentMessage', text: 'Outstanding work remains' } },
  ];
  let childItems = structuredClone(items);
  const methods = [];
  const client = { request: async (method, params) => {
    methods.push(method);
    if (method === 'thread/read') return { thread: params.threadId === oldId ? original : child };
    if (method === 'config/read') return { config: { model_provider: 'openai', model: 'cloud-new' } };
    if (method === 'thread/goal/get') return { goal };
    if (method === 'thread/attachment/list') return { data: [], nextCursor: null };
    if (method === 'thread/turns/list' || method === 'thread/items/list') {
      const data = method === 'thread/turns/list' ? turns : (params.threadId === oldId ? items : childItems);
      // Exercise opaque pagination, including the final failed/empty turn.
      const offset = params.cursor ? Number(params.cursor.split(':')[1]) : 0;
      const end = Math.min(offset + 1, data.length);
      return { data: data.slice(offset, end), nextCursor: end < data.length ? `opaque:${end}` : null };
    }
    if (method === 'thread/fork') {
      forks++; assert.equal(params.modelProvider, 'openai'); assert.equal(params.model, 'cloud-new');
      assert(!('config' in params)); assert(!('sandbox' in params)); assert(!('approvalPolicy' in params));
      child = { ...original, id: newId, modelProvider: params.modelProvider, forkedFromId: oldId }; return { thread: child };
    }
    if (method === 'thread/resume') { if (resumeError) throw new Error(resumeError); return { thread: child }; }
    throw new Error('Unexpected method: ' + method);
  } };
  const options = { client, id: oldId, home: directory, outputRoot: path.join(directory, 'backups'), log: () => {} };
  const before = configurationSnapshot(directory);
  const diagnostic = await repairThread(options);
  assert.equal(diagnostic.mismatch, true); assert.equal(forks, 0); assert(!fs.existsSync(options.outputRoot));
  original.modelProvider = 'openai';
  assert.equal((await repairThread({ ...options, apply: true })).repaired, false); assert.equal(forks, 0);
  original.modelProvider = 'ollamaforge';
  const result = await repairThread({ ...options, apply: true });
  assert(result.verified); assert.equal(result.proof.turns.count, 2); assert.equal(result.proof.items.count, 3);
  assert.equal(fs.readFileSync(path.join(result.backup, 'rollout.jsonl'), 'utf8'), fs.readFileSync(rollout, 'utf8'));
  assert.equal(fs.readFileSync(path.join(result.backup, 'history.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.deepEqual(configurationSnapshot(directory), before);
  assert.equal(original.modelProvider, 'ollamaforge');
  childItems.push({ turnId: 'later-turn', item: { id: 'later-item', text: 'New progress after repair' } });
  resumeError = `thread ${newId} already has an active writer`;
  const reused = await repairThread({ ...options, apply: true });
  assert.equal(reused.childThreadId, newId); assert.equal(forks, 1); assert.equal(reused.resumeCheck.status, 'requires-current-owner');
  childItems[1].item.output = 'lost or changed progress';
  const fingerprints = { turns: await turnsFingerprint(client, oldId), items: await historyFingerprint(client, oldId) };
  await assert.rejects(verifyContinuation(client, original, child, fingerprints), /Full-history comparison failed/);
  childItems = structuredClone(items);
  resumeError = 'modelProviderMismatch';
  await assert.rejects(repairThread({ ...options, verifyId: newId }), /modelProviderMismatch/);
  original.status.type = 'active';
  await assert.rejects(repairThread({ ...options, apply: true }), /finish/); original.status.type = 'idle';
  goal = { objective: 'preserve existing goal' };
  await assert.rejects(repairThread({ ...options, outputRoot: path.join(directory, 'goal-backup'), apply: true }), /goal or attachments/);
  assert.equal(forks, 1);
  const repeatedCursor = { request: async () => ({ data: [], nextCursor: 'same' }) };
  await assert.rejects(async () => { for await (const _ of pages(repeatedCursor, 'test', {})) {} }, /Repeated history cursor/);
  assert(!methods.some(method => /delete|archive|config\/.*write|turn\/start|approval/i.test(method)));

  const npmRoot = path.join(directory, 'npm', 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(npmRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ bin: { codex: 'bin/codex.js' } }));
  fs.writeFileSync(path.join(npmRoot, 'bin', 'codex.js'), '// installed entry fixture');
  assert.equal(resolveCodexEntrypoint([path.join(directory, 'npm', 'codex.cmd')], 'win32'), path.join(npmRoot, 'bin', 'codex.js'));
  fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ bin: { codex: '../../../outside.js' } }));
  assert.throws(() => resolveCodexEntrypoint([path.join(directory, 'npm', 'codex.cmd')], 'win32'), /Install Codex/);

  const frames = []; let processDouble;
  const spawnProcess = (exe, args, options) => {
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']); assert.equal(options.windowsHide, true);
    const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.stdin = new Writable({ write(chunk, encoding, done) {
      const frame = JSON.parse(chunk.toString()); frames.push(frame);
      if (frame.method === 'initialize') queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\n'));
      if (frame.method === 'success') queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: frame.id, result: { ok: true } }) + '\n'));
      done();
    } });
    proc.stdin.on('finish', () => proc.emit('exit', 0)); proc.kill = () => proc.emit('exit', 0);
    processDouble = proc; return proc;
  };
  let rpc = await connectCodex({ executable: 'codex-fixture', spawnProcess, timeoutMs: 200 });
  assert.deepEqual(await rpc.request('success'), { ok: true });
  processDouble.stdout.write(JSON.stringify({ id: 900, method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert(frames.find(frame => frame.id === 900)?.error); assert(!frames.find(frame => frame.id === 900)?.result);
  await assert.rejects(rpc.request('no-response'), /timed out/); await rpc.close();
  rpc = await connectCodex({ executable: 'codex-fixture', spawnProcess, timeoutMs: 200 });
  const pending = rpc.request('invalid-response'); processDouble.stdout.write('not JSON\n');
  await assert.rejects(pending, /Invalid app-server JSON/); await rpc.close();
  console.log('PASS: full-history provider recovery, failed turns/tool output, backups, idempotence, unchanged cloud/local configuration, writer ownership and stdio approval refusal.');
} finally {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert(path.basename(directory).startsWith('ollamaforge-thread-'));
  fs.rmSync(directory, { recursive: true });
}
