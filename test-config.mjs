import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'local-codex-config-'));
const config = path.join(work, 'config.toml');
const snapshot = path.join(work, 'cloud.json');
const catalog = path.join(work, 'catalog.json');
const source = path.join(root, 'local-qwen-catalog.json');
const helper = path.join(root, 'codex-mode-config.mjs');
const original = 'model = "gpt-cloud"\nmodel_reasoning_effort = "high"\n\n[features]\nplugins = true\n\n[model_providers.other]\nbase_url = "https://example.test/v1"\n';
fs.writeFileSync(config, original);

function run(action, model) {
  const result = spawnSync(process.execPath,
    [helper, action, config, snapshot, source, catalog, ...(model ? [model] : [])],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

try {
  run('snapshot');
  run('local', 'qwen3.5-codex-fast-16k');
  let text = fs.readFileSync(config, 'utf8');
  assert.match(text, /^model = "qwen3\.5-codex-fast-16k"/m);
  assert.doesNotMatch(text, /x-codex-local-preset/);
  assert.match(text, /\[model_providers\.local_qwen\]/);
  const models = JSON.parse(fs.readFileSync(catalog, 'utf8')).models;
  assert.deepEqual(models.map((model) => model.slug).sort(),
    ['qwen3.5-codex-fast-16k', 'qwen3.8-codex-16k']);

  run('local', 'qwen3.8-codex-16k');
  text = fs.readFileSync(config, 'utf8');
  assert.match(text, /^model = "qwen3\.8-codex-16k"/m);
  assert.doesNotMatch(text, /x-codex-local-preset/);

  run('cloud');
  text = fs.readFileSync(config, 'utf8');
  assert.match(text, /^model = "gpt-cloud"/m);
  assert.doesNotMatch(text, /\[model_providers\.local_qwen\]/);
  assert.match(text, /\[model_providers\.other\]/);
  console.log('PASS: both local models appear in catalog; no forced model header; cloud settings restore.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
