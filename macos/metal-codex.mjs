#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMetalCatalog, hybridEndpoint } from '../codex-hybrid-config.mjs';
import { atomicWrite } from '../ollama-chatgpt-hybrid.mjs';
import { connect, resolveCodexExecutable } from '../connect.mjs';
import { localCodexLaunch, restoreNativeCodex } from './native-codex.mjs';
import { findCodexApplicationName } from './install-direct-shortcut.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const configDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const configPath = path.join(configDir, 'config.toml');
const globalStatePath = path.join(configDir, '.codex-global-state.json');
const stateDir = path.join(os.homedir(), 'Library', 'Application Support', 'LocalCodexMetal');
const catalogPath = path.join(configDir, 'local-qwen-metal-catalog.json');
const sourceCatalogPath = path.join(root, 'local-qwen-catalog.json');
const modelAlias = 'qwen3.5-codex-metal-8k';
const metalPort = 11436;
const adapterPort = 11435;
const contextWindow = 8192;
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const domain = uid === null ? null : `gui/${uid}`;
const metalLabel = 'com.localcodex.metal-server';
const adapterLabel = 'com.localcodex.ollama-adapter';
const gatewayLabel = 'com.localcodex.hybrid-gateway';
const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const metalPlist = path.join(launchAgentsDir, `${metalLabel}.plist`);
const adapterPlist = path.join(launchAgentsDir, `${adapterLabel}.plist`);
const gatewayPlist = path.join(launchAgentsDir, `${gatewayLabel}.plist`);
const nodeExecutable = ['/usr/local/bin/node', '/opt/homebrew/bin/node', process.execPath]
  .find(candidate => fs.existsSync(candidate));

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plistArray(values) {
  return `<array>${values.map((value) => `<string>${xml(value)}</string>`).join('')}</array>`;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

function stopAgent(plistPath, label) {
  if (!domain) return;
  spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
  spawnSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
}

function findMetalServer() {
  const candidates = [
    process.env.LEETTUTOR_METAL_SERVER,
    path.join(path.dirname(root), 'llama.cpp-metal', 'build-metal', 'bin', 'llama-server'),
    path.join(path.dirname(root), 'Leetcode', '.leettutor', 'llama.cpp-metal', 'build-metal', 'bin', 'llama-server'),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  }) ?? null;
}

function resolveOllamaModel(model = 'qwen3.5:9b') {
  if (process.env.LEETTUTOR_METAL_MODEL_PATH) {
    return fs.existsSync(process.env.LEETTUTOR_METAL_MODEL_PATH)
      ? path.resolve(process.env.LEETTUTOR_METAL_MODEL_PATH)
      : null;
  }
  const [name, tag = 'latest'] = model.split(':', 2);
  const modelsRoot = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const manifestPath = path.join(modelsRoot, 'manifests', 'registry.ollama.ai', 'library', name, tag);
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const layer = manifest.layers?.find((item) => item.mediaType === 'application/vnd.ollama.image.model');
    if (!layer?.digest?.startsWith('sha256:')) return null;
    const blob = path.join(modelsRoot, 'blobs', layer.digest.replace(':', '-'));
    return fs.existsSync(blob) ? fs.realpathSync(blob) : null;
  } catch {
    return null;
  }
}

function writePlist(plistPath, content) {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const temporaryPath = `${plistPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, plistPath);
  fs.chmodSync(plistPath, 0o600);
}

function ensureAgent(plistPath, label, content, changed = false) {
  const same = fs.existsSync(plistPath) && fs.readFileSync(plistPath, 'utf8') === content;
  const loaded = spawnSync('launchctl', ['print', `${domain}/${label}`], {stdio:'ignore'}).status === 0;
  if (same && loaded && !changed) return;
  stopAgent(plistPath, label);
  writePlist(plistPath, content);
  run('launchctl', ['bootstrap', domain, plistPath]);
}

function installMetalAgent(serverPath, modelPath) {
  const stdoutPath = path.join(stateDir, 'metal-server.stdout.log');
  const stderrPath = path.join(stateDir, 'metal-server.stderr.log');
  const args = [
    serverPath, '-m', modelPath, '--alias', modelAlias,
    '--host', '127.0.0.1', '--port', String(metalPort),
    '-dev', 'MTL0', '-ngl', '999', '-fit', 'off', '-lm', 'none',
    '-c', String(contextWindow), '-b', '64', '-ub', '16', '-fa', 'off',
    '--parallel', '1', '--jinja', '--reasoning', 'off', '--reasoning-budget', '0',
    '--reasoning-format', 'deepseek',
  ];
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${metalLabel}</string>\n` +
    `<key>ProgramArguments</key>${plistArray(args)}\n` +
    `<key>EnvironmentVariables</key><dict><key>GGML_METAL_CONCURRENCY_DISABLE</key><string>1</string></dict>\n` +
    `<key>WorkingDirectory</key><string>${xml(root)}</string>\n` +
    `<key>StandardOutPath</key><string>${xml(stdoutPath)}</string>\n` +
    `<key>StandardErrorPath</key><string>${xml(stderrPath)}</string>\n` +
    `<key>RunAtLoad</key><false/><key>KeepAlive</key><false/>\n` +
    `<key>ThrottleInterval</key><integer>10</integer>\n</dict></plist>\n`;
  ensureAgent(metalPlist, metalLabel, content);
}

function installAdapterAgent() {
  const runtimeAdapter = path.join(stateDir, 'codex-ollama-adapter.mjs');
  const runtimeRunner = path.join(stateDir, 'run-codex-ollama-adapter.mjs');
  let changed = false;
  for (const name of ['codex-ollama-adapter.mjs', 'run-codex-ollama-adapter.mjs', 'codex-local-context.mjs']) {
    const source = fs.readFileSync(path.join(root, name));
    const target = path.join(stateDir, name);
    if (!fs.existsSync(target) || !source.equals(fs.readFileSync(target))) {
      fs.writeFileSync(target, source, {mode:0o600});
      changed = true;
    }
  }
  const stdoutPath = path.join(stateDir, 'adapter-launchd.stdout.log');
  const stderrPath = path.join(stateDir, 'adapter-launchd.stderr.log');
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${adapterLabel}</string>\n` +
    `<key>ProgramArguments</key>${plistArray([nodeExecutable, runtimeRunner])}\n` +
    `<key>EnvironmentVariables</key><dict>` +
    `<key>CODEX_OLLAMA_ADAPTER_PORT</key><string>${adapterPort}</string>` +
    `<key>OLLAMA_BASE_URL</key><string>http://127.0.0.1:${metalPort}</string>` +
    `<key>CODEX_LOCAL_RUNTIME_DIR</key><string>${xml(stateDir)}</string>` +
    `<key>CODEX_LOCAL_HISTORY_PATH</key><string>${xml(path.join(stateDir, 'response-history.json'))}</string>` +
    `<key>CODEX_LOCAL_HISTORY_TOKENS</key><string>3000</string>` +
    `</dict>\n` +
    `<key>StandardOutPath</key><string>${xml(stdoutPath)}</string>\n` +
    `<key>StandardErrorPath</key><string>${xml(stderrPath)}</string>\n` +
    `<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n` +
    `<key>ThrottleInterval</key><integer>5</integer>\n</dict></plist>\n`;
  ensureAgent(adapterPlist, adapterLabel, content, changed);
}

function installGatewayAgent() {
  const target = path.join(stateDir, 'codex-hybrid-gateway.mjs');
  let changed = false;
  for (const name of ['codex-hybrid-gateway.mjs', 'codex-local-runtime.mjs']) {
    const source = fs.readFileSync(path.join(root, name));
    const file = path.join(stateDir, name);
    if (!fs.existsSync(file) || !source.equals(fs.readFileSync(file))) {
      fs.writeFileSync(file, source, {mode:0o600});
      changed = true;
    }
  }
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<plist version="1.0"><dict>` +
    `<key>Label</key><string>${gatewayLabel}</string>` +
    `<key>ProgramArguments</key>${plistArray([nodeExecutable, target])}` +
    `<key>EnvironmentVariables</key><dict>` +
    `<key>CODEX_HYBRID_METAL_ON_DEMAND</key><string>1</string>` +
    `<key>CODEX_HYBRID_LOCAL_CATALOG</key><string>${xml(catalogPath)}</string>` +
    `<key>CODEX_HYBRID_CLOUD_CACHE</key><string>${xml(path.join(configDir, 'models_cache.json'))}</string>` +
    `</dict>` +
    `<key>StandardOutPath</key><string>${xml(path.join(stateDir, 'gateway.stdout.log'))}</string>` +
    `<key>StandardErrorPath</key><string>${xml(path.join(stateDir, 'gateway.stderr.log'))}</string>` +
    `<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>` +
    `<key>ThrottleInterval</key><integer>5</integer></dict></plist>\n`;
  ensureAgent(gatewayPlist, gatewayLabel, content, changed);
}

async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function smokeTest() {
  const response = await fetch(`${hybridEndpoint}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelAlias,
      input: 'Reply exactly METAL_READY.',
      stream: false,
      max_output_tokens: 24,
      reasoning: { effort: 'none' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.output?.some((item) => item.type === 'message')) {
    throw new Error(`Metal Responses smoke test failed: ${JSON.stringify(payload)}`);
  }
}

function resolveRecentCloudSelection(statePath = globalStatePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const recent = state?.['electron-persisted-atom-state']?.['composer-recent-model-configurations-v1'];
    const selection = Array.isArray(recent)
      ? recent.find((item) => typeof item?.model === 'string' && item.model.startsWith('gpt-'))
      : null;
    if (!selection) return null;
    return {
      model: selection.model,
      reasoningEffort: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : '',
    };
  } catch {
    return null;
  }
}

export { findMetalServer, resolveOllamaModel, resolveRecentCloudSelection, modelAlias, contextWindow };

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const command = process.argv[2] || 'status';
  const launch = process.argv.includes('--launch');
  if (command === 'cloud') {
    const result = restoreNativeCodex(configPath);
    if (result.changed) {
      console.log(`已恢复 Codex 原生连接。备份：${result.backup}`);
      console.log('请在正在运行的任务结束后退出并重开 Codex。');
    }
    if (launch) run('/usr/bin/open', ['-a', findCodexApplicationName()]);
  } else if (command === 'hybrid' || (command === 'local' && launch && process.arch === 'arm64')) {
    // Preserve the old shortcut argument, but run the isolated Ollama entry.
    connect({ launch, noShortcut: true });
  } else if (command === 'local') {
    if (process.platform !== 'darwin' || process.arch !== 'x64' || !domain) {
      throw new Error('Radeon Metal deployment requires an Intel macOS GUI session.');
    }
    const serverPath = findMetalServer();
    const modelPath = resolveOllamaModel();
    if (!serverPath) throw new Error('Patched llama-server was not found. Install the LeetTutor AMD Metal runtime first.');
    if (!modelPath) throw new Error('qwen3.5:9b Ollama model blob was not found.');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const catalog = createMetalCatalog(JSON.parse(fs.readFileSync(sourceCatalogPath, 'utf8')));
    const catalogText = JSON.stringify(catalog, null, 2) + '\n';
    if (!fs.existsSync(catalogPath) || fs.readFileSync(catalogPath, 'utf8') !== catalogText) {
      atomicWrite(catalogPath, catalogText);
    }
    installMetalAgent(serverPath, modelPath);
    installAdapterAgent();
    await waitFor(`http://127.0.0.1:${adapterPort}/health`, 30_000);
    installGatewayAgent();
    await waitFor(`${hybridEndpoint}/health`, 15_000);
    if (launch) {
      const codex = resolveCodexExecutable();
      if (!codex) throw new Error('Codex CLI was not found.');
      const { args, env } = localCodexLaunch({
        homeDir: os.homedir(), environment: process.env, backend: 'metal',
        endpoint: hybridEndpoint, model: modelAlias, contextWindow,
      });
      run(codex, [...args, '-c', `model_catalog_json=${JSON.stringify(catalogPath)}`], { env });
    } else {
      await smokeTest();
      console.log(`Radeon Metal ready: ${modelAlias}. Use the local Codex shortcut to open its terminal.`);
    }
  } else if (command === 'status') {
    let metalReady = false;
    let adapterReady = false;
    try { metalReady = (await fetch(`http://127.0.0.1:${metalPort}/v1/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    try { adapterReady = (await fetch(`http://127.0.0.1:${adapterPort}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    console.log(`Metal server: ${metalReady ? 'ready' : 'offline'}`);
    console.log(`Codex adapter: ${adapterReady ? 'ready' : 'offline'}`);
    let gatewayReady = false;
    try { gatewayReady = (await fetch(`${hybridEndpoint}/health`, {signal:AbortSignal.timeout(1500)})).ok; } catch {}
    console.log(`Hybrid gateway: ${gatewayReady ? 'ready' : 'offline'}`);
  } else {
    throw new Error('Usage: node macos/metal-codex.mjs <local|cloud|hybrid|status> [--launch]');
  }
}
