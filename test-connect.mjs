import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, parseArgs, parseInstalledModels, selectPrimaryModel, tuneCodexCatalog } from './connect.mjs';

assert.deepEqual(parseArgs([]), { model: null, disconnect: false, launch: false, noShortcut: false });
assert.deepEqual(parseArgs(['--model', 'qwen3.5:9b']), { model: 'qwen3.5:9b', disconnect: false, launch: false, noShortcut: false });
assert.deepEqual(parseArgs(['--disconnect']), { model: null, disconnect: true, launch: false, noShortcut: false });
assert.deepEqual(parseArgs(['--launch', '--no-shortcut']), { model: null, disconnect: false, launch: true, noShortcut: true });
assert.throws(() => parseArgs(['--disconnect', '--model=x']), /cannot be combined/);

const installed = parseInstalledModels(
  'NAME ID SIZE MODIFIED\nqwen3.5:9b abc 6 GB now\nqwen3.8-codex-iq4-xs-110k:latest def 13 GB now\nfoo:cloud ghi - now\n',
);
assert.deepEqual(installed, ['qwen3.5:9b', 'qwen3.8-codex-iq4-xs-110k:latest']);
assert.equal(selectPrimaryModel(installed, null, 'qwen3.5:9b'), 'qwen3.5:9b');
assert.equal(selectPrimaryModel(installed, null, 'gpt-cloud'), 'qwen3.8-codex-iq4-xs-110k');
assert.equal(selectPrimaryModel(installed, 'QWEN3.5:9B', null), 'qwen3.5:9b');
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
      return { status: 0 };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  fs.writeFileSync(configPath, 'model = "gpt-cloud"\n');
  connect({ dependencies: {
    platform: 'win32', homeDir: work, ollamaExecutable: 'ollama', runCommand, installShortcut: () => 'shortcut',
  } });
  assert.ok(calls.at(-1).includes('--config'));

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

  fs.writeFileSync(catalogPath, JSON.stringify({ models: [{
    slug: 'qwen3.8-codex-iq4-xs-110k', context_window: 262144,
    max_context_window: 262144, effective_context_window_percent: 95,
    default_reasoning_level: 'high',
  }] }));
  assert.equal(tuneCodexCatalog(configPath), 1);
  const tuned = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models[0];
  assert.equal(tuned.context_window, 110000);
  assert.equal(tuned.max_context_window, 110000);
  assert.equal(tuned.default_reasoning_level, 'none');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log('PASS: connect-only argument parsing, installed-model discovery, and primary selection.');
