import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeRepairText, repairNative } from './native-model-isolation.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-codex-'));
try {
  const file = path.join(root, 'config.toml');
  const catalog = path.join(root, 'ollama-launch-models.json');
  const original = `model = "gpt-future"\r\nmodel_provider = "openai"\r\nmodel_catalog_json = ${JSON.stringify(catalog)}\r\n[plugins.keep]\r\nenabled = true\r\n[model_providers.ollamaforge]\r\nbase_url = "http://127.0.0.1:11436/api/codex/v1"\r\n`;
  fs.writeFileSync(file, original); fs.writeFileSync(catalog, '{"models":["local-existing"]}');
  const result = repairNative(file, path.join(root, 'backup'));
  assert.deepEqual(result.removed, ['model_catalog_json']);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
  const repaired = fs.readFileSync(file, 'utf8');
  assert.equal(repaired, original.replace(/^model_catalog_json.*\r\n/m, ''));
  assert.equal(fs.readFileSync(catalog, 'utf8'), '{"models":["local-existing"]}');
  assert.equal(repairNative(file, path.join(root, 'backup')).changed, false);
  const custom = 'model_provider = "company"\nmodel_catalog_json = "/company/live.json"\nopenai_base_url = "https://company.example/v1"\n';
  assert.equal(nativeRepairText(custom, file).text, custom);
  const legacy = 'model = "gpt-cloud"\nmodel_provider = "ollamaforge"\n';
  assert.match(nativeRepairText(legacy, file).text, /model_provider = "openai"/);
  assert.throws(() => nativeRepairText('model = "qwen-local"\nmodel_provider = "ollamaforge"\n', file), /original native cloud model/);
  for (const name of ['Launch-Codex-Connected.ps1', 'Switch-Codex-Mode.ps1']) {
    const source = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
    assert(!/Stop-Process|taskkill|codex-mode-config|auth\.json/.test(source), `${name} must not stop cloud chats or rewrite shared model state`);
  }
  console.log('PASS: only owned native overrides removed; native future models, other providers, local weights/catalog and active chats protected.');
} finally { assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('native-codex-')); fs.rmSync(root, { recursive: true }); }
