#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { restoreNativeCodex } from './native-codex.mjs';

export * from '../ollama-chatgpt-hybrid.mjs';

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const result = restoreNativeCodex(config);
  if (result.changed) console.log(`Native cloud configuration restored. Backup: ${result.backup}`);
  console.log('Use the isolated Ollama shortcut for local Codex. Reopen desktop Codex after active tasks finish if it still has the old route loaded.');
}
