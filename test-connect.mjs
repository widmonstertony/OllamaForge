import assert from 'node:assert/strict';
import { parseArgs, parseInstalledModels, selectPrimaryModel } from './connect.mjs';

assert.deepEqual(parseArgs([]), { model: null, disconnect: false });
assert.deepEqual(parseArgs(['--model', 'qwen3.5:9b']), { model: 'qwen3.5:9b', disconnect: false });
assert.deepEqual(parseArgs(['--disconnect']), { model: null, disconnect: true });
assert.throws(() => parseArgs(['--disconnect', '--model=x']), /cannot be combined/);

const installed = parseInstalledModels(
  'NAME ID SIZE MODIFIED\nqwen3.5:9b abc 6 GB now\nqwen3.8-codex-iq4-xs-110k:latest def 13 GB now\nfoo:cloud ghi - now\n',
);
assert.deepEqual(installed, ['qwen3.5:9b', 'qwen3.8-codex-iq4-xs-110k:latest']);
assert.equal(selectPrimaryModel(installed, null, 'qwen3.5:9b'), 'qwen3.5:9b');
assert.equal(selectPrimaryModel(installed, null, 'gpt-cloud'), 'qwen3.8-codex-iq4-xs-110k');
assert.equal(selectPrimaryModel(installed, 'QWEN3.5:9B', null), 'qwen3.5:9b');
assert.throws(() => selectPrimaryModel(installed, 'missing:7b', null), /not installed/);

console.log('PASS: connect-only argument parsing, installed-model discovery, and primary selection.');
