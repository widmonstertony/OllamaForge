#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function canonicalModelName(name) {
  return String(name ?? '').replace(/:latest$/, '');
}

function topValue(text, key) {
  const top = text.split(/(?=^\[)/m, 1)[0];
  const match = top.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

function decodedTopString(text, key) {
  const raw = topValue(text, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setTopValue(text, key, rawValue) {
  const expression = new RegExp(`^${key}\\s*=.*$`, 'm');
  if (expression.test(text)) return text.replace(expression, `${key} = ${rawValue}`);
  const firstTable = text.search(/^\[/m);
  if (firstTable < 0) return `${key} = ${rawValue}\n${text}`;
  return `${text.slice(0, firstTable)}${key} = ${rawValue}\n${text.slice(firstTable)}`;
}

function uniqueBySlug(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry || typeof entry.slug !== 'string' || seen.has(entry.slug)) return false;
    seen.add(entry.slug);
    return true;
  });
}

export function parseOllamaList(output) {
  return new Set(String(output)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => canonicalModelName(line.trim().split(/\s+/)[0]))
    .filter(Boolean));
}

export function mergeHybridConfiguration({
  currentConfigText,
  cloudConfigText,
  currentCatalog,
  cloudCatalog,
  currentRouting,
  cloudRouting,
  installedModels,
}) {
  const cloudDefault = decodedTopString(cloudConfigText, 'model');
  if (!cloudDefault || !cloudDefault.includes(':cloud')) {
    throw new Error('The selected Ollama backup does not contain a cloud default model.');
  }
  if (!cloudCatalog.models?.some((entry) => entry.slug === cloudDefault)) {
    throw new Error(`Cloud catalog does not contain its default model: ${cloudDefault}`);
  }

  const installed = new Set([...installedModels].map(canonicalModelName));
  const localEntries = (currentCatalog.models ?? []).filter((entry) =>
    installed.has(canonicalModelName(entry.slug)));
  if (localEntries.length === 0) {
    throw new Error('No installed local Ollama models were found in the current ChatGPT catalog.');
  }

  const cloudEntries = cloudCatalog.models ?? [];
  const firstOpenAIModel = cloudEntries.findIndex((entry) =>
    typeof entry.slug === 'string' && !entry.slug.includes(':cloud'));
  const insertAt = firstOpenAIModel < 0 ? cloudEntries.length : firstOpenAIModel;
  const models = uniqueBySlug([
    ...cloudEntries.slice(0, insertAt),
    ...localEntries,
    ...cloudEntries.slice(insertAt),
  ]);

  const localSlugs = new Set(localEntries.map((entry) => entry.slug));
  const localRoutes = (currentRouting.models ?? []).filter((entry) => localSlugs.has(entry.slug));
  const routes = uniqueBySlug([...(cloudRouting.models ?? []), ...localRoutes]);
  for (const slug of localSlugs) {
    if (!routes.some((entry) => entry.slug === slug)) {
      throw new Error(`Ollama routing metadata is missing for local model: ${slug}`);
    }
  }

  let configText = currentConfigText;
  configText = setTopValue(configText, 'model', JSON.stringify(cloudDefault));
  const cloudEffort = topValue(cloudConfigText, 'model_reasoning_effort');
  if (cloudEffort !== null) {
    configText = setTopValue(configText, 'model_reasoning_effort', cloudEffort);
  }

  return {
    configText,
    catalog: { ...cloudCatalog, models },
    routing: {
      ...cloudRouting,
      models: routes,
      auto_review_model: cloudRouting.auto_review_model ?? 'selected',
      auto_review_fallback_model: cloudRouting.auto_review_fallback_model ?? cloudDefault,
    },
    cloudDefault,
    localSlugs: [...localSlugs],
  };
}

function newestCloudBackup(backupDir) {
  const prefix = 'ollama-launch-models.json.';
  const candidates = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((suffix) =>
      fs.existsSync(path.join(backupDir, `config.toml.${suffix}`)) &&
      fs.existsSync(path.join(backupDir, `ollama-launch-codex-routing.json.${suffix}`)))
    .sort((a, b) => Number(b) - Number(a));

  for (const suffix of candidates) {
    const configPath = path.join(backupDir, `config.toml.${suffix}`);
    const catalogPath = path.join(backupDir, `ollama-launch-models.json.${suffix}`);
    const configText = fs.readFileSync(configPath, 'utf8');
    const defaultModel = decodedTopString(configText, 'model');
    const catalog = readJson(catalogPath);
    if (defaultModel?.includes(':cloud') && catalog.models?.some((entry) => entry.slug === defaultModel)) {
      return {
        suffix,
        configPath,
        catalogPath,
        routingPath: path.join(backupDir, `ollama-launch-codex-routing.json.${suffix}`),
      };
    }
  }
  throw new Error(`No complete Ollama cloud backup was found in ${backupDir}`);
}

function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.hybrid-${process.pid}`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
}

export function enableHybridMode({
  configDir = path.join(os.homedir(), '.codex'),
  backupDir = path.join(os.homedir(), '.ollama', 'backup', 'codex-app'),
  ollamaListOutput,
} = {}) {
  const configPath = path.join(configDir, 'config.toml');
  const catalogPath = path.join(configDir, 'ollama-launch-models.json');
  const routingPath = path.join(configDir, 'ollama-launch-codex-routing.json');
  for (const requiredPath of [configPath, catalogPath, routingPath]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Missing Ollama ChatGPT integration file: ${requiredPath}`);
  }

  const currentConfigText = fs.readFileSync(configPath, 'utf8');
  if (decodedTopString(currentConfigText, 'openai_base_url') !== 'http://127.0.0.1:11434/api/codex/v1') {
    throw new Error('ChatGPT is not currently routed through the local Ollama Codex gateway.');
  }
  const cloudBackup = newestCloudBackup(backupDir);
  const installedModels = parseOllamaList(ollamaListOutput ??
    execFileSync('ollama', ['list'], { encoding: 'utf8' }));
  const result = mergeHybridConfiguration({
    currentConfigText,
    cloudConfigText: fs.readFileSync(cloudBackup.configPath, 'utf8'),
    currentCatalog: readJson(catalogPath),
    cloudCatalog: readJson(cloudBackup.catalogPath),
    currentRouting: readJson(routingPath),
    cloudRouting: readJson(cloudBackup.routingPath),
    installedModels,
  });

  const stamp = Math.floor(Date.now() / 1000);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(configPath, path.join(backupDir, `config.toml.pre-hybrid-${stamp}`));
  fs.copyFileSync(catalogPath, path.join(backupDir, `ollama-launch-models.json.pre-hybrid-${stamp}`));
  fs.copyFileSync(routingPath, path.join(backupDir, `ollama-launch-codex-routing.json.pre-hybrid-${stamp}`));

  atomicWrite(configPath, result.configText);
  atomicWrite(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
  atomicWrite(routingPath, `${JSON.stringify(result.routing, null, 2)}\n`);
  return { ...result, cloudBackupSuffix: cloudBackup.suffix };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const result = enableHybridMode();
  console.log(`Cloud default restored: ${result.cloudDefault}`);
  console.log(`Local Ollama models added: ${result.localSlugs.join(', ')}`);
  console.log(`Cloud backup used: ${result.cloudBackupSuffix}`);
  console.log('Quit and reopen the ChatGPT/Codex desktop app to reload the combined model catalog.');
}
