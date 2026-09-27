import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, parseArgs, parseInstalledModels, preserveSelectedModel, selectPrimaryModel, tuneCodexCatalog } from './connect.mjs';
import { decodedTopString } from './ollama-chatgpt-hybrid.mjs';

const packageJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
assert.equal(packageJson.scripts.setup, 'node connect.mjs');
assert.equal(packageJson.scripts.connect, 'node connect.mjs');
assert.equal(packageJson.scripts.models, 'node connect.mjs --list');
assert.equal(packageJson.scripts.refresh, 'node connect.mjs');
assert.equal(packageJson.scripts['download:27b'], 'node deploy.mjs');
assert.ok(!packageJson.scripts.setup.includes('deploy.mjs'));
assert.ok(!packageJson.scripts.setup.includes('setup.mjs'));
const documentedScripts = [...readme.matchAll(/npm run ([a-z0-9:_-]+)/gi)].map((match) => match[1]);
assert.deepEqual(
  [...new Set(documentedScripts)].filter((name) => !packageJson.scripts[name]),
  [],
  'Every npm command in README.md must exist in package.json.',
);

assert.deepEqual(parseArgs([]), { model: null, disconnect: false, launch: false, noShortcut: false, list: false });
assert.deepEqual(parseArgs(['--model', 'qwen3.5:9b']), { model: 'qwen3.5:9b', disconnect: false, launch: false, noShortcut: false, list: false });
assert.deepEqual(parseArgs(['--disconnect']), { model: null, disconnect: true, launch: false, noShortcut: false, list: false });
assert.deepEqual(parseArgs(['--launch', '--no-shortcut']), { model: null, disconnect: false, launch: true, noShortcut: true, list: false });
assert.deepEqual(parseArgs(['--list']), { model: null, disconnect: false, launch: false, noShortcut: false, list: true });
assert.throws(() => parseArgs(['--disconnect', '--model=x']), /cannot be combined/);
assert.throws(() => parseArgs(['--list', '--model=x']), /cannot be combined/);

const installed = parseInstalledModels(
  'NAME ID SIZE MODIFIED\nqwen3.5:9b abc 6 GB now\nqwen3.8-codex-iq4-xs-64k:latest def 13 GB now\nqwen3.8-codex-iq4-xs-110k:latest ghi 13 GB now\nfoo:cloud jkl - now\n',
);
assert.deepEqual(installed, ['qwen3.5:9b', 'qwen3.8-codex-iq4-xs-64k:latest', 'qwen3.8-codex-iq4-xs-110k:latest']);
assert.equal(selectPrimaryModel(installed, null, 'qwen3.5:9b'), 'qwen3.5:9b');
assert.equal(selectPrimaryModel(installed, null, 'gpt-cloud'), 'qwen3.8-codex-iq4-xs-64k');
assert.equal(selectPrimaryModel(installed, 'QWEN3.5:9B', null), 'qwen3.5:9b');
assert.equal(selectPrimaryModel([], null, 'gpt-cloud'), null);
assert.throws(() => selectPrimaryModel(installed, 'missing:7b', null), /not installed/);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamaforge-connect-'));
try {
  const configDir = path.join(work, '.codex');
  const configPath = path.join(configDir, 'config.toml');
  const catalogPath = path.join(configDir, 'models.json');
  fs.mkdirSync(configDir, { recursive: true });
  const calls = [];
  const runCommand = (_command, args) => {
    calls.push(args);
    if (args[0] === 'list') return { status: 0, stdout: 'NAME ID SIZE MODIFIED\nqwen3.5:9b abc 6 GB now\n' };
    if (args[0] === 'launch') {
      fs.writeFileSync(configPath, `model = "qwen3.5:9b"\nopenai_base_url = "http://127.0.0.1:11434/api/codex/v1"\nmodel_catalog_json = "${catalogPath.replaceAll('\\', '\\\\')}"\n`);
      fs.writeFileSync(catalogPath, JSON.stringify({ models: [
        { slug: 'gpt-cloud' },
        { slug: 'qwen3.5:9b' },
      ] }));
      return { status: 0 };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  fs.writeFileSync(configPath, 'model = "gpt-cloud"\n');
  const listed = connect({ list: true, dependencies: {
    platform: 'win32', homeDir: work, ollamaExecutable: 'ollama', runCommand,
  } });
  assert.deepEqual(listed.installed, ['qwen3.5:9b']);
  assert.ok(!calls.some((args) => args[0] === 'launch'));
  calls.length = 0;

  connect({ dependencies: {
    platform: 'win32', homeDir: work, ollamaExecutable: 'ollama', runCommand, installShortcut: () => 'shortcut',
  } });
  assert.ok(calls.at(-1).includes('--config'));
  assert.equal(decodedTopString(fs.readFileSync(configPath, 'utf8'), 'model'), 'gpt-cloud');

  assert.equal(preserveSelectedModel(configPath, 'missing-model'), false);

  fs.writeFileSync(configPath, 'model = "gpt-cloud"\n');
  calls.length = 0;
  let restartPlatform = null;
  const launched = connect({ launch: true, noShortcut: true, dependencies: {
    platform: 'win32', homeDir: work, ollamaExecutable: 'ollama', runCommand, installShortcut: () => 'unused',
    restartCodex: (platform) => { restartPlatform = platform; },
  } });
  assert.equal(launched.launched, true);
  assert.ok(calls.at(-1).includes('--config'));
  assert.equal(restartPlatform, 'win32');
  assert.equal(launched.shortcut, null);
  assert.equal(decodedTopString(fs.readFileSync(configPath, 'utf8'), 'model'), 'gpt-cloud');

  fs.writeFileSync(catalogPath, JSON.stringify({ models: [
    { slug: 'qwen3.8:27b-mlx', context_window: 128000, max_context_window: 128000, default_reasoning_level: 'high' },
    { slug: 'qwen3.8-codex-iq4-xs-64k', context_window: 262144, max_context_window: 262144, default_reasoning_level: 'high' },
    { slug: 'qwen3.8-codex-iq4-xs-110k', context_window: 262144, max_context_window: 262144, default_reasoning_level: 'high' },
  ] }));
  assert.equal(tuneCodexCatalog(configPath), 3);
  const tuned = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models;
  assert.equal(tuned[0].context_window, 184320);
  assert.equal(tuned[0].max_context_window, 184320);
  assert.equal(tuned[0].default_reasoning_level, 'none');
  assert.equal(tuned[1].context_window, 65536);
  assert.equal(tuned[1].max_context_window, 65536);
  assert.equal(tuned[2].context_window, 110000);
  assert.equal(tuned[2].max_context_window, 110000);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log('PASS: download-free package contract, connect arguments, installed-model discovery, and primary selection.');
