import fs from 'node:fs';
import path from 'node:path';

const [action, configPath, statePath, sourceCatalogPath, localCatalogPath, requestedModel] = process.argv.slice(2);
const providerId = 'local_qwen';
const localModel = requestedModel ?? 'qwen3.5-codex-fast-16k';
const managedKeys = ['model', 'model_reasoning_effort', 'model_provider', 'model_catalog_json', 'openai_base_url', 'developer_instructions', 'tool_output_token_limit'];
const managedTables = {
  features: ['plugins', 'apps', 'browser_use', 'image_generation', 'multi_agent'],
  'mcp_servers.node_repl': ['enabled'],
};

if (!['snapshot', 'local', 'cloud', 'rollback', 'status'].includes(action) || !configPath || !statePath) {
  throw new Error('Usage: node codex-mode-config.mjs <snapshot|local|cloud|rollback|status> <config> <state> [source-catalog] [local-catalog] [local-model]');
}

function readConfig() {
  return fs.readFileSync(configPath, 'utf8');
}

function topValues(text) {
  const top = text.split(/(?=^\[)/m, 1)[0];
  const values = {};
  for (const key of managedKeys) {
    const match = top.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    values[key] = match?.[1]?.trim() ?? null;
  }
  return values;
}

function isLocal(text) {
  return topValues(text).model_provider === JSON.stringify(providerId);
}

function setTopValues(text, values) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const tableIndex = lines.findIndex((line) => /^\[/.test(line));
  const boundary = tableIndex === -1 ? lines.length : tableIndex;
  const top = lines.slice(0, boundary).filter((line) =>
    !managedKeys.some((key) => new RegExp(`^${key}\\s*=`).test(line))
  );
  const settings = managedKeys
    .filter((key) => values[key] !== null && values[key] !== undefined)
    .map((key) => `${key} = ${values[key]}`);
  return [...settings, ...top, ...lines.slice(boundary)].join(newline);
}

function tableValues(text, tableName, keys) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${tableName}]`);
  const values = Object.fromEntries(keys.map((key) => [key, null]));
  if (start < 0) return values;
  const endRelative = lines.slice(start + 1).findIndex((line) => /^\[/.test(line));
  const end = endRelative < 0 ? lines.length : start + 1 + endRelative;
  for (const key of keys) {
    const match = lines.slice(start + 1, end).join('\n').match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    values[key] = match?.[1]?.trim() ?? null;
  }
  return values;
}

function setTableValues(text, tableName, values) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const keys = managedTables[tableName];
  let start = lines.findIndex((line) => line.trim() === `[${tableName}]`);
  if (start < 0) {
    if (!keys.some((key) => values[key] !== null && values[key] !== undefined)) return text;
    lines.push(`[${tableName}]`);
    start = lines.length - 1;
  }
  const endRelative = lines.slice(start + 1).findIndex((line) => /^\[/.test(line));
  const end = endRelative < 0 ? lines.length : start + 1 + endRelative;
  const body = lines.slice(start + 1, end).filter((line) =>
    !keys.some((key) => new RegExp(`^${key}\\s*=`).test(line))
  );
  const settings = keys
    .filter((key) => values[key] !== null && values[key] !== undefined)
    .map((key) => `${key} = ${values[key]}`);
  lines.splice(start + 1, end - start - 1, ...settings, ...body);
  return lines.join(newline);
}

function removeManagedProvider(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const result = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === `[model_providers.${providerId}]` ||
        line.trim().startsWith(`[model_providers.${providerId}.`)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[/.test(line)) skipping = false;
    if (!skipping) result.push(line);
  }
  return result.join(newline).trimEnd() + newline;
}

function writeConfig(text) {
  fs.writeFileSync(configPath, text, 'utf8');
}

const current = readConfig();

if (action === 'status') {
  process.stdout.write(isLocal(current) ? 'local\n' : 'cloud\n');
} else if (action === 'snapshot') {
  if (!isLocal(current)) {
    const state = {
      version: 2,
      capturedAt: new Date().toISOString(),
      values: topValues(current),
      tables: Object.fromEntries(Object.entries(managedTables).map(([name, keys]) =>
        [name, tableValues(current, name, keys)])),
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    process.stdout.write('Saved current cloud model settings.\n');
  } else if (!fs.existsSync(statePath)) {
    throw new Error('Local mode is active but no cloud-settings snapshot exists. Refusing to overwrite it.');
  }
} else if (action === 'local') {
  if (!fs.existsSync(statePath)) throw new Error('Cloud-settings snapshot is missing. Run snapshot first.');
  if (!sourceCatalogPath || !localCatalogPath) throw new Error('Local mode requires source and filtered catalog paths.');
  const catalog = JSON.parse(fs.readFileSync(sourceCatalogPath, 'utf8'));
  const localModels = ['qwen3.5-codex-fast-16k', 'qwen3.8-codex-16k'];
  const entries = localModels.flatMap((slug) => {
    const source = catalog.models?.find((model) => model.slug === slug || model.slug === `${slug}:latest`);
    if (!source) return [];
    const entry = { ...source };
    entry.slug = slug;
    entry.display_name = slug;
    entry.context_window = 16384;
    entry.max_context_window = 16384;
    entry.auto_compact_token_limit = 11500;
    entry.default_reasoning_level = slug === 'qwen3.5-codex-fast-16k' ? 'none' : 'low';
    entry.supported_reasoning_levels = slug === 'qwen3.5-codex-fast-16k'
      ? [
          { effort: 'none', description: 'Fastest local responses' },
          { effort: 'medium', description: 'More deliberate local responses' },
        ]
      : [
          { effort: 'low', description: 'Brief local reasoning' },
          { effort: 'medium', description: 'Balanced local reasoning' },
          { effort: 'xhigh', description: 'Deep local reasoning (slow)' },
        ];
    entry.include_apps_usage_instructions = false;
    entry.include_plugin_usage_instructions = false;
    entry.include_skills_usage_instructions = false;
    entry.supports_parallel_tool_calls = false;
    entry.supports_search_tool = false;
    return [entry];
  });
  if (!entries.some((entry) => entry.slug === localModel)) {
    throw new Error(`Ollama catalog does not contain ${localModel}.`);
  }
  fs.writeFileSync(localCatalogPath, `${JSON.stringify({ models: entries }, null, 2)}\n`, 'utf8');

  let text = removeManagedProvider(current);
  text = setTopValues(text, {
    model: JSON.stringify(localModel),
    model_reasoning_effort: JSON.stringify(localModel === 'qwen3.5-codex-fast-16k' ? 'none' : 'low'),
    model_provider: JSON.stringify(providerId),
    model_catalog_json: JSON.stringify(localCatalogPath),
    openai_base_url: null,
    tool_output_token_limit: '2500',
    developer_instructions: JSON.stringify((process.platform === 'win32'
      ? 'Local Windows runtime. Shell tool commands already use PowerShell: pass native PowerShell directly; never wrap commands in pwsh or powershell -Command. '
      : 'Local macOS runtime. Use native macOS/POSIX shell commands and paths. ') +
      'For filesystem analysis, scan large candidate folders once, avoid repeated full-drive recursive scans, and report partial results or access errors. Prefer concise tool output and provide progress on slow work.'),
  });
  text = setTableValues(text, 'features', {
    plugins: 'false', apps: 'false', browser_use: 'false', image_generation: 'false', multi_agent: 'false',
  });
  text = setTableValues(text, 'mcp_servers.node_repl', { enabled: 'false' });
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  text += `${newline}[model_providers.${providerId}]${newline}`;
  text += `name = "Local Qwen via Ollama"${newline}`;
  text += `base_url = "http://127.0.0.1:11435/v1"${newline}`;
  text += `wire_api = "responses"${newline}`;
  text += `supports_websockets = false${newline}`;
  text += `request_max_retries = 1${newline}`;
  text += `stream_max_retries = 1${newline}`;
  writeConfig(text);
  process.stdout.write('Configured isolated local_qwen provider; built-in OpenAI URL is unchanged.\n');
} else if (action === 'cloud' || action === 'rollback') {
  if (!isLocal(current) && action !== 'rollback') {
    process.stdout.write('Cloud mode is already configured.\n');
  } else {
    if (!fs.existsSync(statePath)) throw new Error('Cloud-settings snapshot is missing. Refusing to guess the original model.');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (![1, 2].includes(state.version) || !state.values) throw new Error('Cloud-settings snapshot is invalid.');
    let text = setTopValues(removeManagedProvider(current), state.values);
    for (const name of Object.keys(managedTables)) {
      text = setTableValues(text, name, state.tables?.[name] ?? {});
    }
    writeConfig(text);
    process.stdout.write('Restored original cloud model settings.\n');
  }
}
