import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectCodex } from './codex-app-server.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export function threadId(value) {
  const id = value?.startsWith('codex://threads/') ? value.slice('codex://threads/'.length) : value;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '')) throw new Error('Pass a Codex thread UUID or codex://threads/<UUID>.');
  return id;
}

export function configurationSnapshot(home) {
  const names = ['config.toml', 'ollama-launch-models.json', 'ollama-launch-codex-routing.json', 'local-qwen-catalog.json',
    ...fs.readdirSync(home).filter(name => name.endsWith('.config.toml'))];
  return Object.fromEntries(names.map(name => {
    const file = path.join(home, name);
    return [name, fs.existsSync(file) ? digest(fs.readFileSync(file)) : null];
  }));
}

export async function* pages(client, method, params) {
  let cursor;
  const seen = new Set();
  do {
    const page = await client.request(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error(`Unexpected ${method} history response.`);
    yield page.data;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Repeated history cursor; verification stopped.');
    seen.add(cursor);
  } while (cursor);
}

// Compare complete persisted item content, not just summaries or recent turns.
export async function historyFingerprint(client, id, { prefixLength = Infinity, output } = {}) {
  const hash = crypto.createHash('sha256');
  let count = 0, fd;
  if (output) fd = fs.openSync(output, 'wx', 0o600);
  try {
    outer: for await (const items of pages(client, 'thread/items/list', { threadId: id, sortDirection: 'asc', limit: 200 })) {
      for (const entry of items) {
        if (count >= prefixLength) break outer;
        const line = JSON.stringify({ turnId: entry.turnId, item: entry.item }) + '\n';
        hash.update(line); if (fd !== undefined) fs.writeSync(fd, line); count++;
      }
    }
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return { count, sha256: hash.digest('hex') };
}

export async function turnsFingerprint(client, id, { prefixLength = Infinity } = {}) {
  const hash = crypto.createHash('sha256');
  let count = 0;
  outer: for await (const turns of pages(client, 'thread/turns/list', { threadId: id, sortDirection: 'asc', itemsView: 'notLoaded', limit: 100 })) {
    for (const turn of turns) {
      if (count >= prefixLength) break outer;
      hash.update(JSON.stringify({ id: turn.id, status: turn.status, error: turn.error }) + '\n'); count++;
    }
  }
  return { count, sha256: hash.digest('hex') };
}

export async function verifyContinuation(client, source, child, fingerprints) {
  if (child.id === source.id || child.forkedFromId !== source.id || child.cwd !== source.cwd) throw new Error('Continuation identity/workspace differs from the source.');
  const turns = await turnsFingerprint(client, child.id, { prefixLength: fingerprints.turns.count });
  const items = await historyFingerprint(client, child.id, { prefixLength: fingerprints.items.count });
  if (JSON.stringify(turns) !== JSON.stringify(fingerprints.turns) || JSON.stringify(items) !== JSON.stringify(fingerprints.items)) throw new Error('Full-history comparison failed; the source was preserved and the child was not verified.');
  return { turns, items };
}

async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

export async function repairThread({ client, id, home, outputRoot, apply = false, verifyId, log = console.log }) {
  id = threadId(id);
  const originalConfig = configurationSnapshot(home);
  const { thread: source } = await client.request('thread/read', { threadId: id, includeTurns: false });
  if (source.status?.type === 'active') throw new Error('Wait for the source turn to finish before migrating.');
  const { config } = await client.request('config/read', { includeLayers: false, cwd: source.cwd });
  const provider = config.model_provider ?? 'openai';
  const diagnosis = { sourceThreadId: id, savedProvider: source.modelProvider, currentProvider: provider, cwd: source.cwd, mismatch: source.modelProvider !== provider };
  if (!apply && !verifyId) return diagnosis;
  if (!diagnosis.mismatch && !verifyId) return { ...diagnosis, repaired: false, reason: 'Provider already matches; no fork created.' };
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(outputRoot, `${id}-${provider}.json`);
  // Reuse a previously verified continuation instead of creating another branch.
  if (!verifyId && fs.existsSync(receiptFile)) verifyId = JSON.parse(fs.readFileSync(receiptFile, 'utf8')).childThreadId;
  const backup = fs.mkdtempSync(path.join(outputRoot, `${id}-`));
  const write = (name, data) => fs.writeFileSync(path.join(backup, name), JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  write('source.json', source); write('configuration-hashes.json', originalConfig);
  if (source.path && !verifyId) {
    const target = path.join(backup, 'rollout.jsonl');
    fs.copyFileSync(source.path, target, fs.constants.COPYFILE_EXCL);
    if (await fileHash(source.path) !== await fileHash(target)) throw new Error('The source changed during backup; no fork created.');
  }
  const fingerprints = {
    turns: await turnsFingerprint(client, id),
    items: await historyFingerprint(client, id, { output: path.join(backup, 'history.jsonl') }),
  };
  write('fingerprints.json', fingerprints);
  const goal = await client.request('thread/goal/get', { threadId: id });
  const attachments = [];
  for await (const entries of pages(client, 'thread/attachment/list', { threadId: id, limit: 100 })) attachments.push(...entries);
  write('goal-and-attachments.json', { goal, attachments });
  if (!verifyId && (goal.goal || attachments.length)) throw new Error('This thread has a goal or attachments. Use the desktop same-directory fork to preserve their app context, then run --verify <child-id>. No fork created.');
  log(`Backed up ${fingerprints.turns.count} turns and ${fingerprints.items.count} complete history items.`);
  const { thread: child } = verifyId
    ? await client.request('thread/read', { threadId: threadId(verifyId), includeTurns: false })
    : await client.request('thread/fork', { threadId: id, modelProvider: provider, model: config.model, excludeTurns: true });
  // Store the new ID immediately so a later verification error never loses it.
  write('continuation.json', { childThreadId: child.id, targetProvider: provider, verified: false });
  if (child.modelProvider !== provider) throw new Error('Continuation did not use the current provider.');
  const proof = await verifyContinuation(client, source, child, fingerprints);
  const childGoal = await client.request('thread/goal/get', { threadId: child.id });
  if (JSON.stringify(goal) !== JSON.stringify(childGoal)) throw new Error('Goal state differs; source preserved.');
  const childAttachments = [];
  for await (const entries of pages(client, 'thread/attachment/list', { threadId: child.id, limit: 100 })) childAttachments.push(...entries);
  const attachmentKeys = entries => entries.map(a => JSON.stringify({ type: a.attachmentType, key: a.identityKey, payload: a.payload })).sort();
  if (JSON.stringify(attachmentKeys(attachments)) !== JSON.stringify(attachmentKeys(childAttachments))) throw new Error('Attachments differ; source preserved.');
  let resumeCheck = { status: 'passed' };
  try {
    const resumed = await client.request('thread/resume', { threadId: child.id, excludeTurns: true });
    if (resumed.thread.modelProvider !== provider) throw new Error('Resumed provider mismatch.');
  } catch (error) {
    if (!/already has an active writer/.test(error.message)) throw error;
    // The desktop may already own this idle thread. Never steal its lease or
    // edit its database; the next reply must be tested through that owner.
    resumeCheck = { status: 'requires-current-owner', message: 'Continue in the desktop app that already owns this thread.' };
  }
  if (JSON.stringify(configurationSnapshot(home)) !== JSON.stringify(originalConfig)) throw new Error('Global configuration changed during recovery; inspect the private snapshot before continuing.');
  const result = { ...diagnosis, childThreadId: child.id, verified: true, backup, proof, resumeCheck, globalConfigurationUnchanged: true, url: `codex://threads/${child.id}` };
  write('verified.json', result);
  fs.writeFileSync(receiptFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  if (args.includes('--help') || !option('--thread')) {
    console.log('node repair-codex-thread.mjs --thread <UUID|codex://threads/UUID> [--apply | --verify <child-UUID>] [--codex <executable>]');
    console.log('Default: read-only diagnosis. Apply: back up and fork full history with the current provider; global settings and the original chat stay unchanged.'); return;
  }
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const client = await connectCodex({ ...(option('--codex') ? { executable: option('--codex') } : {}) });
  try { console.log(JSON.stringify(await repairThread({ client, id: option('--thread'), home, outputRoot: path.join(ROOT, '.runtime', 'thread-recovery'), apply: args.includes('--apply'), verifyId: option('--verify') }), null, 2)); }
  finally { await client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
