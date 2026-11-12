import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureHttpProvider, connect, findCloudDefault, mergeCodexCloudCatalog, parseArgs, parseInstalledModels, preserveSelectedModel, selectCloudDefault, selectPrimaryModel, tuneCodexCatalog } from './connect.mjs';
import { decodedTopString } from './ollama-chatgpt-hybrid.mjs';

const packageJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const readmes = [
  fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('./README.zh-CN.md', import.meta.url), 'utf8'),
];
assert.match(readmes[0], /\[简体中文\]\(README\.zh-CN\.md\)/);
assert.match(readmes[1], /\[English\]\(README\.md\)/);
assert.equal(packageJson.scripts.setup, 'node connect.mjs');
assert.equal(packageJson.scripts.connect, 'node connect.mjs');
assert.equal(packageJson.scripts.models, 'node connect.mjs --list');
assert.equal(packageJson.scripts.refresh, 'node connect.mjs');
assert.equal(packageJson.scripts['download:27b'], 'node deploy.mjs');
assert.ok(!packageJson.scripts.setup.includes('deploy.mjs'));
assert.ok(!packageJson.scripts.setup.includes('setup.mjs'));
const documentedScriptSets = readmes.map((readme) =>
  [...new Set([...readme.matchAll(/npm run ([a-z0-9:_-]+)/gi)].map((match) => match[1]))].sort());
assert.deepEqual(documentedScriptSets[0], documentedScriptSets[1], 'Both README languages must document the same npm commands.');
const documentedScripts = documentedScriptSets.flat();
assert.deepEqual(
  [...new Set(documentedScripts)].filter((name) => !packageJson.scripts[name]),
  [],
  'Every npm command in both README languages must exist in package.json.',
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
  const configDir = path.join(work, 'Custom Codex Home'); fs.mkdirSync(configDir);
  const configPath = path.join(configDir, 'config.toml');
  const original = 'model = "gpt-cloud-future"\nmodel_provider = "openai"\n[plugins.personal]\nenabled = true\n';
  fs.writeFileSync(configPath, original);
  const calls = []; let opened = 0;
  const dependencies = { platform: 'win32', homeDir: work, environment: { CODEX_HOME: configDir }, ollamaExecutable: 'ollama',
    runCommand: (_command, args) => { calls.push(args); assert.deepEqual(args, ['list']); return { stdout: 'NAME ID SIZE MODIFIED\nqwen3.5:9b abc 6 GB now\n', status: 0 }; },
    refreshCloudCatalog: () => { throw new Error('Native cloud catalog must not be fetched or copied by local setup'); },
    installShortcut: () => 'native shortcut', openCodex: () => { opened++; } };
  const result = connect({ dependencies });
  assert.equal(result.nativeConfigurationUnchanged, true); assert.equal(result.defaultModel, 'gpt-cloud-future');
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  const profile = fs.readFileSync(result.profilePath, 'utf8');
  assert.match(profile, /model_provider = "ollamaforge"/); assert.match(profile, /requires_openai_auth = false/);
  const localModels = JSON.parse(fs.readFileSync(result.localCatalogPath, 'utf8')).models;
  assert.deepEqual(localModels.map(m => m.slug), ['qwen3.5:9b']);
  assert(!localModels.some(m => m.slug.startsWith('gpt')));
  connect({ launch: true, noShortcut: true, dependencies }); assert.equal(opened, 1);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  const listed = connect({ list: true, dependencies }); assert.deepEqual(listed.installed, ['qwen3.5:9b']);
  connect({ disconnect: true, dependencies });
  assert.equal(fs.readFileSync(configPath, 'utf8'), original); assert(!fs.existsSync(result.profilePath));
  assert(calls.every(args => args[0] === 'list'));
} finally {
  assert.equal(path.dirname(work), os.tmpdir()); assert(path.basename(work).startsWith('ollamaforge-connect-'));
  fs.rmSync(work, { recursive: true, force: true });
}
console.log('PASS: local setup/launch/disconnect preserve native providers, all future cloud models and plugin settings; local catalog is isolated.');
