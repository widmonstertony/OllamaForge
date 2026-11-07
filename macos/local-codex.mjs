#!/usr/bin/env node
import { connect } from '../connect.mjs';

const command = process.argv[2] ?? 'status';
if (process.platform !== 'darwin') throw new Error('This launcher is for macOS.');
if (command === 'local') {
  const model = { '9b': 'qwen3.5-codex-fast-16k', '27b': 'qwen3.8-codex-16k' }[process.argv[3] ?? '9b'];
  if (!model) throw new Error('Model choice must be 9b or 27b.');
  connect({ model, launch: true, noShortcut: true });
} else if (command === 'cloud') {
  const result = connect({ disconnect: true });
  if (result.changed) console.log('Native Codex restored. Reopen after active tasks finish.');
} else if (command === 'status') {
  console.log(connect({ list: true }).installed.join('\n'));
} else {
  throw new Error('Usage: node macos/local-codex.mjs <local|cloud|status> [9b|27b]');
}
