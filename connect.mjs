#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, decodedTopString, setTopValue } from './ollama-chatgpt-hybrid.mjs';
import { findCodexApplicationName, installDirectShortcut } from './macos/install-direct-shortcut.mjs';
import { resolveOllamaExecutable } from './setup.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const endpoint = 'http://127.0.0.1:11434/api/codex/v1';
const providerId = 'ollamaforge';
const tunedModels = new Map([
  ['qwen3.8:27b-mlx', { contextWindow: 184_320, defaultReasoning: 'none' }],
  ['qwen3.8-codex-iq4-xs-64k', { contextWindow: 65_536, defaultReasoning: 'none' }],
  ['qwen3.8-codex-iq4-xs-110k', { contextWindow: 110_000, defaultReasoning: 'none' }],
]);

function run(command, args, { stdio = 'inherit', env = process.env } = {}) {
  const result = spawnSync(command, args, { stdio, env, encoding: stdio === 'pipe' ? 'utf8' : undefined });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed${details ? `: ${details}` : ` with status ${result.status}`}.`);
  }
  return result;
}

export function parseArgs(args) {
  const options = { model: null, disconnect: false, launch: false, noShortcut: false, list: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--disconnect') options.disconnect = true;
    else if (argument === '--launch') options.launch = true;
    else if (argument === '--no-shortcut') options.noShortcut = true;
    else if (argument === '--list') options.list = true;
    else if (argument === '--model') options.model = args[++index];
    else if (argument.startsWith('--model=')) options.model = argument.slice('--model='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.disconnect && options.model) throw new Error('--disconnect cannot be combined with --model.');
  if (options.disconnect && options.launch) throw new Error('--disconnect cannot be combined with --launch.');
  if (options.list && (options.disconnect || options.launch || options.model)) {
    throw new Error('--list cannot be combined with --disconnect, --launch, or --model.');
  }
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

export function resolveCodexExecutable({ platform = process.platform, homeDir = os.homedir(), environment = process.env } = {}) {
  const explicit = environment.CODEX_EXECUTABLE?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  const pathMatch = String(environment.PATH ?? '').split(path.delimiter)
    .map((directory) => path.join(directory, executableName))
    .find((candidate) => fs.existsSync(candidate));
  if (pathMatch) return pathMatch;

  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const binDir = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    if (!fs.existsSync(binDir)) return null;
    const candidates = fs.readdirSync(binDir, { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory()
        ? [path.join(binDir, entry.name, 'codex.exe')]
        : entry.name.toLowerCase() === 'codex.exe' ? [path.join(binDir, entry.name)] : [])
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    return candidates[0] ?? null;
  }

  if (platform === 'darwin') {
    return [
      '/Applications/Codex.app/Contents/Resources/codex',
      path.join(homeDir, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    ].find((candidate) => fs.existsSync(candidate)) ?? null;
  }
  return null;
}

/** Refresh Codex's own cloud catalog in an isolated config directory. */
export function refreshCodexCloudCatalog({ codexExecutable, configDir, runCommand = run } = {}) {
  if (!codexExecutable) return null;
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamaforge-codex-'));
  try {
    const authPath = path.join(configDir, 'auth.json');
    if (fs.existsSync(authPath)) fs.copyFileSync(authPath, path.join(temporaryHome, 'auth.json'));
    const result = runCommand(codexExecutable, ['debug', 'models'], {
      stdio: 'pipe',
      env: { ...process.env, CODEX_HOME: temporaryHome },
    });
    const catalog = JSON.parse(result.stdout);
    if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
      throw new Error('Codex returned an empty cloud model catalog.');
    }
    return catalog;
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
}

/** Replace stale cloud entries while retaining only models currently installed in Ollama. */
export function mergeCodexCloudCatalog(configPath, cloudCatalog, installed) {
  if (!cloudCatalog || !Array.isArray(cloudCatalog.models)) return null;
  const config = fs.readFileSync(configPath, 'utf8');
  const catalogPath = decodedTopString(config, 'model_catalog_json');
  if (!catalogPath || !fs.existsSync(catalogPath)) return null;
  const generated = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const installedSlugs = new Set(installed.map((name) => canonical(name).toLowerCase()));
  const localModels = (generated.models ?? [])
    .filter((entry) => installedSlugs.has(canonical(entry?.slug).toLowerCase()))
    .map((entry) => {
      const slug = canonical(entry.slug);
      return {
        ...entry,
        slug,
        display_name: entry.display_name === entry.slug ? slug : entry.display_name,
      };
    });
  const localSlugs = new Set(localModels.map((entry) => canonical(entry.slug).toLowerCase()));
  const cloudModels = cloudCatalog.models.filter((entry) =>
    entry?.slug && !localSlugs.has(canonical(entry.slug).toLowerCase()));
  const merged = { ...cloudCatalog, models: [...cloudModels, ...localModels] };
  fs.writeFileSync(catalogPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { catalogPath, cloudModels: cloudModels.length, localModels: localModels.length };
}

export function selectCloudDefault(catalog, preferred) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const wanted = canonical(preferred).toLowerCase();
  const match = models.find((entry) => canonical(entry?.slug).toLowerCase() === wanted);
  return match?.slug ?? models.find((entry) => entry?.slug && entry.visibility !== 'hide')?.slug ?? null;
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
  const preferred = byCanonical.get('qwen3.8-codex-iq4-xs-64k')
    ?? byCanonical.get('qwen3.8-codex-iq4-xs-110k');
  return preferred ?? byCanonical.values().next().value ?? null;
}

function isCloudCodexModel(name, installed) {
  const normalized = canonical(name);
  if (!normalized || normalized.endsWith(':cloud')) return false;
  const local = new Set(installed.map((model) => canonical(model).toLowerCase()));
  return !local.has(normalized.toLowerCase()) && /^(gpt-|codex-|chatgpt-|o\d)/i.test(normalized);
}

/** Find the user's cloud default without ever promoting a newly added local model. */
export function findCloudDefault(configPath, installed, backupDir) {
  const config = fs.readFileSync(configPath, 'utf8');
  const current = decodedTopString(config, 'model');
  if (isCloudCodexModel(current, installed)) return current;

  if (backupDir && fs.existsSync(backupDir)) {
    const backups = fs.readdirSync(backupDir)
      .filter((name) => name.startsWith('config.toml.'))
      .map((name) => path.join(backupDir, name))
      .filter((filePath) => fs.statSync(filePath).isFile())
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    for (const backupPath of backups) {
      const model = decodedTopString(fs.readFileSync(backupPath, 'utf8'), 'model');
      if (isCloudCodexModel(model, installed)) return model;
    }
  }

  const catalogPath = decodedTopString(config, 'model_catalog_json');
  if (catalogPath && fs.existsSync(catalogPath)) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const entry = (catalog.models ?? []).find((model) => isCloudCodexModel(model?.slug, installed));
    if (entry) return entry.slug;
  }
  return null;
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

export function preserveSelectedModel(configPath, selectedModel, requestedModel = null) {
  if (requestedModel || !selectedModel) return false;
  const config = fs.readFileSync(configPath, 'utf8');
  const catalogPath = decodedTopString(config, 'model_catalog_json');
  if (!catalogPath || !fs.existsSync(catalogPath)) return false;
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const selected = canonical(selectedModel).toLowerCase();
  const selectable = (catalog.models ?? []).some((entry) => canonical(entry.slug).toLowerCase() === selected);
  if (!selectable) return false;
  if (canonical(decodedTopString(config, 'model')).toLowerCase() === selected) return true;
  atomicWrite(configPath, setTopValue(config, 'model', JSON.stringify(selectedModel)));
  return true;
}

function removeTopValue(text, key) {
  return text.replace(new RegExp(`^${key}\\s*=.*(?:\\r?\\n|$)`, 'm'), '');
}

function removeProviderTable(text, id) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const result = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const header = line.trim();
    if (header === `[model_providers.${id}]` || header.startsWith(`[model_providers.${id}.`)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[/.test(line)) skipping = false;
    if (!skipping) result.push(line);
  }
  return result.join(newline).trimEnd();
}

/**
 * Use a named HTTP-only provider instead of overriding the built-in OpenAI provider.
 * Ollama's Codex gateway supports streaming Responses over HTTP, but not the Responses
 * WebSocket transport that some cloud models prefer. Explicitly disabling websocket
 * support prevents Codex desktop from getting stuck in a reconnect loop.
 */
export function configureHttpProvider(configPath) {
  let text = fs.readFileSync(configPath, 'utf8');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  text = removeTopValue(text, 'openai_base_url');
  text = setTopValue(text, 'model_provider', JSON.stringify(providerId));
  text = removeProviderTable(text, providerId);
  text += `${newline}${newline}[model_providers.${providerId}]${newline}`;
  text += `name = "OllamaForge HTTP bridge"${newline}`;
  text += `base_url = ${JSON.stringify(endpoint)}${newline}`;
  text += `wire_api = "responses"${newline}`;
  text += `requires_openai_auth = true${newline}`;
  text += `supports_websockets = false${newline}`;
  text += `request_max_retries = 1${newline}`;
  text += `stream_max_retries = 1${newline}`;
  atomicWrite(configPath, text);
  return providerId;
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

export function connect({ model = null, disconnect = false, launch = false, noShortcut = false, list = false, dependencies = {} } = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}. Codex desktop connection supports Windows and macOS.`);
  }
  const homeDir = dependencies.homeDir ?? os.homedir();
  const ollama = dependencies.ollamaExecutable ?? resolveOllamaExecutable({ platform });
  const runCommand = dependencies.runCommand ?? run;

  if (list) {
    const result = runCommand(ollama, ['list'], { stdio: 'pipe' });
    return { listed: true, installed: parseInstalledModels(result.stdout) };
  }

  const configPath = path.join(process.env.CODEX_HOME || path.join(homeDir, '.codex'), 'config.toml');
  if (!fs.existsSync(configPath)) throw new Error(`Codex config not found: ${configPath}. Open Codex once, then retry.`);

  if (disconnect) {
    runCommand(ollama, ['launch', 'chatgpt', '--restore']);
    return { disconnected: true };
  }

  const listResult = runCommand(ollama, ['list'], { stdio: 'pipe' });
  const installed = parseInstalledModels(listResult.stdout);
  const current = decodedTopString(fs.readFileSync(configPath, 'utf8'), 'model');
  const backupDir = dependencies.backupDir ?? path.join(homeDir, '.ollama', 'backup', 'codex-app');
  let cloudDefault = findCloudDefault(configPath, installed, backupDir);
  let cloudCatalog = null;
  let catalogRefreshWarning = null;
  try {
    const refresh = dependencies.refreshCloudCatalog;
    cloudCatalog = refresh
      ? refresh()
      : refreshCodexCloudCatalog({
          codexExecutable: dependencies.codexExecutable ?? resolveCodexExecutable({ platform, homeDir }),
          configDir: path.dirname(configPath),
          runCommand,
        });
    if (cloudCatalog) cloudDefault = selectCloudDefault(cloudCatalog, cloudDefault);
  } catch (error) {
    catalogRefreshWarning = error.message;
  }
  const primary = selectPrimaryModel(installed, model, current);
  if (!primary) {
    throw new Error('No local Ollama model is installed. Install one explicitly with Ollama, then rerun npm run setup. OllamaForge setup never downloads a model.');
  }
  const launchArgs = ['launch', 'chatgpt', '--config', '--model', primary, '--yes'];
  runCommand(ollama, launchArgs);
  const configured = fs.readFileSync(configPath, 'utf8');
  if (decodedTopString(configured, 'openai_base_url') !== endpoint) {
    throw new Error(`Ollama did not configure the expected Codex endpoint: ${endpoint}`);
  }
  const mergedCatalog = mergeCodexCloudCatalog(configPath, cloudCatalog, installed);
  configureHttpProvider(configPath);
  const tunedCatalogModels = tuneCodexCatalog(configPath);
  cloudDefault ??= findCloudDefault(configPath, installed, backupDir);
  const selectedModelPreserved = preserveSelectedModel(configPath, cloudDefault);
  const shortcut = noShortcut ? null : (dependencies.installShortcut?.() ?? installShortcut(platform));
  if (launch) (dependencies.restartCodex ?? restartCodex)(platform, dependencies);
  return {
    disconnected: false,
    primary,
    defaultModel: cloudDefault ?? primary,
    installed,
    endpoint,
    shortcut,
    launched: launch,
    tunedCatalogModels,
    selectedModelPreserved,
    mergedCatalog,
    catalogRefreshWarning,
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = connect(options);
    if (result.listed) {
      if (result.installed.length === 0) console.log('No local Ollama models are installed.');
      else {
        console.log('Installed local Ollama models:');
        for (const model of result.installed) console.log(`- ${model}`);
      }
    } else if (result.disconnected) {
      console.log('Ollama models were disconnected from Codex. Restart Codex to reload its native configuration.');
    } else {
      console.log('\nCodex connection ready.');
      console.log(`Endpoint: ${result.endpoint}`);
      console.log(`Default Codex model: ${result.defaultModel}`);
      console.log(`Ollama catalog seed: ${result.primary}`);
      console.log(`Shared local models: ${result.installed.join(', ')}`);
      if (result.mergedCatalog) {
        console.log(`Fresh Codex cloud models: ${result.mergedCatalog.cloudModels}`);
      }
      if (result.catalogRefreshWarning) {
        console.warn(`Cloud model refresh warning: ${result.catalogRefreshWarning}`);
      }
      console.log('No model was downloaded. Choose a local or cloud model per task in the Codex model picker.');
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
