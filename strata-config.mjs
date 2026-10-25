import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, decodedTopString } from './ollama-chatgpt-hybrid.mjs';
import { BRIDGE_BASE, STRATA_MODEL } from './strata-codex-bridge.mjs';

export function configureStrata(configPath) {
  let text = fs.readFileSync(configPath, 'utf8');
  const catalogPath = decodedTopString(text, 'model_catalog_json');
  if (!catalogPath) throw new Error('Connect OllamaForge first so a native/cloud model catalog exists.');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const template = catalog.models.find((model) => model.slug.startsWith('qwen'))
    ?? JSON.parse(fs.readFileSync(new URL('./local-qwen-catalog.json', import.meta.url), 'utf8')).models[0];
  const entry = {
    ...template,
    slug: STRATA_MODEL,
    display_name: 'Strata · Qwen3.8 Flash 128K (IQ3_S)',
    description: 'Local Qwen3.8-Flash-Next 125B IQ3_S, 128K, q4_0 KV, MTP off',
    base_instructions: 'You are Codex, a coding agent. Complete the user request using the available tools. Return either a valid tool call or a useful final answer.',
    model_messages: null,
    context_window: 131072,
    max_context_window: 131072,
    auto_compact_token_limit: 110000,
    effective_context_window_percent: 95,
    default_reasoning_level: 'none',
    supported_reasoning_levels: ['none', 'low', 'medium', 'high'].map((effort) => ({ effort, description: effort === 'none' ? 'Thinking off (fastest)' : `${effort} thinking` })),
    supports_parallel_tool_calls: false,
    supports_search_tool: false,
    input_modalities: ['text', 'image'],
    visibility: 'list',
    priority: -1,
  };
  catalog.models = [...catalog.models.filter((model) => model.slug !== STRATA_MODEL && !(
    /^qwen3\.8-flash-next-iq[23]_/.test(model.slug) && /^Strata\b/.test(model.display_name ?? '')
  )), entry];
  atomicWrite(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  text = text.replace(/(\[model_providers\.ollamaforge\][\s\S]*?^base_url\s*=\s*)"[^"]*"/m, `$1${JSON.stringify(BRIDGE_BASE)}`);
  if (!text.includes(`base_url = ${JSON.stringify(BRIDGE_BASE)}`)) throw new Error('OllamaForge HTTP provider was not configured.');
  // Keep provider settings inside its table, even when other tables follow it.
  text = text.replace(/(\[model_providers\.ollamaforge\]\r?\n)([\s\S]*?)(?=^\[|(?![\s\S]))/m, (_match, header, body) => {
    body = body.replace(/^stream_idle_timeout_ms\s*=.*(?:\r?\n|$)/gm, '');
    return `${header}stream_idle_timeout_ms = 600000\n${body}`;
  });
  atomicWrite(configPath, text);
  return entry;
}

export function strataEnabled(configPath) {
  return fs.existsSync(path.join(path.dirname(configPath), 'ollamaforge-strata.json'));
}
