#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableHybridMode } from '../ollama-chatgpt-hybrid.mjs';

export * from '../ollama-chatgpt-hybrid.mjs';

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const result = enableHybridMode();
  console.log(`Cloud default restored: ${result.cloudDefault}`);
  console.log(`Local Ollama models added: ${result.localSlugs.join(', ')}`);
  console.log(`Pre-launch backup used: ${result.cloudBackupSuffix}`);
  console.log('Quit and reopen the ChatGPT/Codex desktop app to reload the combined model catalog.');
}
