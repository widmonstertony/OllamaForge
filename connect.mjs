#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodedTopString } from './ollama-chatgpt-hybrid.mjs';
import { findCodexApplicationName, installDirectShortcut } from './macos/install-direct-shortcut.mjs';
import { resolveOllamaExecutable } from './setup.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const endpoint = 'http://127.0.0.1:11434/api/codex/v1';
const tunedModels = new Map([
  ['qwen3.8-codex-iq4-xs-110k', { contextWindow: 110_000, defaultReasoning: 'none' }],
]);

function run(command, args, { stdio = 'inherit' } = {}) {
  const result = spawnSync(command, args, { stdio, encoding: stdio === 'pipe' ? 'utf8' : undefined });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed${details ? `: ${details}` : ` with status ${result.status}`}.`);
  }
  return result;
}

export function parseArgs(args) {
  const options = { model: null, disconnect: false, launch: false, noShortcut: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--disconnect') options.disconnect = true;
    else if (argument === '--launch') options.launch = true;
    else if (argument === '--no-shortcut') options.noShortcut = true;
    else if (argument === '--model') options.model = args[++index];
    else if (argument.startsWith('--model=')) options.model = argument.slice('--model='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.disconnect && options.model) throw new Error('--disconnect cannot be combined with --model.');
  if (options.disconnect && options.launch) throw new Error('--disconnect cannot be combined with --launch.');
  if (args.includes('--model') && !options.model) throw new Error('--model requires a model name.');
  return options;
}

export function parseInstalledModels(output) {
  return String(output).split(/\r?\n/).slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && !name.endsWith(':cloud'));
}

function canonical(name) {
  return String(name ?? '').replace(/:latest$/, '');
}

export function selectPrimaryModel(installed, requested, current) {
  const byCanonical = new Map(installed.map((name) => [canonical(name).toLowerCase(), canonical(name)]));
  if (requested) {
    const match = byCanonical.get(canonical(requested).toLowerCase());
    if (!match) throw new Error(`Requested model is not installed in Ollama: ${requested}`);
    return match;
  }
  const currentMatch = byCanonical.get(canonical(current).toLowerCase());
  if (currentMatch) return currentMatch;
  const preferred = byCanonical.get('qwen3.8-codex-iq4-xs-110k');
  return preferred ?? byCanonical.values().next().value ?? null;
}

export function tuneCodexCatalog(configPath) {
  const config = fs.readFileSync(configPath, 'utf8');
  const catalogPath = decodedTopString(config, 'model_catalog_json');
  if (!catalogPath || !fs.existsSync(catalogPath)) return 0;
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  let tuned = 0;
  for (const model of Array.isArray(catalog.models) ? catalog.models : []) {
    const settings = tunedModels.get(canonical(model.slug));
    if (!settings) continue;
    model.context_window = settings.contextWindow;
    model.max_context_window = settings.contextWindow;
    model.effective_context_window_percent = 95;
    model.default_reasoning_level = settings.defaultReasoning;
    tuned++;
  }
  if (tuned > 0) fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  return tuned;
}

function installShortcut(platform = process.platform) {
  if (platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(rootDir, 'Install-WindowsShortcuts.ps1')]);
    return '本地 Codex（GUI）';
  }
  if (platform === 'darwin') return installDirectShortcut();
  throw new Error(`Unsupported platform: ${platform}. Codex desktop connection supports Windows and macOS.`);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function restartCodex(platform = process.platform, dependencies = {}) {
  const runCommand = dependencies.runCommand ?? run;
  if (platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    runCommand(powershell, [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(rootDir, 'Launch-Codex-Connected.ps1'), '-SkipConnect',
    ]);
    return;
  }
  if (platform === 'darwin') {
    const applicationName = dependencies.applicationName ?? findCodexApplicationName();
    runCommand('/usr/bin/osascript', ['-e', `tell application "${applicationName}" to quit`]);
    const isRunning = () => {
      const result = spawnSync('/usr/bin/pgrep', ['-x', applicationName], { stdio: 'ignore' });
      return result.status === 0;
    };
    const deadline = Date.now() + 15_000;
    while (isRunning() && Date.now() < deadline) sleep(250);
    if (isRunning()) throw new Error(`${applicationName} did not close within 15 seconds.`);
    runCommand('/usr/bin/open', ['-a', applicationName]);
    return;
  }
  throw new Error(`Unsupported platform: ${platform}.`);
}

export function connect({ model = null, disconnect = false, launch = false, noShortcut = false, dependencies = {} } = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}. Codex desktop connection supports Windows and macOS.`);
  }
  const homeDir = dependencies.homeDir ?? os.homedir();
  const configPath = path.join(process.env.CODEX_HOME || path.join(homeDir, '.codex'), 'config.toml');
  if (!fs.existsSync(configPath)) throw new Error(`Codex config not found: ${configPath}. Open Codex once, then retry.`);
  const ollama = dependencies.ollamaExecutable ?? resolveOllamaExecutable({ platform });
  const runCommand = dependencies.runCommand ?? run;

  if (disconnect) {
    runCommand(ollama, ['launch', 'chatgpt', '--restore']);
    return { disconnected: true };
  }

  const list = runCommand(ollama, ['list'], { stdio: 'pipe' });
  const installed = parseInstalledModels(list.stdout);
  const current = decodedTopString(fs.readFileSync(configPath, 'utf8'), 'model');
  const primary = selectPrimaryModel(installed, model, current);
  if (!primary) {
    throw new Error('No local Ollama model is installed. Pull/import a model first, or run npm run deploy:27b.');
  }
  const launchArgs = ['launch', 'chatgpt', '--config', '--model', primary, '--yes'];
  runCommand(ollama, launchArgs);
  const configured = fs.readFileSync(configPath, 'utf8');
  if (decodedTopString(configured, 'openai_base_url') !== endpoint) {
    throw new Error(`Ollama did not configure the expected Codex endpoint: ${endpoint}`);
  }
  const tunedCatalogModels = tuneCodexCatalog(configPath);
  const shortcut = noShortcut ? null : (dependencies.installShortcut?.() ?? installShortcut(platform));
  if (launch) (dependencies.restartCodex ?? restartCodex)(platform, dependencies);
  return { disconnected: false, primary, installed, endpoint, shortcut, launched: launch, tunedCatalogModels };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = connect(options);
    if (result.disconnected) {
      console.log('Ollama models were disconnected from Codex. Restart Codex to reload its native configuration.');
    } else {
      console.log('\nCodex connection ready.');
      console.log(`Endpoint: ${result.endpoint}`);
      console.log(`Default local model: ${result.primary}`);
      console.log(`Shared local models: ${result.installed.join(', ')}`);
      if (result.shortcut) console.log(`Desktop shortcut: ${result.shortcut}`);
      console.log(result.launched
        ? 'Codex was refreshed and opened with the shared cloud and local model catalog.'
        : 'Use the desktop shortcut to refresh and open Codex with the shared model catalog.');
    }
  } catch (error) {
    console.error(`Connection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
