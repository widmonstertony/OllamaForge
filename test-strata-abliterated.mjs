import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTargetFile } from './deploy.mjs';
import { prepareShards, shards } from './strata-abliterated.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'SC117 用户 data '));
try {
  const requests = [];
  await prepareShards(directory, async spec => requests.push(spec));
  assert.equal(requests.length, 2);
  for (const [i, { target, targetPath }] of requests.entries()) {
    assert.equal(targetPath, path.join(directory, shards[i].name));
    assert.match(target.url, /\/resolve\/90a3350cd800ec1fe0d1660a38414ad9e985782f\/IQ3_S\//);
    assert.match(target.sha256, /^[0-9a-f]{64}$/);
  }
  const bytes = Buffer.from('SC117 download fixture');
  const file = requests[0].targetPath;
  const spec = {
    target: { ...requests[0].target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    targetPath: file, curl: 'fixture-curl', availableBytes: () => 10 * 1024 ** 3,
  };
  fs.writeFileSync(file + '.partial', bytes.subarray(0, 5));
  await ensureTargetFile({ ...spec, runCommand: (_, args) => {
    assert.equal(args.at(-1), spec.target.url);
    assert.ok(args.includes('--continue-at'));
    fs.appendFileSync(file + '.partial', bytes.subarray(5));
  } });
  const offline = { ...spec, curl: null };
  await ensureTargetFile(offline);
  fs.renameSync(file, file + '.partial');
  await ensureTargetFile(offline);
  assert.deepEqual(fs.readFileSync(file), bytes);
  fs.unlinkSync(file);
  await assert.rejects(ensureTargetFile({ ...spec, runCommand: () => fs.writeFileSync(file + '.partial', Buffer.alloc(bytes.length)) }), /verification/);
  assert.ok(!fs.existsSync(file));
  fs.writeFileSync(path.join(directory, 'stock.gguf'), '');
  await assert.rejects(prepareShards(directory, () => assert.fail('mixed weights must fail before downloading')), /only the two/);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('PASS: pinned SC117 shards, custom paths, resumable transfer, SHA-256 rejection and offline reuse.');
