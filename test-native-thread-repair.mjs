import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { correctProviderIndex, sessionOrigin } from './repair-native-thread.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-index-repair-'));
const id = '01000000-0000-7000-8000-000000000001';
try {
  const databaseFile = path.join(root, 'state.sqlite');
  const db = new DatabaseSync(databaseFile);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,model TEXT,cwd TEXT,sandbox_policy TEXT,approval_mode TEXT,updated_at INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id, 'ollamaforge', 'gpt-cloud', '/original/workspace', 'original-policy', 'original-approval', 123);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run('other', 'company', 'other-model', '/other', 'other-policy', 'other-approval', 456);
  const before = db.prepare('SELECT * FROM threads ORDER BY id').all(); db.close();
  const options = { databaseFile, id, origin: { id, provider: 'openai' }, target: 'openai', backupRoot: path.join(root, 'backup'), nativeModels: new Set(['gpt-cloud']) };
  await assert.rejects(correctProviderIndex({ ...options, nativeModels: new Set(['other-model']) }), /current native catalog/);
  await assert.rejects(correctProviderIndex({ ...options, assertIdle: () => { throw new Error('active original turn'); } }), /active original turn/);
  assert(!fs.existsSync(options.backupRoot));
  await assert.rejects(correctProviderIndex({ ...options, origin: { id, provider: 'ollamaforge' } }), /canonical session/);
  assert((await correctProviderIndex(options)).changed);
  let read = new DatabaseSync(databaseFile, { readOnly: true });
  const after = read.prepare('SELECT * FROM threads ORDER BY id').all(); read.close();
  const expected = before.map(row => row.id === id ? { ...row, model_provider: 'openai' } : { ...row });
  assert.deepEqual(after.map(row => ({ ...row })), expected);
  assert.equal((await correctProviderIndex(options)).changed, false);
  const saved = new DatabaseSync(path.join(root, 'backup', 'state-before.sqlite'), { readOnly: true });
  assert.deepEqual(saved.prepare('SELECT * FROM threads ORDER BY id').all(), before); saved.close();
  const trigger = new DatabaseSync(databaseFile);
  trigger.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('ollamaforge', id);
  trigger.exec("CREATE TRIGGER accidental_policy_change AFTER UPDATE OF model_provider ON threads BEGIN UPDATE threads SET approval_mode='changed' WHERE id=NEW.id; END"); trigger.close();
  await assert.rejects(correctProviderIndex({ ...options, backupRoot: path.join(root, 'trigger-backup') }), /Unexpected metadata change/);
  read = new DatabaseSync(databaseFile, { readOnly: true });
  assert.deepEqual(read.prepare('SELECT * FROM threads ORDER BY id').all(), before); read.close();
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'openai' } }) + '\n' + 'remaining history is not rewritten\n');
  assert.deepEqual(await sessionOrigin(rollout), { id, provider: 'openai' });
  assert(fs.readFileSync(rollout, 'utf8').endsWith('remaining history is not rewritten\n'));
  console.log('PASS: same-ID repair requires canonical native provenance; only one provider field changes, policy/history/other chats preserved, verified backup and transactional rollback.');
} finally {
  assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('codex-index-repair-'));
  fs.rmSync(root, { recursive: true });
}
