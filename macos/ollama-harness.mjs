#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { connectHarness, launchHarness, ROOT, RUNTIME, resolveProjectWorkspace } from '../deepseek-harness.mjs';
import { atomicWrite } from '../ollama-chatgpt-hybrid.mjs';

const baseModel = 'qwen3.8:27b';
const models = [
  { model: 'qwen3.8-codex-128k:latest', context: 131072 },
  { model: 'qwen3.8-codex-64k:latest', context: 65536 },
];

async function localJSON(route, body) {
  const response = await fetch('http://127.0.0.1:11434' + route, {
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('Ollama ' + route + ' returned HTTP ' + response.status + '.');
  return response.json();
}

async function ensureOllama() {
  try { await localJSON('/api/version'); return; } catch {}
  execFileSync('/usr/bin/open', ['-a', 'Ollama']);
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try { await localJSON('/api/version'); return; } catch {}
  }
  throw new Error('Ollama did not start. Open Ollama and retry.');
}

async function ensureModels() {
  const installed = new Set((await localJSON('/api/tags')).models?.map(model => model.name));
  const ollama = ['/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']
    .find(file => fs.existsSync(file));
  if (!ollama) throw new Error('Ollama executable was not found.');
  const source = installed.has('qwen3.8-codex-16k:latest') ? 'qwen3.8-codex-16k:latest' : baseModel;
  for (const entry of models) {
    if (installed.has(entry.model)) {
      const info = await localJSON('/api/show', { model: entry.model });
      const context = info.parameters?.match(/^num_ctx\s+(\d+)$/m)?.[1];
      if (Number(context) !== entry.context) throw new Error(entry.model + ' has a different num_ctx; inspect it before replacing the model.');
      continue;
    }
    if (!installed.has(source)) throw new Error('Install or import ' + baseModel + ' first. Existing local weights are required.');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamaforge-harness-model-'));
    try {
      const modelfile = path.join(temp, 'Modelfile');
      fs.writeFileSync(modelfile, 'FROM ' + source + '\nPARAMETER num_ctx ' + entry.context + '\n');
      execFileSync(ollama, ['create', entry.model, '-f', modelfile], {
        stdio: 'inherit', env: { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:11434' },
      });
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
}

function installShortcut(workspace) {
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const directory = path.join(os.homedir(), 'Desktop');
  const target = path.join(directory, 'DeepSeek Harness（Qwen 3.8 27B）.command');
  const script = '#!/bin/zsh\nset -e\ncd ' + quote(ROOT) + '\nexec ' + quote(process.execPath) +
    ' ' + quote(fileURLToPath(import.meta.url)) + ' launch --workspace ' + quote(workspace) + ' "$@"\n';
  fs.mkdirSync(directory, { recursive: true });
  const temp = target + '.tmp-' + process.pid;
  fs.writeFileSync(temp, script, { mode: 0o755 });
  fs.renameSync(temp, target);
  return target;
}

function migrateLocalToolMasks() {
  const files = ['web', 'headless'].map(profile => path.join(RUNTIME, 'home', 'profiles', profile, 'cordis.patch.yml'))
    .filter(file => fs.existsSync(file));
  if (!files.length) return;
  const yaml = createRequire(path.join(RUNTIME, 'package.json'))('js-yaml');
  class JsExpression { constructor(code) { this.code = code; } }
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: code => new JsExpression(code), instanceOf: JsExpression, represent: value => value.code,
  })]);
  const legacy = new Set(['harness-tools.mjs', 'harness-control-tools.mjs']
    .map(name => pathToFileURL(path.join(ROOT, '.runtime', 'ollama-27b', name)).href));
  for (const file of files) {
    const before = fs.readFileSync(file, 'utf8');
    const rows = yaml.load(before, { schema }) ?? [];
    let changed = false;
    const migrated = rows.map(row => {
      if (!row.insert?.some(plugin => plugin.id === 'ollamaforge-qwen27b-tools' && legacy.has(plugin.name))) return row;
      changed = true;
      return { ...row, insert: row.insert.filter(plugin => plugin.id !== 'ollamaforge-qwen27b-tools' || !legacy.has(plugin.name)) };
    }).filter(row => !(Object.keys(row).length === 1 && row.insert?.length === 0));
    if (!changed) continue;
    atomicWrite(file + '.pre-repository-controls', before);
    atomicWrite(file, yaml.dump(migrated, { schema, noRefs: true, lineWidth: -1 }));
  }
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This deployment targets Apple Silicon macOS.');
  const command = process.argv[2] ?? 'setup';
  if (!['setup', 'launch'].includes(command)) throw new Error('Use setup or launch, optionally --workspace <directory> and --no-open.');
  let workspace = ROOT;
  let noOpen = false;
  for (let index = 3; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--no-open') noOpen = true;
    else if (argument === '--workspace' && process.argv[index + 1]) workspace = process.argv[++index];
    else throw new Error('Unknown option: ' + argument);
  }
  workspace = resolveProjectWorkspace(workspace);
  await ensureOllama();
  await ensureModels();
  migrateLocalToolMasks();
  const options = {
    command: 'launch', port: 3080, workspace, noOpen,
    'base-url': 'http://127.0.0.1:11434/v1', api: 'openai-responses',
    model: models[0].model, context: models[0].context,
    'extra-model': models[1].model, 'extra-context': models[1].context,
    'tool-profile': 'local-controls',
  };
  await connectHarness(options);
  if (command === 'setup') console.log('Desktop shortcut: ' + installShortcut(workspace));
  await launchHarness(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
