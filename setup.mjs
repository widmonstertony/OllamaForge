#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWrite,
  backupFiles,
  captureFiles,
  decodedTopString,
  mergeHybridConfiguration,
  parseOllamaList,
  readJson,
  restoreFiles,
} from './ollama-chatgpt-hybrid.mjs';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export const MODEL_SPECS = Object.freeze({
  '9b': Object.freeze({
    choice: '9b',
    alias: 'qwen3.5-codex-fast-16k',
    base: 'qwen3.5:9b',
    modelfile: 'Modelfile.codex-qwen-fast-16k',
    minimumFreeGiB: 9,
  }),
  '27b': Object.freeze({
    choice: '27b',
    alias: 'qwen3.8-codex-16k',
    base: 'qwen3.8:27b',
    modelfile: 'Modelfile.codex-qwen-16k',
    minimumFreeGiB: 24,
  }),
  '27b-iq4-xs': Object.freeze({
    choice: '27b-iq4-xs',
    alias: 'qwen3.8-codex-iq4-xs-110k',
    localFile: path.join('models', 'Qwen3.8-27B-IQ4_XS-3.84bpw.gguf'),
    modelfile: 'Modelfile.qwen38-iq4-110k',
  }),
});

export function parseArgs(args) {
  const options = { model: '9b', noPull: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--no-pull') options.noPull = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--model') options.model = args[++index];
    else if (argument.startsWith('--model=')) options.model = argument.slice('--model='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!MODEL_SPECS[options.model]) throw new Error('--model must be 9b, 27b, or 27b-iq4-xs.');
  return options;
}

function defaultFindOnPath(command, platform) {
  const lookup = spawnSync(platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8' });
  if (lookup.status !== 0) return null;
  return lookup.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export function windowsOllamaFallback(environment) {
  if (!environment.LOCALAPPDATA) return null;
  return path.win32.join(environment.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
}

export function resolveOllamaExecutable({
  platform = process.platform,
  environment = process.env,
  findOnPath = defaultFindOnPath,
  existsSync = fs.existsSync,
} = {}) {
  const discovered = findOnPath('ollama', platform);
  if (discovered) return discovered;
  if (platform === 'win32') {
    const fallback = windowsOllamaFallback(environment);
    if (fallback && existsSync(fallback)) return fallback;
  }
  throw new Error('Ollama was not found. Install Ollama and ensure the ollama command is on PATH.');
}

function defaultRunCapture(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function defaultRunInherit(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} exited with status ${result.status}.`);
  return result;
}

function defaultAvailableBytes(targetPath) {
  const stats = fs.statfsSync(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

function resolveCatalogPath(configText, configDir, homeDir) {
  const configured = decodedTopString(configText, 'model_catalog_json');
  if (!configured) return path.join(configDir, 'ollama-launch-models.json');
  if (configured === '~') return homeDir;
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(homeDir, configured.slice(2));
  }
  return path.isAbsolute(configured) ? configured : path.resolve(configDir, configured);
}

function jsonIfPresent(filePath, fallback = { models: [] }) {
  return fs.existsSync(filePath) ? readJson(filePath) : fallback;
}

function assertCommandSucceeded(result, description) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${description} failed${details ? `: ${details}` : '.'}`);
  }
}

function modelExists(ollama, model, runCapture) {
  return runCapture(ollama, ['show', model]).status === 0;
}

function enrichLocalCatalog(generatedCatalog, templateCatalog) {
  const templates = new Map((templateCatalog.models ?? []).map((entry) => [entry.slug, entry]));
  return {
    ...generatedCatalog,
    models: (generatedCatalog.models ?? []).map((entry) => {
      const slug = String(entry.slug ?? '').replace(/:latest$/, '');
      const template = templates.get(slug);
      if (template) return { ...entry, ...template, slug };
      if (slug !== entry.slug) {
        const normalized = { ...entry, slug };
        if (entry.display_name === entry.slug) normalized.display_name = slug;
        return normalized;
      }
      return entry;
    }),
  };
}

export function runSetup(options, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (!['darwin', 'win32'].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}. This setup supports macOS and Windows.`);
  }

  const environment = dependencies.environment ?? process.env;
  const homeDir = dependencies.homeDir ?? os.homedir();
  const rootDir = dependencies.rootDir ?? repositoryRoot;
  const runCapture = dependencies.runCapture ?? defaultRunCapture;
  const runInherit = dependencies.runInherit ?? defaultRunInherit;
  const availableBytes = dependencies.availableBytes ?? defaultAvailableBytes;
  const ollama = dependencies.ollamaExecutable ?? resolveOllamaExecutable({ platform, environment });
  const spec = MODEL_SPECS[options.model];

  const capability = runCapture(ollama, ['launch', 'chatgpt', '--help']);
  assertCommandSucceeded(capability, 'Ollama ChatGPT integration check');

  if (spec.localFile) {
    const localFile = path.join(rootDir, spec.localFile);
    if (!fs.existsSync(localFile)) {
      throw new Error(`Local model file not found: ${localFile}`);
    }
  } else if (!modelExists(ollama, spec.base, runCapture)) {
    if (options.noPull) {
      throw new Error(`${spec.base} is not installed and --no-pull was requested.`);
    }
    const freeBytes = availableBytes(homeDir);
    const requiredBytes = spec.minimumFreeGiB * (1024 ** 3);
    if (freeBytes < requiredBytes) {
      throw new Error(
        `Not enough free disk space for ${spec.base}: ${(freeBytes / (1024 ** 3)).toFixed(1)} GiB available; ` +
        `${spec.minimumFreeGiB} GiB required.`,
      );
    }
    runInherit(ollama, ['pull', spec.base]);
  }

  if (spec.localFile || !modelExists(ollama, spec.alias, runCapture)) {
    const modelfile = path.join(rootDir, spec.modelfile);
    if (!fs.existsSync(modelfile)) throw new Error(`Missing model definition: ${modelfile}`);
    runInherit(ollama, ['create', spec.alias, '-f', modelfile]);
  }

  const configDir = environment.CODEX_HOME || path.join(homeDir, '.codex');
  const configPath = path.join(configDir, 'config.toml');
  const catalogPath = path.join(configDir, 'ollama-launch-models.json');
  const routingPath = path.join(configDir, 'ollama-launch-codex-routing.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Codex config not found at ${configPath}. Open ChatGPT/Codex once, then retry.`);
  }

  const previousConfigText = fs.readFileSync(configPath, 'utf8');
  const previousCatalogPath = resolveCatalogPath(previousConfigText, configDir, homeDir);
  const previousCatalog = jsonIfPresent(previousCatalogPath);
  const previousRouting = jsonIfPresent(routingPath);
  const integrationSnapshot = captureFiles([configPath, catalogPath, routingPath]);
  const backupDir = dependencies.backupDir ?? path.join(homeDir, '.ollama', 'backup', 'codex-app');
  const backups = backupFiles(integrationSnapshot, backupDir, 'pre-setup');

  try {
    runInherit(ollama, ['launch', 'chatgpt', '--config', '--model', spec.alias, '--yes']);
    for (const generatedPath of [configPath, catalogPath, routingPath]) {
      if (!fs.existsSync(generatedPath)) {
        throw new Error(`Ollama did not generate the expected integration file: ${generatedPath}`);
      }
    }

    dependencies.afterLaunch?.({ configPath, catalogPath, routingPath });
    const listResult = runCapture(ollama, ['list']);
    assertCommandSucceeded(listResult, 'ollama list');
    const templateCatalog = readJson(path.join(rootDir, 'local-qwen-catalog.json'));
    const generatedCatalog = enrichLocalCatalog(readJson(catalogPath), templateCatalog);
    const result = mergeHybridConfiguration({
      generatedConfigText: fs.readFileSync(configPath, 'utf8'),
      previousConfigText,
      generatedCatalog,
      previousCatalog,
      generatedRouting: readJson(routingPath),
      previousRouting,
      installedModels: parseOllamaList(listResult.stdout),
    });

    atomicWrite(configPath, result.configText);
    atomicWrite(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
    atomicWrite(routingPath, `${JSON.stringify(result.routing, null, 2)}\n`);
    return {
      ...result,
      model: spec,
      paths: { configPath, catalogPath, routingPath, backupDir },
      backups,
    };
  } catch (error) {
    restoreFiles(integrationSnapshot);
    throw new Error(`Setup failed; the pre-launch Codex configuration was restored. ${error.message}`, { cause: error });
  }
}

function printHelp() {
  console.log(`Usage: npm run setup -- --model <9b|27b|27b-iq4-xs> [--no-pull]\n\n` +
    `Downloads only the selected model, configures Ollama for ChatGPT/Codex,\n` +
    `and restores the existing cloud model as the default.`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = runSetup(options);
    console.log(`Ready: ${result.model.alias}`);
    console.log(`Cloud default preserved: ${result.cloudDefault}`);
    console.log(`Selectable local models: ${result.localSlugs.join(', ')}`);
    console.log(`Backups: ${result.paths.backupDir}`);
    console.log('Quit and reopen ChatGPT/Codex to reload the combined model list.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
