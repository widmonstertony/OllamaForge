#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function canonicalModelName(name) {
  return String(name ?? '').replace(/:latest$/, '');
}

export function topValue(text, key) {
  const top = String(text).split(/(?=^\[)/m, 1)[0];
  const match = top.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

export function decodedTopString(text, key) {
  const raw = topValue(text, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setTopValue(text, key, rawValue) {
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

function normalizeSlugEntry(entry) {
  if (!entry || typeof entry.slug !== 'string') return entry;
  const slug = canonicalModelName(entry.slug);
  if (slug === entry.slug) return entry;
  const normalized = { ...entry, slug };
  if (entry.display_name === entry.slug) normalized.display_name = slug;
  return normalized;
}

export function parseOllamaList(output) {
  return new Set(String(output)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => canonicalModelName(line.trim().split(/\s+/)[0]))
    .filter(Boolean));
}

/** Combine Ollama-generated local entries with the user's pre-launch cloud catalog. */
export function mergeHybridConfiguration(options) {
  const generatedConfigText = options.generatedConfigText ?? options.currentConfigText;
  const previousConfigText = options.previousConfigText ?? options.cloudConfigText;
  const generatedCatalog = options.generatedCatalog ?? options.currentCatalog;
  const previousCatalog = options.previousCatalog ?? options.cloudCatalog ?? { models: [] };
  const generatedRouting = options.generatedRouting ?? options.currentRouting;
  const previousRouting = options.previousRouting ?? options.cloudRouting ?? { models: [] };
  const installedModels = options.installedModels ?? new Set();

  if (!generatedConfigText || !previousConfigText || !generatedCatalog || !generatedRouting) {
    throw new Error('Hybrid merge requires previous and Ollama-generated integration data.');
  }

  const previousDefault = decodedTopString(previousConfigText, 'model');
  if (!previousDefault) throw new Error('The pre-launch Codex config does not define a default model.');

  const installed = new Set([...installedModels].map(canonicalModelName));
  const isInstalled = (entry) => installed.has(canonicalModelName(entry?.slug));
  const previousEntries = previousCatalog.models ?? [];
  const generatedEntries = generatedCatalog.models ?? [];
  const previousRouted = new Set((previousRouting.models ?? []).map((entry) => entry.slug));
  const generatedRouted = new Set((generatedRouting.models ?? []).map((entry) => entry.slug));
  const previousSlugs = new Set(previousEntries.map((entry) => entry.slug));
  const isMissingLocal = (entry, routed) =>
    routed.has(entry?.slug) && !isInstalled(entry) && !String(entry?.slug).includes(':cloud');
  const isCloudOrOpenAI = (entry) => {
    const slug = String(entry?.slug ?? '');
    return previousSlugs.has(slug) || slug === previousDefault || slug.includes(':cloud') ||
      /^(gpt-|codex-|chatgpt-|o\d)/i.test(slug);
  };
  const localEntries = uniqueBySlug([
    ...generatedEntries.filter(isInstalled).map(normalizeSlugEntry),
    ...previousEntries.filter(isInstalled).map(normalizeSlugEntry),
  ]);
  if (localEntries.length === 0) {
    throw new Error('No installed local Ollama models were found in the generated ChatGPT catalog.');
  }

  const nonLocalEntries = uniqueBySlug([
    ...previousEntries.filter((entry) => !isInstalled(entry) && !isMissingLocal(entry, previousRouted)),
    ...generatedEntries.filter((entry) =>
      !isInstalled(entry) && !isMissingLocal(entry, generatedRouted) && isCloudOrOpenAI(entry)),
  ]);
  const firstOpenAIModel = nonLocalEntries.findIndex((entry) =>
    typeof entry.slug === 'string' && !entry.slug.includes(':cloud'));
  const insertAt = firstOpenAIModel < 0 ? nonLocalEntries.length : firstOpenAIModel;
  const models = uniqueBySlug([
    ...nonLocalEntries.slice(0, insertAt),
    ...localEntries,
    ...nonLocalEntries.slice(insertAt),
  ]);
  if (!models.some((entry) => entry.slug === previousDefault)) {
    throw new Error(`The merged model catalog does not contain the pre-launch default: ${previousDefault}`);
  }

  const localSlugs = new Set(localEntries.map((entry) => entry.slug));
  const routes = uniqueBySlug([
    ...(previousRouting.models ?? []),
    ...(generatedRouting.models ?? []),
  ].map(normalizeSlugEntry)).filter((entry) =>
    installed.has(canonicalModelName(entry.slug)) || entry.slug.includes(':cloud') || entry.slug === previousDefault);
  for (const slug of localSlugs) {
    if (!routes.some((entry) => entry.slug === slug)) {
      throw new Error(`Ollama routing metadata is missing for local model: ${slug}`);
    }
  }

  let configText = generatedConfigText;
  configText = setTopValue(configText, 'model', JSON.stringify(previousDefault));
  const previousEffort = topValue(previousConfigText, 'model_reasoning_effort');
  if (previousEffort !== null) {
    configText = setTopValue(configText, 'model_reasoning_effort', previousEffort);
  }

  return {
    configText,
    catalog: { ...generatedCatalog, ...previousCatalog, models },
    routing: {
      ...generatedRouting,
      ...previousRouting,
      models: routes,
      auto_review_model: previousRouting.auto_review_model ?? generatedRouting.auto_review_model ?? 'selected',
      auto_review_fallback_model:
        previousRouting.auto_review_fallback_model ?? generatedRouting.auto_review_fallback_model ?? previousDefault,
    },
    cloudDefault: previousDefault,
    localSlugs: [...localSlugs],
  };
}

export function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.hybrid-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
}

export function captureFiles(filePaths) {
  return filePaths.map((filePath) => {
    if (!fs.existsSync(filePath)) return { filePath, exists: false };
    const stat = fs.statSync(filePath);
    return { filePath, exists: true, content: fs.readFileSync(filePath), mode: stat.mode & 0o777 };
  });
}

export function restoreFiles(snapshot) {
  for (const entry of snapshot) {
    if (!entry.exists) {
      fs.rmSync(entry.filePath, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(entry.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${entry.filePath}.restore-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, entry.content, { mode: entry.mode });
    fs.renameSync(temporaryPath, entry.filePath);
    if (process.platform !== 'win32') fs.chmodSync(entry.filePath, entry.mode);
  }
}

export function backupFiles(snapshot, backupDir, label = 'pre-setup') {
  const stamp = `${Math.floor(Date.now() / 1000)}-${process.pid}`;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const written = [];
  for (const entry of snapshot.filter((item) => item.exists)) {
    const backupPath = path.join(backupDir, `${path.basename(entry.filePath)}.${label}-${stamp}`);
    fs.writeFileSync(backupPath, entry.content, { mode: 0o600 });
    written.push(backupPath);
  }
  return written;
}

function newestPreviousBackup(backupDir) {
  const prefix = 'ollama-launch-models.json.';
  const candidates = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((suffix) =>
      fs.existsSync(path.join(backupDir, `config.toml.${suffix}`)) &&
      fs.existsSync(path.join(backupDir, `ollama-launch-codex-routing.json.${suffix}`)))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  for (const suffix of candidates) {
    const configPath = path.join(backupDir, `config.toml.${suffix}`);
    const catalogPath = path.join(backupDir, `ollama-launch-models.json.${suffix}`);
    const configText = fs.readFileSync(configPath, 'utf8');
    const defaultModel = decodedTopString(configText, 'model');
    const catalog = readJson(catalogPath);
    if (defaultModel && catalog.models?.some((entry) => entry.slug === defaultModel)) {
      return {
        suffix,
        configPath,
        catalogPath,
        routingPath: path.join(backupDir, `ollama-launch-codex-routing.json.${suffix}`),
      };
    }
  }
  throw new Error(`No complete pre-launch Codex backup was found in ${backupDir}`);
}

/** Compatibility entry point used by the existing macOS repair shortcut. */
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

  const generatedConfigText = fs.readFileSync(configPath, 'utf8');
  if (decodedTopString(generatedConfigText, 'openai_base_url') !== 'http://127.0.0.1:11434/api/codex/v1') {
    throw new Error('ChatGPT is not currently routed through the local Ollama Codex gateway.');
  }
  const previousBackup = newestPreviousBackup(backupDir);
  const installedModels = parseOllamaList(ollamaListOutput ??
    execFileSync('ollama', ['list'], { encoding: 'utf8' }));
  const result = mergeHybridConfiguration({
    generatedConfigText,
    previousConfigText: fs.readFileSync(previousBackup.configPath, 'utf8'),
    generatedCatalog: readJson(catalogPath),
    previousCatalog: readJson(previousBackup.catalogPath),
    generatedRouting: readJson(routingPath),
    previousRouting: readJson(previousBackup.routingPath),
    installedModels,
  });

  const snapshot = captureFiles([configPath, catalogPath, routingPath]);
  backupFiles(snapshot, backupDir, 'pre-hybrid');
  atomicWrite(configPath, result.configText);
  atomicWrite(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
  atomicWrite(routingPath, `${JSON.stringify(result.routing, null, 2)}\n`);
  return { ...result, cloudBackupSuffix: previousBackup.suffix };
}
