#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(root, 'codex-mode-config.mjs');
const connectHelper = path.join(root, 'connect.mjs');
const configDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const configPath = path.join(configDir, 'config.toml');
const globalStatePath = path.join(configDir, '.codex-global-state.json');
const stateDir = path.join(os.homedir(), 'Library', 'Application Support', 'LocalCodexMetal');
const snapshotPath = path.join(stateDir, 'pre-metal-codex-config.json');
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
const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const metalPlist = path.join(launchAgentsDir, `${metalLabel}.plist`);
const adapterPlist = path.join(launchAgentsDir, `${adapterLabel}.plist`);

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
    `<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n` +
    `<key>ThrottleInterval</key><integer>10</integer>\n</dict></plist>\n`;
  stopAgent(metalPlist, metalLabel);
  writePlist(metalPlist, content);
  run('launchctl', ['bootstrap', domain, metalPlist]);
}

function installAdapterAgent() {
  const runtimeAdapter = path.join(stateDir, 'codex-ollama-adapter.mjs');
  const runtimeRunner = path.join(stateDir, 'run-codex-ollama-adapter.mjs');
  fs.copyFileSync(path.join(root, 'codex-ollama-adapter.mjs'), runtimeAdapter);
  fs.copyFileSync(path.join(root, 'run-codex-ollama-adapter.mjs'), runtimeRunner);
  const stdoutPath = path.join(stateDir, 'adapter-launchd.stdout.log');
  const stderrPath = path.join(stateDir, 'adapter-launchd.stderr.log');
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${adapterLabel}</string>\n` +
    `<key>ProgramArguments</key>${plistArray([process.execPath, runtimeRunner])}\n` +
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
  stopAgent(adapterPlist, adapterLabel);
  writePlist(adapterPlist, content);
  run('launchctl', ['bootstrap', domain, adapterPlist]);
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
  const response = await fetch(`http://127.0.0.1:${adapterPort}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelAlias,
      input: 'Reply exactly METAL_READY.',
      stream: false,
      max_output_tokens: 24,
      reasoning: { effort: 'none' },
    }),
    signal: AbortSignal.timeout(30_000),
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

function configAction(action, cloudSelection = null) {
  run(process.execPath, [helper, action, configPath, snapshotPath,
    ...(action === 'local' ? [sourceCatalogPath, catalogPath, modelAlias, modelAlias] : [])], {
    env: {
      ...process.env,
      CODEX_LOCAL_CONTEXT_WINDOW: String(contextWindow),
      CODEX_LOCAL_PROVIDER_NAME: 'Local Qwen via Radeon Metal',
      ...(cloudSelection ? {
        CODEX_CLOUD_MODEL: cloudSelection.model,
        CODEX_CLOUD_REASONING_EFFORT: cloudSelection.reasoningEffort,
      } : {}),
    },
  });
}

function stopServices() {
  stopAgent(adapterPlist, adapterLabel);
  stopAgent(metalPlist, metalLabel);
}

export { findMetalServer, resolveOllamaModel, resolveRecentCloudSelection, modelAlias, contextWindow };

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  if (process.platform !== 'darwin' || process.arch !== 'x64') {
    throw new Error('Radeon Metal deployment requires an Intel macOS host.');
  }
  if (!domain) throw new Error('Could not determine the current macOS launchd GUI domain.');
  if (!fs.existsSync(configPath)) throw new Error(`Codex config not found: ${configPath}`);
  const command = process.argv[2] || 'status';
  if (!['local', 'cloud', 'status'].includes(command)) {
    throw new Error('Usage: node macos/metal-codex.mjs <local|cloud|status>');
  }
  if (command === 'local') {
    const serverPath = findMetalServer();
    const modelPath = resolveOllamaModel();
    if (!serverPath) throw new Error('Patched llama-server was not found. Install the LeetTutor AMD Metal runtime first.');
    if (!modelPath) throw new Error('qwen3.5:9b Ollama model blob was not found.');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);
    configAction('snapshot');
    installMetalAgent(serverPath, modelPath);
    await waitFor(`http://127.0.0.1:${metalPort}/v1/models`);
    installAdapterAgent();
    await waitFor(`http://127.0.0.1:${adapterPort}/health`, 30_000);
    await smokeTest();
    configAction('local');
    console.log(`Radeon Metal Codex is ready: ${modelAlias}, ${contextWindow} tokens.`);
  } else if (command === 'cloud') {
    configAction('cloud', resolveRecentCloudSelection());
    const restoredConfig = fs.readFileSync(configPath, 'utf8');
    if (restoredConfig.includes('127.0.0.1:11434/api/codex/v1')) {
      run(process.execPath, [connectHelper, '--disconnect']);
    }
    stopServices();
    console.log('OpenAI cloud configuration restored and Metal services stopped.');
  } else {
    let metalReady = false;
    let adapterReady = false;
    try { metalReady = (await fetch(`http://127.0.0.1:${metalPort}/v1/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    try { adapterReady = (await fetch(`http://127.0.0.1:${adapterPort}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    console.log(`Metal server: ${metalReady ? 'ready' : 'offline'}`);
    console.log(`Codex adapter: ${adapterReady ? 'ready' : 'offline'}`);
  }
}
