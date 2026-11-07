#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, decodedTopString } from '../ollama-chatgpt-hybrid.mjs';
import { findCodexApplicationName } from './install-direct-shortcut.mjs';

export function restoreNativeCodex(configPath) {
  const before = fs.readFileSync(configPath, 'utf8');
  const dir = path.dirname(configPath);
  const url = decodedTopString(before, 'openai_base_url');
  const provider = decodedTopString(before, 'model_provider');
  const catalog = decodedTopString(before, 'model_catalog_json');
  const remove = new Set();
  if (['http://127.0.0.1:11434/api/codex/v1', 'http://127.0.0.1:11437'].includes(url)) {
    remove.add('openai_base_url');
  }
  if (['local_qwen', 'ollamaforge'].includes(provider)) remove.add('model_provider');
  if (['ollama-launch-models.json', 'local-qwen-catalog.json', 'local-qwen-metal-catalog.json']
    .some(name => catalog === path.join(dir, name))) remove.add('model_catalog_json');

  const model = decodedTopString(before, 'model');
  if (remove.size && /^(?:qwen|gemma|llama|deepseek)|:cloud$/i.test(model ?? '')) {
    for (const key of ['model', 'model_reasoning_effort', 'model_context_window', 'model_auto_compact_token_limit']) {
      remove.add(key);
    }
  }
  const firstTable = before.search(/^\s*\[/m);
  const boundary = firstTable < 0 ? before.length : firstTable;
  const top = before.slice(0, boundary);
  const cleanTop = top.replace(/^[ \t]*([\w-]+)[ \t]*=[^\r\n]*(?:\r?\n|$)/gm,
    (line, key) => remove.has(key) ? '' : line);
  if (cleanTop === top) return { changed: false };

  const backup = path.join(dir, 'tmp', `config.pre-native-cloud-${Date.now()}-${process.pid}.toml`);
  atomicWrite(backup, before);
  if (fs.readFileSync(configPath, 'utf8') !== before) throw new Error('Codex settings changed. Retry.');
  atomicWrite(configPath, cleanTop + before.slice(boundary));
  return { changed: true, backup };
}

export function localCodexLaunch({ homeDir, environment, backend, endpoint, model, contextWindow }) {
  const localHome = path.join(homeDir, 'Library', 'Application Support', 'OllamaForge', `codex-${backend}`);
  fs.mkdirSync(localHome, { recursive: true, mode: 0o700 });
  const provider = 'ollamaforge_local';
  const args = [
    '--model', model,
    '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', `model_providers.${provider}={name="OllamaForge Local",base_url=${JSON.stringify(endpoint)},wire_api="responses",request_max_retries=0,stream_max_retries=0}`,
    '-c', 'model_reasoning_effort="none"',
  ];
  if (contextWindow) args.push('-c', `model_context_window=${contextWindow}`);
  return { args, env: { ...environment, CODEX_HOME: localHome } };
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const result = restoreNativeCodex(config);
  if (result.changed) {
    console.log(`已恢复 Codex 原生连接。备份：${result.backup}`);
    console.log('请在运行中的任务结束后退出并重开 Codex，以刷新已打开的会话。');
  }
  if (process.argv.includes('--open')) {
    execFileSync('/usr/bin/open', ['-a', findCodexApplicationName()], { stdio: 'inherit' });
  }
}
