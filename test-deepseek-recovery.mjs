import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { localCompactionPolicy, CompactionBackoff, createGuardedEngine, rewriteCompactionTree } from './deepseek-compaction.mjs';
import { preserveHarnessWork } from './deepseek-recovery.mjs';
import { apply as verifyMigration, completedSessionSnapshot } from './deepseek-migrate-session.mjs';
import { resolveProjectWorkspace } from './deepseek-harness.mjs';

for (const window of [8192, 32768, 65536, 131072]) {
  const policy = localCompactionPolicy(window), output = Math.min(8192, window / 4);
  const threshold = Math.floor(Math.min(window * policy.thresholdRatio, window - output - policy.headroomTokens));
  assert.ok(threshold > (window - output) * policy.retainRatio);
  assert.ok(policy.maxTokens <= 2048);
  assert.equal(policy.compactionRetries, 0);
}
assert.equal(localCompactionPolicy(131072).headroomTokens, 8192);
assert.equal(Math.floor(131072 * localCompactionPolicy(131072).thresholdRatio), 111411);
assert.throws(() => localCompactionPolicy(100));
const migrationLog = zstdCompressSync(Buffer.from([
  { type: 'session', version: 4, id: 'session-fixture', cwd: '/old/project' },
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, data: { turn: 1 } },
].map(row => JSON.stringify(row)).join('\n')));
assert.equal(completedSessionSnapshot(migrationLog, 'session-fixture').events.length, 2);
assert.throws(() => completedSessionSnapshot(migrationLog, 'wrong-session'), /identity/);
const nested = { id: 'preset-standard', config: { id: 'standard', plugins: [{ id: 'tool-pwsh', name: 'keep-shell' },
  { id: 'compaction', isolate: { compaction: true }, config: [{ id: 'compaction-basic', name: 'old-engine' }, { id: 'pruner', name: 'keep-pruner' }] }] } };
const fixedPreset = rewriteCompactionTree(nested, { name: 'bounded-engine', config: { maxTokens: 2048 } });
assert.equal(fixedPreset.config.plugins[1].config[0].name, 'bounded-engine');
assert.equal(fixedPreset.config.plugins[1].config[0].config.maxTokens, 2048);
assert.deepEqual(fixedPreset.config.plugins[0], nested.config.plugins[0]);
assert.deepEqual(fixedPreset.config.plugins[1].config[1], nested.config.plugins[1].config[1]);
assert.equal(nested.config.plugins[1].config[0].name, 'old-engine', 'Do not mutate the original preset.');
const cloudPolicy = { provider: 'cloud', model: 'unrelated', maxTokens: 4096 };
const merged = rewriteCompactionTree({ id: 'compaction-basic', config: { retainRatio: 0.25, modelPolicies: [cloudPolicy] } },
  { config: { modelPolicies: [{ provider: 'ollamaforge-local', model: 'local', maxTokens: 2048 }] } });
assert.equal(merged.config.retainRatio, 0.25);
assert.deepEqual(merged.config.modelPolicies[0], cloudPolicy);
let calls = 0, tokens = 112000;
class FailingSummary {
  async compactIfNeeded() { calls++; throw new Error('summary is not smaller than the shadowed content'); }
}
const state = new CompactionBackoff();
const Guarded = createGuardedEngine(FailingSummary, async () => ({ tokens, window: 131072, output: 8192 }), state, () => ({ totalTokens: tokens }));
const guarded = new Guarded(), agent = { session: {} };
await assert.rejects(() => guarded.compactIfNeeded(agent, 'pressure'), /not smaller/);
for (let step = 0; step < 30; step++) { tokens += 32; assert.equal(await guarded.compactIfNeeded(agent, 'pressure'), null); }
assert.equal(calls, 1, 'A failed summary must not become 30 more model requests.');
tokens = 120200;
await assert.rejects(() => guarded.compactIfNeeded(agent, 'pressure'));
assert.equal(calls, 2, 'Retry only after substantial new history.');
assert.equal(state.decision(agent.session, 121000, 131072, 8192), 'attempt');
await assert.rejects(() => guarded.compactIfNeeded(agent, 'context-overflow'));
assert.equal(calls, 3, 'The separate, bounded upstream overflow recovery is retained.');
assert.equal(state.decision({}, tokens, 131072, 8192), 'attempt', 'No state leaks to another session.');

const selection = { provider: 'ollamaforge-local', model: 'test-local' };
const owner = { session: { requestHeader: () => ({ config: selection }) } };
const input = { messages: [
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the existing project' }] },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden reasoning' }, { type: 'tool-call', name: 'write' }] },
  { role: 'tool', content: [{ type: 'image', data: 'image bytes' }, { type: 'text', text: 'Saved file A' }] },
] };
let summaryCalls = 0, failure = Object.assign(new Error('truncated'), { code: 'MAX_TOKENS' });
class TruncatedSummary {
  async summarize() { summaryCalls++; throw failure; }
}
const Summarizer = createGuardedEngine(TruncatedSummary, async () => ({ tokens, window: 131072, output: 8192 }));
const summarizer = new Summarizer();
for (const size of [112000, 126000]) {
  tokens = size;
  const checkpoint = await summarizer.summarize(input, owner);
  assert.match(checkpoint.summary[0].text, /Keep the existing project/);
  assert.match(checkpoint.summary[0].text, /tool call write/);
  assert.match(checkpoint.summary[0].text, /Saved file A/);
  assert.doesNotMatch(checkpoint.summary[0].text, /hidden reasoning|image bytes/);
  assert.equal(checkpoint.llmStreamCall, undefined);
}
assert.equal(summaryCalls, 1, 'At the hard limit no second summary request is made.');
await assert.rejects(() => summarizer.summarize(input, owner, AbortSignal.abort()), { name: 'AbortError' });
tokens = 112000;
failure = new Error('connection refused');
await assert.rejects(() => summarizer.summarize(input, owner), /connection refused/);
selection.provider = 'cloud';
failure = Object.assign(new Error('truncated'), { code: 'MAX_TOKENS' });
await assert.rejects(() => summarizer.summarize(input, owner), /truncated/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'of-recovery-'));
try {
  const requestFile = path.join(root, 'migration.json'), receiptFile = path.join(root, 'receipt.json');
  const directory = fs.realpathSync(root);
  const request = { sourceId: 'session-aa', targetId: 'session-bb', directory, receiptFile };
  fs.writeFileSync(requestFile, JSON.stringify(request));
  const header = { id: request.targetId, cwd: directory, parentSession: request.sourceId, isSeeded: true };
  let revision = '1', reads = 0, ready = 0;
  const ctx = { sessionPersistence: { stat: async () => ({ header, revision }) },
    sessionController: { inspect: async () => { reads++; return { meta: header, inheritedEventCount: 440 }; } },
    provide: () => { ready++; } };
  await verifyMigration(ctx, { requestFile });
  await verifyMigration(ctx, { requestFile });
  assert.equal(reads, 1, 'An unchanged migrated chat must not replay its history at every launch.');
  revision = '2';
  await verifyMigration(ctx, { requestFile });
  assert.equal(reads, 2, 'A changed session needs a fresh inspection.');
  header.parentSession = 'session-cc';
  await assert.rejects(() => verifyMigration(ctx, { requestFile }), /another operation/);
  assert.equal(ready, 3);
  const source = path.join(root, '旧项目'), target = path.join(root, 'new project');
  fs.mkdirSync(source); fs.mkdirSync(path.join(source, '__pycache__'));
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime); fs.mkdirSync(path.join(runtime, 'live-test'));
  assert.equal(resolveProjectWorkspace(source, runtime), fs.realpathSync(source));
  assert.throws(() => resolveProjectWorkspace(runtime, runtime), /real project/);
  assert.throws(() => resolveProjectWorkspace(path.join(runtime, 'live-test'), runtime), /real project/);
  fs.writeFileSync(path.join(source, 'progress.txt'), 'Retained progress 用户数据');
  const sessionFile = path.join(root, 'session.zstd');
  const log = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', data: { id: 'same-session' } }) + '\n'));
  fs.writeFileSync(sessionFile, log);
  const receipt = preserveHarnessWork({ sessionFile, sourceDirectory: source, targetDirectory: target, backupDirectory: path.join(root, 'backup') });
  assert.equal(receipt.files.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(target, 'progress.txt')), fs.readFileSync(path.join(source, 'progress.txt')));
  assert.deepEqual(fs.readFileSync(path.join(root, 'backup', 'session.v4.jsonl.zstd')), log);
  fs.writeFileSync(path.join(target, 'progress.txt'), 'Existing unrelated changes');
  assert.throws(() => preserveHarnessWork({ sessionFile, sourceDirectory: source, targetDirectory: target, backupDirectory: path.join(root, 'rejected') }), /overwrite/);
  assert.ok(!fs.existsSync(path.join(root, 'rejected')), 'Conflict is rejected before any writes.');
  assert.equal(fs.readFileSync(path.join(target, 'progress.txt'), 'utf8'), 'Existing unrelated changes');
} finally {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('of-recovery-')) throw new Error('Invalid test cleanup target.');
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('PASS: 128K compaction budget; 30 no-progress retries suppressed; hard limit and overflow preserved; session/files copied with conflict refusal and Unicode paths.');
