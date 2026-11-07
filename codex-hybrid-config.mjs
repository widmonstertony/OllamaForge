import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, decodedTopString } from './ollama-chatgpt-hybrid.mjs';

export const metalAlias = 'qwen3.5-codex-metal-8k';
export const hybridEndpoint = 'http://127.0.0.1:11437';

function updateTop(text, values) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex(line => /^\s*\[/.test(line));
  const boundary = first < 0 ? lines.length : first;
  const keys = Object.keys(values);
  const top = lines.slice(0, boundary).filter(line => !keys.some(key =>
    new RegExp(`^\\s*${key}\\s*=`).test(line)));
  const additions = keys.filter(key => values[key] !== null).map(key => `${key} = ${values[key]}`);
  return [...additions, ...top, ...lines.slice(boundary)].join(newline);
}

function replaceLocalProvider(text, endpoint) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let skipping = false;
  const lines = text.split(/\r?\n/).filter(line => {
    if (/^\s*\[model_providers\.local_qwen(?:\.|\])/.test(line)) { skipping = true; return false; }
    if (/^\s*\[/.test(line)) skipping = false;
    return !skipping;
  });
  return lines.join(newline).trimEnd() + newline + newline +
    '[model_providers.local_qwen]' + newline +
    'name = "Local and cloud (legacy conversation compatibility)"' + newline +
    `base_url = ${JSON.stringify(endpoint)}` + newline +
    'wire_api = "responses"' + newline +
    'requires_openai_auth = true' + newline +
    'supports_websockets = false' + newline;
}

export function createMetalCatalog(source) {
  const original = source.models?.find(model => model.slug === metalAlias) ??
    source.models?.find(model => model.slug === 'qwen3.5-codex-fast-16k');
  if (!original) throw new Error('The source catalog has no Metal-compatible Qwen model.');
  return { models: [{
    ...original,
    slug: metalAlias,
    display_name: 'Local Qwen 3.5 9B · Radeon Metal',
    description: 'Runs on this Mac Radeon GPU. 8K context; older context is summarized locally.',
    context_window: 8192,
    max_context_window: 8192,
    auto_compact_token_limit: 5000,
    priority: 1000,
    visibility: 'list',
    default_reasoning_level: 'none',
    supported_reasoning_levels: [{ effort: 'none', description: 'Local Radeon GPU inference' }],
    input_modalities: ['text'],
    include_apps_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_skills_usage_instructions: false,
    supports_parallel_tool_calls: false,
    supports_search_tool: false,
    truncation_policy: { mode: 'tokens', limit: 1200 },
    upgrade: null,
  }] };
}

export function buildHybridConfiguration(text, {
  endpoint = hybridEndpoint, preference = 'keep', cloudModels = [], recentSelection = null,
} = {}) {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') {
    throw new Error('The hybrid endpoint must be a local HTTP listener.');
  }
  const currentModel = decodedTopString(text, 'model');
  const local = name => name === metalAlias || /^qwen/i.test(name ?? '');
  const visible = cloudModels.filter(entry => entry.slug && !local(entry.slug) && entry.visibility !== 'hide');
  const validRecent = recentSelection?.model && !local(recentSelection.model) &&
    (!cloudModels.length || cloudModels.some(entry => entry.slug === recentSelection.model));
  const cloudModel = preference === 'cloud' && validRecent ? recentSelection.model :
    currentModel && !local(currentModel) ? currentModel : validRecent ? recentSelection.model :
      visible[0]?.slug;
  const model = preference === 'local' ? metalAlias :
    preference === 'keep' && currentModel === metalAlias ? metalAlias : cloudModel;
  if (!model) throw new Error('No cloud model is available. Refresh the native cloud model list first.');
  const values = {
    model: JSON.stringify(model),
    model_provider: '"openai"',
    openai_base_url: JSON.stringify(endpoint),
    model_catalog_json: null,
  };
  const top = text.split(/(?=^\[)/m, 1)[0];
  if (model === metalAlias) values.model_reasoning_effort = '"none"';
  else if ((preference === 'cloud' || local(currentModel)) && validRecent && recentSelection.reasoningEffort) {
    values.model_reasoning_effort = JSON.stringify(recentSelection.reasoningEffort);
  } else if (local(currentModel)) {
    values.model_reasoning_effort = JSON.stringify(visible.find(entry => entry.slug === model)?.default_reasoning_level ?? 'medium');
  }
  const instructions = decodedTopString(text, 'developer_instructions');
  // Remove only the instructions installed by the old mode switch, preserving user customizations.
  if (/^Local (macOS|Windows) runtime\./.test(instructions ?? '')) {
    values.developer_instructions = null;
    if (/^tool_output_token_limit\s*=\s*(1200|2500)\s*$/m.test(top)) values.tool_output_token_limit = null;
  }
  if (local(currentModel) || decodedTopString(text, 'model_provider') === 'local_qwen') {
    for (const key of ['model_context_window', 'model_auto_compact_token_limit']) values[key] = null;
  }
  return { configText: replaceLocalProvider(updateTop(text, values), endpoint), model };
}

export function installHybridConfiguration({configPath, stateDir, sourceCatalogPath, localCatalogPath,
  cloudCachePath, preference = 'keep', recentSelection = null}) {
  const original = fs.readFileSync(configPath, 'utf8');
  let cloudModels = [];
  try { cloudModels = JSON.parse(fs.readFileSync(cloudCachePath, 'utf8')).models ?? []; } catch {}
  const catalog = createMetalCatalog(JSON.parse(fs.readFileSync(sourceCatalogPath, 'utf8')));
  const result = buildHybridConfiguration(original, {cloudModels, preference, recentSelection});
  fs.mkdirSync(stateDir, {recursive:true, mode:0o700});
  if (result.configText !== original) {
    atomicWrite(path.join(stateDir, `config.pre-hybrid-${Date.now()}.toml`), original);
  }
  atomicWrite(localCatalogPath, JSON.stringify(catalog, null, 2) + '\n');
  if (result.configText !== original) atomicWrite(configPath, result.configText);
  return {...result, localModels: catalog.models.map(model => model.slug)};
}
