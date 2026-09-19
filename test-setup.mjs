import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_SPECS,
  parseArgs,
  resolveOllamaExecutable,
  runSetup,
  windowsOllamaFallback,
} from './setup.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

assert.deepEqual(parseArgs(['--model', '27b', '--no-pull']), { model: '27b', noPull: true, help: false });
assert.deepEqual(parseArgs(['--model=9b']), { model: '9b', noPull: false, help: false });
assert.throws(() => parseArgs(['--model', '70b']), /9b or 27b/);
assert.equal(MODEL_SPECS['9b'].base, 'qwen3.5:9b');
assert.equal(MODEL_SPECS['27b'].base, 'qwen3.8:27b');
assert.equal(MODEL_SPECS['27b'].minimumFreeGiB, 24);

assert.equal(resolveOllamaExecutable({
  platform: 'darwin',
  findOnPath: () => '/opt/homebrew/bin/ollama',
}), '/opt/homebrew/bin/ollama');
const windowsEnvironment = { LOCALAPPDATA: String.raw`C:\Users\tester\AppData\Local` };
const windowsFallback = windowsOllamaFallback(windowsEnvironment);
assert.equal(windowsFallback, String.raw`C:\Users\tester\AppData\Local\Programs\Ollama\ollama.exe`);
assert.equal(resolveOllamaExecutable({
  platform: 'win32',
  environment: windowsEnvironment,
  findOnPath: () => null,
  existsSync: (candidate) => candidate === windowsFallback,
}), windowsFallback);

function createHarness({
  defaultModel = 'gemma4:31b:cloud',
  installedModels = [],
  freeGiB = 80,
  includeStaleLocal = false,
  failAfterLaunch = false,
} = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamaforge-setup-'));
  const homeDir = path.join(work, 'home');
  const configDir = path.join(homeDir, '.codex');
  const backupDir = path.join(homeDir, '.ollama', 'backup', 'codex-app');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const catalogPath = path.join(configDir, 'ollama-launch-models.json');
  const routingPath = path.join(configDir, 'ollama-launch-codex-routing.json');
  const previousConfig = `model = ${JSON.stringify(defaultModel)}\n` +
    `model_reasoning_effort = "high"\n` +
    `model_catalog_json = ${JSON.stringify(catalogPath)}\n\n[features]\napps = true\n`;
  const previousCatalog = { models: [
    { slug: defaultModel, description: 'Cloud default' },
    { slug: 'gpt-cloud', description: 'Other OpenAI model' },
  ] };
  const previousRouting = {
    models: defaultModel.includes(':cloud') ? [{ slug: defaultModel }] : [],
    auto_review_model: 'selected',
    auto_review_fallback_model: defaultModel,
  };
  fs.writeFileSync(configPath, previousConfig);
  fs.writeFileSync(catalogPath, JSON.stringify(previousCatalog));
  fs.writeFileSync(routingPath, JSON.stringify(previousRouting));
  const original = {
    config: fs.readFileSync(configPath),
    catalog: fs.readFileSync(catalogPath),
    routing: fs.readFileSync(routingPath),
  };

  const installed = new Set(installedModels);
  const calls = [];
  const runCapture = (_command, args) => {
    calls.push(['capture', ...args]);
    if (args[0] === 'launch' && args.at(-1) === '--help') return { status: 0, stdout: 'chatgpt' };
    if (args[0] === 'show') return { status: installed.has(args[1]) ? 0 : 1, stdout: '' };
    if (args[0] === 'list') {
      const rows = [...installed].map((model, index) => `${model} id${index} 1 GB now`).join('\n');
      return { status: 0, stdout: `NAME ID SIZE MODIFIED\n${rows}\n` };
    }
    throw new Error(`Unexpected captured command: ${args.join(' ')}`);
  };
  const runInherit = (_command, args) => {
    calls.push(['inherit', ...args]);
    if (args[0] === 'pull') installed.add(args[1]);
    else if (args[0] === 'create') installed.add(args[1]);
    else if (args[0] === 'launch') {
      const selected = args[args.indexOf('--model') + 1];
      const generatedModels = [
        { slug: defaultModel, description: 'Cloud default' },
        { slug: 'gpt-cloud', description: 'Other OpenAI model' },
        ...[...installed].map((slug) => ({ slug, description: 'Ollama model' })),
      ];
      const generatedRoutes = [
        ...(defaultModel.includes(':cloud') ? [{ slug: defaultModel }] : []),
        ...[...installed].map((slug) => ({ slug, thinking: { supported: true } })),
      ];
      if (includeStaleLocal) {
        generatedModels.push({ slug: 'stale-local:7b', description: 'Ollama model' });
        generatedRoutes.push({ slug: 'stale-local:7b' });
      }
      fs.writeFileSync(configPath,
        `model = ${JSON.stringify(selected)}\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n` +
        `openai_base_url = "http://127.0.0.1:11434/api/codex/v1"\n\n[features]\napps = true\n`);
      fs.writeFileSync(catalogPath, JSON.stringify({ models: generatedModels }));
      fs.writeFileSync(routingPath, JSON.stringify({ models: generatedRoutes }));
    } else throw new Error(`Unexpected inherited command: ${args.join(' ')}`);
    return { status: 0 };
  };

  return {
    work,
    homeDir,
    configDir,
    backupDir,
    configPath,
    catalogPath,
    routingPath,
    original,
    installed,
    calls,
    dependencies: {
      platform: 'darwin',
      environment: { CODEX_HOME: configDir },
      homeDir,
      rootDir,
      backupDir,
      ollamaExecutable: '/mock/ollama',
      runCapture,
      runInherit,
      availableBytes: () => freeGiB * (1024 ** 3),
      afterLaunch: failAfterLaunch ? () => { throw new Error('simulated post-launch failure'); } : undefined,
    },
  };
}

function cleanup(harness) {
  fs.rmSync(harness.work, { recursive: true, force: true });
}

{
  const harness = createHarness({ includeStaleLocal: true });
  try {
    const result = runSetup({ model: '9b', noPull: false }, harness.dependencies);
    assert.ok(harness.installed.has('qwen3.5:9b'));
    assert.ok(harness.installed.has('qwen3.5-codex-fast-16k'));
    assert.ok(!harness.calls.flat().includes('qwen3.8:27b'), '9B setup must not inspect or pull 27B');
    assert.equal(result.cloudDefault, 'gemma4:31b:cloud');
    assert.match(fs.readFileSync(harness.configPath, 'utf8'), /^model = "gemma4:31b:cloud"/m);
    const slugs = readModels(harness.catalogPath);
    assert.ok(slugs.includes('qwen3.5-codex-fast-16k'));
    assert.ok(!slugs.includes('stale-local:7b'));
    const alias = JSON.parse(fs.readFileSync(harness.catalogPath, 'utf8')).models
      .find((entry) => entry.slug === 'qwen3.5-codex-fast-16k');
    assert.equal(alias.include_apps_usage_instructions, true);
    assert.equal(alias.include_plugin_usage_instructions, true);
    assert.equal(alias.include_skills_usage_instructions, true);
    assert.equal(result.backups.length, 3);
  } finally {
    cleanup(harness);
  }
}

{
  const harness = createHarness({
    defaultModel: 'gpt-5.6-sol',
    installedModels: ['qwen3.8:27b'],
  });
  try {
    const result = runSetup({ model: '27b', noPull: true }, { ...harness.dependencies, platform: 'win32' });
    assert.equal(result.cloudDefault, 'gpt-5.6-sol');
    assert.ok(harness.installed.has('qwen3.8-codex-16k'));
    assert.ok(!harness.calls.some((call) => call[1] === 'pull'));
    assert.ok(!harness.calls.flat().includes('qwen3.5:9b'), '27B setup must not inspect or pull 9B');
    const qualityAlias = JSON.parse(fs.readFileSync(harness.catalogPath, 'utf8')).models
      .find((entry) => entry.slug === 'qwen3.8-codex-16k');
    assert.equal(qualityAlias.default_reasoning_level, 'none');
    assert.deepEqual(qualityAlias.supported_reasoning_levels.map((entry) => entry.effort), ['none', 'medium']);
  } finally {
    cleanup(harness);
  }
}

{
  const harness = createHarness({ freeGiB: 23.9 });
  try {
    assert.throws(() => runSetup({ model: '27b', noPull: false }, harness.dependencies), /24 GiB required/);
    assert.ok(!harness.calls.some((call) => call[1] === 'pull'));
  } finally {
    cleanup(harness);
  }
}

{
  const harness = createHarness();
  try {
    assert.throws(() => runSetup({ model: '27b', noPull: true }, harness.dependencies), /--no-pull was requested/);
  } finally {
    cleanup(harness);
  }
}

{
  const harness = createHarness({
    installedModels: ['qwen3.5:9b', 'qwen3.5-codex-fast-16k'],
    failAfterLaunch: true,
  });
  try {
    assert.throws(() => runSetup({ model: '9b', noPull: true }, harness.dependencies), /configuration was restored/);
    assert.deepEqual(fs.readFileSync(harness.configPath), harness.original.config);
    assert.deepEqual(fs.readFileSync(harness.catalogPath), harness.original.catalog);
    assert.deepEqual(fs.readFileSync(harness.routingPath), harness.original.routing);
  } finally {
    cleanup(harness);
  }
}

const starter = fs.readFileSync(path.join(rootDir, 'Start-CodexOllama.ps1'), 'utf8');
assert.match(starter, /\$selectedSpec\s*=\s*\$modelSpecs\s*\|\s*Where-Object/);
assert.doesNotMatch(starter, /foreach\s*\(\$spec\s+in\s+\$modelSpecs\)/i);

console.log('PASS: cross-platform setup selects one model, preserves cloud defaults, and rolls back safely.');

function readModels(catalogPath) {
  return JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models.map((entry) => entry.slug);
}
