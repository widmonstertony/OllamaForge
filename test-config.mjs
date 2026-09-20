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
const original = 'model = "gpt-cloud"\nmodel_reasoning_effort = "high"\n\n[features]\nplugins = true\napps = true\nbrowser_use = true\nimage_generation = false\nmulti_agent = true\n\n[mcp_servers.node_repl]\nenabled = true\n\n[model_providers.other]\nbase_url = "https://example.test/v1"\n';
fs.writeFileSync(config, original);

function run(action, model, selectedModels = []) {
  const result = spawnSync(process.execPath,
    [helper, action, config, snapshot, source, catalog, ...(model ? [model, ...selectedModels] : [])],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

try {
  run('snapshot');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600);
  }
  run('local', 'qwen3.5-codex-fast-16k', ['qwen3.5-codex-fast-16k']);
  let text = fs.readFileSync(config, 'utf8');
  assert.match(text, /^model = "qwen3\.5-codex-fast-16k"/m);
  assert.doesNotMatch(text, /x-codex-local-preset/);
  assert.match(text, /\[model_providers\.local_qwen\]/);
  const models = JSON.parse(fs.readFileSync(catalog, 'utf8')).models;
  assert.deepEqual(models.map((model) => model.slug), ['qwen3.5-codex-fast-16k']);
  assert.equal(models[0].include_apps_usage_instructions, true);
  assert.equal(models[0].include_plugin_usage_instructions, true);
  assert.equal(models[0].include_skills_usage_instructions, true);
  assert.match(text, /plugins = true/);
  assert.match(text, /apps = true/);
  assert.match(text, /browser_use = true/);
  assert.match(text, /image_generation = false/);
  assert.match(text, /multi_agent = true/);
  assert.match(text, /\[mcp_servers\.node_repl\]\nenabled = true/);

  run('local', 'qwen3.8-codex-16k', ['qwen3.8-codex-16k']);
  text = fs.readFileSync(config, 'utf8');
  assert.match(text, /^model = "qwen3\.8-codex-16k"/m);
  assert.doesNotMatch(text, /x-codex-local-preset/);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalog, 'utf8')).models.map((model) => model.slug),
    ['qwen3.8-codex-16k']);

  run('cloud');
  text = fs.readFileSync(config, 'utf8');
  assert.equal(text, original);
  assert.match(text, /^model = "gpt-cloud"/m);
  assert.doesNotMatch(text, /\[model_providers\.local_qwen\]/);
  assert.match(text, /\[model_providers\.other\]/);
  assert.match(text, /plugins = true/);
  assert.match(text, /apps = true/);
  assert.match(text, /browser_use = true/);
  assert.match(text, /\[mcp_servers\.node_repl\]\nenabled = true/);

  const minimalOriginal = 'model = "gpt-cloud"\n\n[model_providers.other]\nbase_url = "https://example.test/v1"\n';
  fs.writeFileSync(config, minimalOriginal);
  fs.rmSync(snapshot, { force: true });
  run('snapshot');
  run('local', 'qwen3.5-codex-fast-16k', ['qwen3.5-codex-fast-16k']);
  text = fs.readFileSync(config, 'utf8');
  assert.doesNotMatch(text, /\[features\]/);
  assert.doesNotMatch(text, /\[mcp_servers\.node_repl\]/);
  run('cloud');
  text = fs.readFileSync(config, 'utf8');
  assert.equal(text, minimalOriginal);
  assert.doesNotMatch(text, /\[features\]/);
  assert.doesNotMatch(text, /\[mcp_servers\.node_repl\]/);
  console.log('PASS: selected-only catalog, tool instructions, feature preservation, and byte-exact cloud restore.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
