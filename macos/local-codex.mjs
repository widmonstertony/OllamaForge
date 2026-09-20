#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('This launcher is for macOS. On Windows use Switch-Codex-Mode.ps1.');
}
if (typeof zlib.zstdDecompressSync !== 'function') {
  throw new Error('This Node.js version lacks zstd support. Install a recent Node.js release.');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(root, 'codex-mode-config.mjs');
const configDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const config = path.join(configDir, 'config.toml');
const stateDir = path.join(os.homedir(), 'Library', 'Application Support', 'LocalCodexAgent');
const snapshot = path.join(stateDir, 'cloud-settings.json');
const catalog = path.join(configDir, 'local-qwen-catalog.json');
const sourceCatalog = path.join(root, 'local-qwen-catalog.json');
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.localcodex.ollama-adapter.plist');
const label = 'com.localcodex.ollama-adapter';
const domain = `gui/${process.getuid()}`;
const models = [
  { choice: '9b', alias: 'qwen3.5-codex-fast-16k', base: 'qwen3.5:9b', file: 'Modelfile.codex-qwen-fast-16k', minimumFreeGiB: 9 },
  { choice: '27b', alias: 'qwen3.8-codex-16k', base: 'qwen3.8:27b', file: 'Modelfile.codex-qwen-16k', minimumFreeGiB: 24 },
];

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}
function existsInOllama(model) {
  return spawnSync('ollama', ['show', model], { stdio: 'ignore' }).status === 0;
}
function availableBytes(targetPath) {
  const stats = fs.statfsSync(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}
function formatGiB(bytes) {
  return (bytes / (1024 ** 3)).toFixed(1);
}
function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function installLaunchAgent() {
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  // LaunchAgents can be blocked by macOS privacy controls when their program
  // loads scripts directly from Documents/Desktop. Install a self-contained
  // runtime under Application Support before bootstrapping the agent.
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const runner = path.join(stateDir, 'run-codex-ollama-adapter.mjs');
  const adapter = path.join(stateDir, 'codex-ollama-adapter.mjs');
  fs.copyFileSync(path.join(root, 'run-codex-ollama-adapter.mjs'), runner);
  fs.copyFileSync(path.join(root, 'codex-ollama-adapter.mjs'), adapter);
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${label}</string>\n` +
    `<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(runner)}</string></array>\n` +
    `<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n` +
    `<key>ThrottleInterval</key><integer>5</integer>\n</dict></plist>\n`;
  spawnSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' });
  fs.writeFileSync(plist, content, 'utf8');
  run('launchctl', ['bootstrap', domain, plist]);
}
async function health() {
  try {
    const response = await fetch('http://127.0.0.1:11435/health', { signal: AbortSignal.timeout(2500) });
    return response.ok && (await response.json()).status === 'ok';
  } catch {
    return false;
  }
}
function configAction(action, ...args) {
  run(process.execPath, [helper, action, config, snapshot, ...args]);
}

const command = process.argv[2] || 'status';
if (!['local', 'cloud', 'status'].includes(command)) {
  throw new Error('Usage: node macos/local-codex.mjs <local|cloud|status> [9b|27b]');
}
if (!fs.existsSync(config)) {
  throw new Error(`Codex config not found at ${config}. Install and open ChatGPT/Codex once first.`);
}

if (command === 'local') {
  const choice = process.argv[3] || '9b';
  if (!['9b', '27b'].includes(choice)) throw new Error('Model default must be 9b or 27b.');
  const selectedModel = models.find((model) => model.choice === choice);
  if (!existsInOllama(selectedModel.alias)) {
    if (!existsInOllama(selectedModel.base)) {
      const freeBytes = availableBytes(os.homedir());
      const requiredBytes = selectedModel.minimumFreeGiB * (1024 ** 3);
      if (freeBytes < requiredBytes) {
        throw new Error(`Not enough free disk space for ${selectedModel.base}: ${formatGiB(freeBytes)} GiB available, at least ${selectedModel.minimumFreeGiB} GiB required.`);
      }
      throw new Error(`Missing ${selectedModel.base}. First run: ollama pull ${selectedModel.base}`);
    }
    run('ollama', ['create', selectedModel.alias, '-f', path.join(root, selectedModel.file)]);
  }
  fs.mkdirSync(stateDir, { recursive: true });
  configAction('snapshot');
  installLaunchAgent();
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await health()) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Local adapter did not become healthy on 127.0.0.1:11435.');
  const defaultModel = selectedModel.alias;
  configAction('local', sourceCatalog, catalog, defaultModel, selectedModel.alias);
  console.log(`Local mode is ready. Available local model: ${defaultModel}.`);
  console.log('Quit and reopen the ChatGPT/Codex desktop app to load the local catalog.');
} else if (command === 'cloud') {
  configAction('cloud');
  console.log('Cloud settings restored. Quit and reopen the desktop app to reload the model catalog.');
} else {
  configAction('status');
  console.log(`Adapter health: ${(await health()) ? 'ok' : 'offline'}`);
}
