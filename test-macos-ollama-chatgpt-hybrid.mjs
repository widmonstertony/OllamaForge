import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enableHybridMode, mergeHybridConfiguration, parseOllamaList } from './macos/ollama-chatgpt-hybrid.mjs';

const cloudConfig = 'model = "gemma4:31b:cloud"\nmodel_reasoning_effort = "high"\nmodel_catalog_json = "/tmp/catalog.json"\nopenai_base_url = "http://127.0.0.1:11434/api/codex/v1"\n\n[features]\napps = true\n';
const localConfig = cloudConfig.replace('gemma4:31b:cloud', 'qwen3.5-codex-fast-16k');
const cloudCatalog = { models: [
  { slug: 'gemma4:31b:cloud', visibility: 'list' },
  { slug: 'gpt-cloud', visibility: 'list' },
] };
const currentCatalog = { models: [
  { slug: 'qwen3.5-codex-fast-16k', visibility: 'list', include_apps_usage_instructions: true },
  { slug: 'qwen3.5:9b', visibility: 'list', include_apps_usage_instructions: true },
  { slug: 'not-installed:7b', visibility: 'list' },
] };
const cloudRouting = { models: [{ slug: 'gemma4:31b:cloud' }], auto_review_model: 'selected', auto_review_fallback_model: 'gemma4:31b:cloud' };
const currentRouting = { models: [
  { slug: 'qwen3.5-codex-fast-16k', thinking: { supported: true } },
  { slug: 'qwen3.5:9b', thinking: { supported: true } },
] };

const parsed = parseOllamaList('NAME ID SIZE MODIFIED\nqwen3.5-codex-fast-16k:latest abc 6 GB now\nqwen3.5:9b def 6 GB now\n');
assert.deepEqual([...parsed], ['qwen3.5-codex-fast-16k', 'qwen3.5:9b']);

const merged = mergeHybridConfiguration({
  currentConfigText: localConfig,
  cloudConfigText: cloudConfig,
  currentCatalog,
  cloudCatalog,
  currentRouting,
  cloudRouting,
  installedModels: parsed,
});
assert.match(merged.configText, /^model = "gemma4:31b:cloud"/m);
assert.match(merged.configText, /\[features\]\napps = true/);
assert.deepEqual(merged.catalog.models.map((entry) => entry.slug), [
  'gemma4:31b:cloud',
  'qwen3.5-codex-fast-16k',
  'qwen3.5:9b',
  'gpt-cloud',
]);
assert.deepEqual(merged.routing.models.map((entry) => entry.slug), [
  'gemma4:31b:cloud',
  'qwen3.5-codex-fast-16k',
  'qwen3.5:9b',
]);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-chatgpt-hybrid-'));
try {
  const configDir = path.join(work, '.codex');
  const backupDir = path.join(work, '.ollama', 'backup', 'codex-app');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.toml'), localConfig);
  fs.writeFileSync(path.join(configDir, 'ollama-launch-models.json'), JSON.stringify(currentCatalog));
  fs.writeFileSync(path.join(configDir, 'ollama-launch-codex-routing.json'), JSON.stringify(currentRouting));
  fs.writeFileSync(path.join(backupDir, 'config.toml.123'), cloudConfig);
  fs.writeFileSync(path.join(backupDir, 'ollama-launch-models.json.123'), JSON.stringify(cloudCatalog));
  fs.writeFileSync(path.join(backupDir, 'ollama-launch-codex-routing.json.123'), JSON.stringify(cloudRouting));

  const result = enableHybridMode({
    configDir,
    backupDir,
    ollamaListOutput: 'NAME ID SIZE MODIFIED\nqwen3.5-codex-fast-16k:latest abc 6 GB now\nqwen3.5:9b def 6 GB now\n',
  });
  assert.equal(result.cloudDefault, 'gemma4:31b:cloud');
  assert.match(fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8'), /^model = "gemma4:31b:cloud"/m);
  assert.equal(fs.statSync(path.join(configDir, 'config.toml')).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(backupDir).filter((name) => name.includes('pre-hybrid')).length, 3);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log('PASS: Ollama ChatGPT cloud and installed local models are merged safely.');
