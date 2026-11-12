import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { connectCodex } from './codex-app-server.mjs';
import { threadId, historyFingerprint, turnsFingerprint } from './repair-codex-thread.mjs';

export async function sessionOrigin(file) {
  const input = fs.createReadStream(file);
  const stream = file.endsWith('.zst') ? input.pipe(createZstdDecompress()) : input;
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 4 * 1024 * 1024) throw new Error('Unexpected oversized session header.');
      const record = JSON.parse(line);
      if (record.type !== 'session_meta') throw new Error('Session metadata must be the first record.');
      return { id: record.payload.id, provider: record.payload.model_provider };
    }
    throw new Error('Session header is missing.');
  } finally { lines.close(); stream.destroy(); input.destroy(); }
}

// This is an index repair, not an arbitrary provider migration. Canonical original
// metadata must already identify the same native provider. Never change policies.
export async function correctProviderIndex({ databaseFile, id, origin, target, backupRoot, nativeModels, assertIdle = () => {} }) {
  if (origin.id !== id || origin.provider !== target || target !== 'openai') throw new Error('The canonical session does not prove this is an original native chat.');
  if (!fs.existsSync(databaseFile)) throw new Error('Expected existing state database is missing; no database was created.');
  assertIdle();
  const db = new DatabaseSync(databaseFile);
  db.exec('PRAGMA busy_timeout=5000');
  let before;
  try {
    before = db.prepare('SELECT * FROM threads WHERE id=?').get(id);
    if (!before) throw new Error('Thread index row is missing.');
    if (before.model_provider === target) return { changed: false };
    if (before.model_provider !== 'ollamaforge' || !(nativeModels instanceof Set) || !nativeModels.has(before.model)) throw new Error('The saved model is not in the current native catalog; no change made.');
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    await backup(db, path.join(backupRoot, 'state-before.sqlite'));
    fs.writeFileSync(path.join(backupRoot, 'original-index-row.json'), JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 });
    db.exec('BEGIN IMMEDIATE');
    try {
      assertIdle();
      const current = db.prepare('SELECT * FROM threads WHERE id=?').get(id);
      if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error('The thread changed during backup; no repair applied.');
      const change = db.prepare('UPDATE threads SET model_provider=? WHERE id=? AND model_provider=?').run(target, id, before.model_provider);
      if (change.changes !== 1) throw new Error('Expected exactly one index row.');
      const after = db.prepare('SELECT * FROM threads WHERE id=?').get(id);
      const expected = { ...before, model_provider: target };
      if (JSON.stringify(after) !== JSON.stringify(expected)) throw new Error('Unexpected metadata change; rolling back.');
      db.exec('COMMIT');
      return { changed: true, before: before.model_provider, after: target };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export async function repairOriginal({ client, id, home, outputRoot, apply = false }) {
  id = threadId(id);
  const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
  if (thread.status?.type === 'active') throw new Error('Wait for the original chat to finish its active turn.');
  const { config } = await client.request('config/read', { includeLayers: false, cwd: thread.cwd });
  const provider = config.model_provider ?? 'openai';
  if (provider !== 'openai') throw new Error('Native global provider must remain openai.');
  if (thread.modelProvider === provider) return { repaired: false, id, provider, reason: 'Provider already matches.' };
  const normalize = value => process.platform === 'win32' ? path.win32.normalize(value.replace(/^\\+\?\\+/, '')) : value;
  const rollout = normalize(thread.path ?? '');
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const allowed = ['sessions', 'archived_sessions'].some(dir => comparable(rollout).startsWith(comparable(path.join(home, dir) + path.sep)));
  if (!allowed) throw new Error('Original rollout is outside the expected Codex session directory.');
  const stored = [rollout, rollout + '.zst'].find(file => fs.existsSync(file));
  if (!stored) throw new Error('The canonical rollout must be present for an original-ID repair.');
  const origin = await sessionOrigin(stored);
  if (origin.id !== id || origin.provider !== provider) throw new Error('This is a real provider change, not index drift. Original-ID repair refused.');
  if (!apply) return { id, indexProvider: thread.modelProvider, canonicalProvider: origin.provider, repairableInPlace: true };
  if (config.model_catalog_json || config.openai_base_url) throw new Error('Restore unmodified native model discovery with repair:native before applying this repair.');
  const nativeModels = new Set();
  let cursor;
  do {
    const page = await client.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
    for (const model of page.data) nativeModels.add(model.id);
    cursor = page.nextCursor;
  } while (cursor);
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(outputRoot, id + '-original-'));
  const before = { turns: await turnsFingerprint(client, id), items: await historyFingerprint(client, id, { output: path.join(directory, 'history-before.jsonl') }) };
  fs.copyFileSync(stored, path.join(directory, path.basename(stored)), fs.constants.COPYFILE_EXCL);
  const databaseFile = path.join(config.sqlite_home ?? home, 'state_5.sqlite');
  const assertIdle = () => {
    const history = new DatabaseSync(path.join(config.sqlite_home ?? home, 'thread_history_1.sqlite'), { readOnly: true });
    try {
      const active = history.prepare("SELECT COUNT(*) AS count FROM thread_turns WHERE thread_id=? AND status NOT IN ('completed','failed','interrupted')").get(id);
      if (active.count) throw new Error('The original chat has an active turn in persisted history; no index change made.');
    } finally { history.close(); }
  };
  const correction = await correctProviderIndex({ databaseFile, id, origin, target: provider, backupRoot: directory, assertIdle, nativeModels });
  try {
    const resumed = await client.request('thread/resume', { threadId: id, excludeTurns: true });
    if (resumed.thread.id !== id || resumed.thread.modelProvider !== provider || resumed.thread.cwd !== thread.cwd) throw new Error('Original resume identity/provider/workspace differs.');
    const after = { turns: await turnsFingerprint(client, id, { prefixLength: before.turns.count }),
      items: await historyFingerprint(client, id, { prefixLength: before.items.count }) };
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Original history changed during verification.');
    const result = { id, repaired: true, sameId: true, provider, correction, proof: after, backup: directory, url: `codex://threads/${id}` };
    fs.writeFileSync(path.join(directory, 'verified.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } catch (error) {
    // Roll back only our single field; never restore a whole live database.
    if (correction.changed) {
      const db = new DatabaseSync(databaseFile);
      try { db.prepare('UPDATE threads SET model_provider=? WHERE id=? AND model_provider=?').run(correction.before, id, provider); } finally { db.close(); }
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--thread');
  if (at < 0) console.log('node repair-native-thread.mjs --thread <original-UUID> [--apply]');
  else {
    const client = await connectCodex();
    try {
      console.log(JSON.stringify(await repairOriginal({ client, id: args[at + 1], home: process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
        outputRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '.runtime', 'original-thread-repair'), apply: args.includes('--apply') }), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await client.close(); }
  }
}
