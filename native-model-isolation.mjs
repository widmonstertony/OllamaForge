import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, decodedTopString, setTopValue } from './ollama-chatgpt-hybrid.mjs';
import { configureStrata, strataEnabled } from './strata-config.mjs';
import { STRATA_MODEL, BRIDGE_BASE } from './strata-codex-bridge.mjs';

export const LOCAL_PROFILE = 'ollamaforge-local';
export function installLocalProfile(configPath, installed, requested) {
  const home = path.dirname(configPath);
  const original = fs.readFileSync(configPath, 'utf8');
  const strata = strataEnabled(configPath);
  const canonical = model => model.replace(/:latest$/, '');
  const models = [...new Set(installed.map(canonical))];
  const primary = requested ? models.find(m => m.toLowerCase() === canonical(requested).toLowerCase())
    ?? (strata && requested === STRATA_MODEL ? STRATA_MODEL : null)
    : strata ? STRATA_MODEL : models[0];
  if (!primary) throw new Error(requested ? 'Requested local model is not installed.' : 'No local Ollama model is installed and Strata is not configured.');
  const templateCatalog = JSON.parse(fs.readFileSync(new URL('./local-qwen-catalog.json', import.meta.url), 'utf8'));
  const catalogPath = path.join(home, 'ollamaforge-local-models.json');
  const profilePath = path.join(home, `${LOCAL_PROFILE}.config.toml`);
  const entries = models.map(slug => {
    const template = templateCatalog.models.find(m => m.slug === slug) ?? templateCatalog.models[0];
    const context = /110k/.test(slug) ? 110000 : /64k/.test(slug) ? 65536 : template.context_window;
    return { ...template, slug, display_name: slug, context_window: context, max_context_window: context,
      auto_compact_token_limit: Math.floor(context * 0.8), default_reasoning_level: 'none' };
  });
  atomicWrite(catalogPath, JSON.stringify({ models: entries }, null, 2) + '\n');
  const endpoint = strata ? BRIDGE_BASE : 'http://127.0.0.1:11434/api/codex/v1';
  atomicWrite(profilePath, `# OllamaForge local-only profile. The native config.toml is never replaced.\nmodel = ${JSON.stringify(primary)}\nmodel_provider = "ollamaforge"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\nmodel_reasoning_effort = "none"\n\n[model_providers.ollamaforge]\nname = "OllamaForge local-only bridge"\nbase_url = ${JSON.stringify(endpoint)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  if (strata) configureStrata(profilePath);
  if (fs.readFileSync(configPath, 'utf8') !== original) throw new Error('Native configuration changed unexpectedly.');
  return { profile: LOCAL_PROFILE, profilePath, localCatalogPath: catalogPath, primary, endpoint, strata: strata ? STRATA_MODEL : null,
    defaultModel: decodedTopString(original, 'model'), nativeConfigurationUnchanged: true };
}

export function nativeRepairText(text, configPath) {
  const home = path.dirname(configPath);
  const topEnd = text.search(/^\[/m);
  let top = topEnd < 0 ? text : text.slice(0, topEnd);
  const tables = topEnd < 0 ? '' : text.slice(topEnd);
  const provider = decodedTopString(top, 'model_provider');
  const catalog = decodedTopString(top, 'model_catalog_json');
  const base = decodedTopString(top, 'openai_base_url');
  const removed = [];
  const remove = key => { top = top.replace(new RegExp(`^${key}\\s*=.*(?:\\r?\\n|$)`, 'gm'), ''); removed.push(key); };
  if (catalog && ['ollama-launch-models.json', 'local-qwen-catalog.json'].some(name => path.resolve(catalog) === path.join(home, name))) remove('model_catalog_json');
  if (base && ['http://127.0.0.1:11434/api/codex/v1', BRIDGE_BASE, 'http://127.0.0.1:11435/v1'].includes(base.replace(/\/$/, ''))) remove('openai_base_url');
  if (['ollamaforge', 'local_qwen', 'ollama_codex_adapter'].includes(provider)) {
    const model = decodedTopString(top, 'model');
    if (model && /^qwen/i.test(model)) throw new Error('Choose your original native cloud model before repairing this legacy local default.');
    top = setTopValue(top, 'model_provider', '"openai"'); removed.push('legacy model_provider');
  }
  return { text: top + tables, removed };
}

export function repairNative(configPath, backupRoot) {
  const original = fs.readFileSync(configPath, 'utf8');
  const result = nativeRepairText(original, configPath);
  if (!result.removed.length) return { changed: false, removed: [] };
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = path.join(backupRoot, `native-config-${Date.now()}.toml`);
  fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
  atomicWrite(configPath, result.text);
  return { changed: true, removed: result.removed, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'repair') throw new Error('Use: node native-model-isolation.mjs repair');
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    console.log(JSON.stringify(repairNative(path.join(home, 'config.toml'), path.join(path.dirname(fileURLToPath(import.meta.url)), '.runtime', 'native-backups')), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
