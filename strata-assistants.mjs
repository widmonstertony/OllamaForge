import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(ROOT, '.runtime', 'openclaw');
const BIN = path.join(RUNTIME, 'node_modules', 'openclaw', 'openclaw.mjs');
const SAVED = path.join(ROOT, '.runtime', 'strata-assistants.json');
const CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const VERSION = '2026.10.8';

function run(exe, args, extra = {}) {
  const result = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true, ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(exe)} exited ${result.status}`);
}

async function connect() {
  const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Strata health returned ${response.status}`);
  const health = await response.json();
  if (health.service !== 'strata' || !health.model || !Number.isInteger(health.max_context)) throw new Error('Start Strata first.');
  if (!fs.existsSync(BIN)) {
    const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npm)) throw new Error('Run this command with the supported Node/npm installation.');
    run(process.execPath, [npm, 'install', '--prefix', RUNTIME, '--no-audit', '--no-fund', '--save-exact', `openclaw@${VERSION}`]);
  }
  if (!fs.existsSync(CONFIG)) run(process.execPath, [BIN, 'onboard', '--non-interactive', '--accept-risk', '--mode', 'local',
    '--auth-choice', 'custom-api-key', '--custom-provider-id', 'strata', '--custom-base-url', 'http://127.0.0.1:8080/v1',
    '--custom-model-id', health.model, '--custom-api-key', 'local-strata-no-auth', '--custom-compatibility', 'openai',
    '--gateway-bind', 'loopback', '--gateway-port', '18789', '--gateway-auth', 'token', '--workspace', path.join(RUNTIME, 'workspace'),
    '--skip-daemon', '--skip-skills', '--skip-channels', '--skip-search', '--skip-hooks', '--skip-ui', '--skip-health', '--suppress-gateway-token-output']);
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const original = JSON.stringify(config);
  config.models ??= {}; config.models.providers ??= {};
  config.models.providers.strata = { baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-completions', apiKey: 'local-strata-no-auth',
    models: [{ id: health.model, name: 'Strata · Qwen3.8 Flash 128K', contextTokens: health.max_context, maxTokens: 8192,
      reasoning: false, input: health.images ? ['text', 'image'] : ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
  config.agents ??= {}; config.agents.defaults ??= {};
  config.agents.defaults.model = { ...(typeof config.agents.defaults.model === 'object' ? config.agents.defaults.model : {}), primary: `strata/${health.model}` };
  config.agents.defaults.thinkingDefault = 'off';
  if (JSON.stringify(config) !== original) {
    let gatewayRunning = false;
    try { gatewayRunning = (await fetch(`http://127.0.0.1:${config.gateway?.port ?? 18789}/healthz`, { signal: AbortSignal.timeout(1500) })).ok; } catch { }
    if (gatewayRunning) throw new Error('OpenClaw is running with different settings. Stop it or use its model settings before reconnecting; its configuration was preserved.');
    fs.copyFileSync(CONFIG, `${CONFIG}.ollamaforge-${Date.now()}.bak`);
    fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
  }
  const jarvis = path.resolve(process.argv[3] ?? path.join(ROOT, '..', 'Leetcode'));
  const python = path.join(jarvis, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python) || !fs.existsSync(path.join(jarvis, 'scripts', 'browser_bridge.py'))) throw new Error('Prepare the Leetcode checkout and its Python environment first.');
  run(python, ['-c', 'import sys; from leettutor.config import load_config,save_config; from leettutor.providers import STRATA_PROVIDER; c=load_config(); c.provider=STRATA_PROVIDER; c.model=sys.argv[1]; c.models[STRATA_PROVIDER]=c.model; c.auto_tune=False; c.context_tokens=32768; c.timeout_seconds=600; save_config(c); print("JARVIS default saved: Strata")', health.model], { cwd: jarvis });
  fs.writeFileSync(SAVED, JSON.stringify({ jarvis, python, model: health.model, openclawPort: config.gateway?.port ?? 18789, jarvisPort: 1234 }, null, 2));
  console.log(`Connected OpenClaw and JARVIS to Strata: ${health.model}, ${health.max_context} context. No model download.`);
}

function serve(kind) {
  const saved = JSON.parse(fs.readFileSync(SAVED, 'utf8'));
  const log = prefix => fs.openSync(path.join(ROOT, '.runtime', `${kind}.${prefix}.log`), 'a');
  const exe = kind === 'openclaw' ? process.execPath : saved.python;
  const args = kind === 'openclaw' ? [BIN, 'gateway', 'run', '--bind', 'loopback', '--port', String(saved.openclawPort)]
    : [path.join(saved.jarvis, 'scripts', 'browser_bridge.py'), '--port', String(saved.jarvisPort), '--upstream', 'http://127.0.0.1:8080/v1'];
  const out = log('stdout'), err = log('stderr');
  let child;
  try { child = spawn(exe, args, { cwd: kind === 'openclaw' ? ROOT : saved.jarvis, windowsHide: true, stdio: ['ignore', out, err] }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

try {
  const command = process.argv[2] ?? 'connect';
  if (command === 'connect') await connect();
  else if (command === 'serve-openclaw') serve('openclaw');
  else if (command === 'serve-jarvis') serve('jarvis');
  else if (command === 'launch') {
    const env = { ...process.env }; delete env.PSModulePath;
    run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'Start-StrataAssistants.ps1'), '-WaitFor', process.argv[3] ?? 'both'], { env });
  } else if (command === 'open-openclaw' || command === 'open-jarvis') {
    const saved = JSON.parse(fs.readFileSync(SAVED, 'utf8'));
    const url = command === 'open-openclaw' ? `http://127.0.0.1:${saved.openclawPort}/#token=${encodeURIComponent(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).gateway.auth.token)}`
      : `http://127.0.0.1:${saved.jarvisPort}/?provider=strata`;
    run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]);
  } else throw new Error('Use connect, launch, open-openclaw or open-jarvis.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
