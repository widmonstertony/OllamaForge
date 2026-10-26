import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { localCompactionPolicy, rewriteCompactionTree } from './deepseek-compaction.mjs';

export const DSH_VERSION = '0.2.1-rc.2';
export const DSH_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-computer-use', '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native', '@deepseek-ai/dsh-browser-use', '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'];
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME = path.join(ROOT, '.runtime', 'deepseek-harness');
const BIN = path.join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const HOME = path.join(RUNTIME, 'home');
const PATCH = path.join(RUNTIME, 'ollamaforge.patch.yml');
const SETTINGS = path.join(RUNTIME, 'connection.json');
const LOCAL_KEY = 'OLLAMAFORGE_LOCAL_DSH_KEY';
const WEB_LOG = path.join(RUNTIME, 'web.stdout.log');

export function parseHarnessArgs(args) {
  const options = { command: args[0] ?? 'connect', port: 3080 };
  if (!['connect', 'launch', 'serve', 'test', 'stop', 'repair-workspace'].includes(options.command)) throw new Error('Use connect, launch, test, stop or repair-workspace.');
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === '--no-open') { options.noOpen = true; continue; }
    if (key === '--apply' && options.command === 'repair-workspace') { options.apply = true; continue; }
    if (!['--base-url', '--model', '--context', '--api', '--port', '--workspace'].includes(key) || !args[i + 1]) throw new Error(`Invalid option: ${key}`);
    options[key.slice(2)] = args[++i];
  }
  options.port = Number(options.port);
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Port must be 1024..65535.');
  if (options.context != null && (!Number.isInteger(Number(options.context)) || Number(options.context) < 4096)) throw new Error('Context must be an integer >=4096.');
  if (options.api && !['openai-responses', 'openai-completions'].includes(options.api)) throw new Error('Unsupported API protocol.');
  if (options['base-url']) validateLocalURL(options['base-url']);
  return options;
}

export function validateLocalURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP loopback model endpoint without credentials, query or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

export function resolveProjectWorkspace(value, runtime = RUNTIME) {
  const directory = fs.realpathSync(value);
  if (!fs.statSync(directory).isDirectory()) throw new Error('Workspace must be an existing directory.');
  const reserved = fs.existsSync(runtime) ? fs.realpathSync(runtime) : path.resolve(runtime);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(directory) === normalize(reserved) || normalize(directory).startsWith(normalize(reserved + path.sep))) {
    throw new Error('Select a real project outside the Harness runtime/test directory.');
  }
  return directory;
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Local endpoint returned HTTP ${response.status}.`);
  return response.json();
}

export async function discoverConnection(options, read = json) {
  if (options['base-url']) {
    if (!options.model || !options.context) throw new Error('Custom endpoints require --model and --context.');
    const baseURL = validateLocalURL(options['base-url']);
    const listed = await read(`${baseURL}/models`);
    if (!listed.data?.some(item => item.id === options.model)) throw new Error('Selected model is not listed by this endpoint.');
    return { baseURL, model: options.model, contextWindow: Number(options.context), api: options.api ?? 'openai-responses' };
  }
  let strata;
  try { strata = await read('http://127.0.0.1:8080/health'); } catch { }
  if (strata?.service === 'strata' && strata.model && strata.max_context && (!options.model || options.model === strata.model)) {
    return { baseURL: 'http://127.0.0.1:8080/v1', model: strata.model, contextWindow: Number(strata.max_context), api: options.api ?? 'openai-responses', images: strata.images === true };
  }
  const installed = (await read('http://127.0.0.1:11434/api/tags')).models?.map(item => item.name).filter(name => !name.endsWith(':cloud')) ?? [];
  const model = options.model ?? installed.find(name => /qwen.*(?:codex|27b)/i.test(name)) ?? installed[0];
  if (!model || !installed.includes(model)) throw new Error('No matching installed local model. Start Strata/Ollama or supply a custom loopback endpoint. No model was downloaded.');
  return { baseURL: 'http://127.0.0.1:11434/v1', model, contextWindow: Number(options.context ?? 32768), api: options.api ?? 'openai-completions' };
}

export function buildHarnessPatch(connection) {
  validateLocalURL(connection.baseURL);
  return [
    { id: 'llm-pi-ai', config: { providers: { 'ollamaforge-local': {
      displayName: 'OllamaForge Local', apiKeyEnv: LOCAL_KEY, api: connection.api,
      ...(connection.baseURL === 'http://127.0.0.1:8080/v1' ? { reasoning: 'off' } : {}),
      baseURL: connection.baseURL, streamIdleTimeoutMs: 600000,
      retryPolicy: { mode: 'normal', maxRetries: 1 },
      models: [{ id: connection.model, name: `${connection.model} (local)`, contextWindow: connection.contextWindow,
        maxTokens: Math.min(8192, Math.floor(connection.contextWindow / 4)), input: connection.images ? ['text', 'image'] : ['text'],
        reasoningEfforts: connection.baseURL === 'http://127.0.0.1:8080/v1' ? { off: 'none', high: 'high' } : false }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'ollamaforge-local', model: connection.model,
      ...(connection.baseURL === 'http://127.0.0.1:8080/v1' ? { reasoningEffort: 'off' } : {}) } },
    { insert: [
      { id: 'ollamaforge-computer-use', name: '@deepseek-ai/dsh-computer-use' },
      { id: 'ollamaforge-computer-driver', name: pathToFileURL(path.join(ROOT, 'deepseek-native-provider.mjs')).href },
      { id: 'ollamaforge-browser-use', name: '@deepseek-ai/dsh-browser-use' },
      { id: 'ollamaforge-chrome', name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp', config: { mode: 'launch', headless: false } },
    ] },
    { id: 'compaction-basic', name: pathToFileURL(path.join(ROOT, 'deepseek-compaction.mjs')).href, config: {
      modelPolicies: [{ provider: 'ollamaforge-local', model: connection.model, ...localCompactionPolicy(connection.contextWindow) }],
    } },
  ];
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(program)} failed (${result.status}): ${(result.stderr ?? '').slice(-3000)}`);
  return result;
}

function ensureInstalled() {
  if (DSH_PACKAGES.every(name => {
    const manifest = path.join(RUNTIME, 'node_modules', name, 'package.json');
    return fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest)).version === DSH_VERSION;
  }) && fs.existsSync(BIN)) return;
  fs.mkdirSync(RUNTIME, { recursive: true });
  const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(file => file && fs.existsSync(file));
  if (!npm) throw new Error('Cannot find npm-cli.js beside Node. Run this command through npm run connect:deepseek.');
  run(process.execPath, [npm, 'install', '--prefix', RUNTIME, '--no-audit', '--no-fund', '--save-exact', ...DSH_PACKAGES.map(name => `${name}@${DSH_VERSION}`)], { stdio: 'inherit' });
}

function environment() { return { ...process.env, DSH_HOME: HOME, [LOCAL_KEY]: 'local-endpoint-no-auth' }; }
function args(profile, extra = []) { return [BIN, profile, '--patch', PATCH, '--patch', path.join(RUNTIME, `${profile}-guard.patch.yml`), ...extra]; }
function windowsBackground(action = []) {
  return windowsScript('Start-DeepSeekHarness.ps1', action);
}
function windowsScript(script, action = []) {
  const env = { ...process.env };
  // A PowerShell 7 parent can otherwise hide Windows PowerShell 5.1 modules.
  delete env.PSModulePath;
  return run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, script), ...action], { env, stdio: 'inherit' });
}

export async function connectHarness(options) {
  const connection = await discoverConnection(options);
  ensureInstalled();
  fs.mkdirSync(HOME, { recursive: true });
  const previous = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS)) : {};
  const workspace = resolveProjectWorkspace(options.workspace ?? previous.workspace ?? ROOT);
  // JSON is valid YAML; no shared ~/.dsh profile, credential or Codex config is edited.
  const patch = JSON.stringify(buildHarnessPatch(connection), null, 2) + '\n';
  const sourceHash = createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url)))
    .update(fs.readFileSync(path.join(ROOT, 'deepseek-native-provider.mjs')))
    .update(fs.readFileSync(path.join(ROOT, 'deepseek-compaction.mjs')))
    .update(fs.readFileSync(path.join(ROOT, 'deepseek-migrate-session.mjs')))
    .update(fs.readFileSync(path.join(ROOT, 'deepseek-workspace.mjs'))).digest('hex');
  const settings = JSON.stringify({ ...connection, port: options.port, workspace, sourceHash }, null, 2) + '\n';
  if ((fs.existsSync(PATCH) && fs.readFileSync(PATCH, 'utf8') !== patch) ||
      (fs.existsSync(SETTINGS) && fs.readFileSync(SETTINGS, 'utf8') !== settings)) stopHarness();
  fs.writeFileSync(PATCH, patch);
  fs.writeFileSync(SETTINGS, settings);
  const require = createRequire(path.join(RUNTIME, 'package.json'));
  const yaml = require('js-yaml');
  class JsExpression { constructor(code) { this.code = code; } }
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: code => new JsExpression(code), instanceOf: JsExpression, represent: expression => expression.code,
  })]);
  // Compose user customizations first, then patch every preset's isolated
  // engine. No upstream package files or unrelated preset fields are edited.
  const webSource = run(process.execPath, [BIN, 'web', '--patch', PATCH, '--dump-config'], { env: environment(), maxBuffer: 8 * 1024 * 1024 }).stdout;
  const webTree = yaml.load(webSource, { schema });
  const replacement = JSON.parse(patch).find(row => row.id === 'compaction-basic');
  const presets = webTree.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
    .map(row => rewriteCompactionTree(row, replacement));
  if (!presets.some(row => row.config?.id === 'standard')) throw new Error('Cannot locate the standard Web preset; refusing incomplete context tuning.');
  for (const [profile, id, dependency] of [['headless', 'headless-runner', 'headlessStartup'], ['web', 'web-runtime', 'webStartup']]) {
    const guards = [
      { id, inject: [dependency, 'ollamaforgeNativeReady'] },
    ];
    if (profile === 'web') guards.push({ insert: [{ id: 'ollamaforge-workspace', name: pathToFileURL(path.join(ROOT, 'deepseek-workspace.mjs')).href, config: { directory: workspace } }] }, ...presets);
    const migration = path.join(RUNTIME, 'migration-request.json');
    if (profile === 'web' && fs.existsSync(migration)) {
      guards[0].inject.push('ollamaforgeMigrationReady');
      guards.push({ insert: [{ id: 'ollamaforge-session-migration', name: pathToFileURL(path.join(ROOT, 'deepseek-migrate-session.mjs')).href, config: { requestFile: migration } }] });
    }
    fs.writeFileSync(path.join(RUNTIME, `${profile}-guard.patch.yml`), yaml.dump(guards, { schema, noRefs: true, lineWidth: -1 }));
  }
  const composed = run(process.execPath, args('headless', ['--dump-config']), { env: environment(), maxBuffer: 8 * 1024 * 1024 }).stdout;
  if (!composed.includes('ollamaforge-local')) throw new Error('Harness did not compose the local provider.');
  console.log(`Connected DeepSeek Harness ${DSH_VERSION}: ${connection.model}, ${connection.contextWindow} tokens, ${connection.baseURL}`);
  return connection;
}

export function serveHarness() {
  if (!fs.existsSync(SETTINGS) || !fs.existsSync(PATCH)) throw new Error('Run npm run connect:deepseek first.');
  const { port } = JSON.parse(fs.readFileSync(SETTINGS));
  // Keep native stderr out of Windows PowerShell 5.1's NativeCommandError path.
  // These are UTF-8 logs; a fresh process also gets a fresh private startup URL.
  const stdout = fs.openSync(WEB_LOG, 'w');
  const stderr = fs.openSync(path.join(RUNTIME, 'web.stderr.log'), 'w');
  let child;
  try { child = spawn(process.execPath, args('web', ['--host', '127.0.0.1', '--port', String(port), '--no-open']), { env: environment(), stdio: ['ignore', stdout, stderr], windowsHide: true }); }
  finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  return child;
}

export async function launchHarness(options) {
  if (process.platform === 'win32') {
    windowsBackground();
  } else {
    const existing = ownedUnixProcess();
    if (!existing) {
    const stdout = fs.openSync(WEB_LOG, 'a');
    const stderr = fs.openSync(path.join(RUNTIME, 'web.stderr.log'), 'a');
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { cwd: ROOT, env: environment(), detached: true, stdio: ['ignore', stdout, stderr] });
      child.unref();
      fs.writeFileSync(path.join(RUNTIME, 'web.pid'), String(child.pid));
    } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    }
  }
  const url = `http://127.0.0.1:${options.port}`;
  for (let i = 0; i < 80; i++) {
    let readyURL;
    try {
      const privateURL = getHarnessWebURL(options.port);
      const entry = await fetch(privateURL, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      const cookie = entry.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(2000) });
      if (response.ok && /<html/i.test(await response.text())) {
        readyURL = privateURL;
      }
    } catch { }
    if (readyURL) {
      if (!options.noOpen) openBrowser(readyURL);
      console.log(`DeepSeek Harness ready: ${url} (local authentication enabled)`);
      return url;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Harness Web UI did not become ready; inspect .runtime/deepseek-harness/web.stderr.log.');
}

function ownedUnixProcess() {
  const file = path.join(RUNTIME, 'web.pid');
  if (!fs.existsSync(file)) return null;
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid Harness process receipt.');
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  if (result.status !== 0 && !result.stdout?.trim()) return null;
  if (!result.stdout?.includes(fileURLToPath(import.meta.url)) || !/\bserve\s*$/.test(result.stdout.trim())) throw new Error('Harness PID belongs to another process; refusing to signal it.');
  return pid;
}

export function stopHarness() {
  if (process.platform === 'win32') windowsBackground(['-Stop']);
  else {
    const pid = ownedUnixProcess();
    if (pid) process.kill(-pid, 'SIGTERM');
  }
}

export function getHarnessWebURL(port) {
  const bytes = fs.readFileSync(WEB_LOG);
  const log = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
  const matches = log.matchAll(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)\s*$/gm);
  const url = [...matches].at(-1)?.[1];
  if (!url || new URL(url).port !== String(port)) throw new Error('No matching private Harness startup URL yet.');
  return url;
}

function openBrowser(url) {
  if (process.platform === 'win32') run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]);
  else run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

export function testHarness() {
  const directory = fs.mkdtempSync(path.join(RUNTIME, 'live-test-'));
  const marker = `HARNESS_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(path.join(directory, 'read-me.txt'), `The test marker is ${marker}.\n`);
  const result = run(process.execPath, args('headless', ['--json', 'Read read-me.txt using the file read tool. Write its exact contents into result.txt using the file write tool, preserving the source file\'s single trailing LF newline. Then reply with the test marker you read.']), {
    cwd: directory, env: { ...environment(), DSH_HOME: path.join(directory, '.harness-home') }, timeout: 600000, maxBuffer: 4 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(directory, 'events.jsonl'), result.stdout);
  fs.writeFileSync(path.join(directory, 'stderr.log'), result.stderr);
  const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const calls = events.filter(event => event.type === 'tool_call');
  const final = events.findLast(event => event.type === 'final');
  const output = path.join(directory, 'result.txt');
  if (!calls.some(call => call.tool === 'read') || !calls.some(call => call.tool === 'write') || !fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== fs.readFileSync(path.join(directory, 'read-me.txt'), 'utf8') || !final?.text?.includes(marker)) {
    throw new Error(`Harness failed the real read/write round-trip. Inspect ${directory}`);
  }
  console.log(`PASS: official DeepSeek Harness + local model read a fresh marker, wrote result.txt and replied with it. Evidence: ${directory}`);
}

export function runHarnessTask(task, cwd) {
  return new Promise((resolve, reject) => execFile(process.execPath, args('headless', ['--json', task]), {
    cwd, env: { ...environment(), DSH_HOME: path.join(cwd, '.harness-home') }, windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    fs.writeFileSync(path.join(cwd, 'events.jsonl'), stdout);
    fs.writeFileSync(path.join(cwd, 'stderr.log'), stderr);
    if (error) reject(new Error(`Harness task failed: ${stderr.slice(-1800)}. Evidence: ${cwd}`));
    else resolve(stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)));
  }));
}

export function auditControlEvents(events, id, receipts) {
  const calls = events.filter(event => event.type === 'tool_call');
  const nativeClick = calls.some(call => /cua_driver_native__click$/.test(call.tool));
  const nativeType = calls.some(call => /cua_driver_native__type_text$/.test(call.tool) && call.input?.text === `NATIVE_${id}`);
  const chromeClick = calls.some(call => /chrome-devtools-mcp__click$/.test(call.tool));
  const substituted = calls.some(call => /chrome-devtools-mcp__fill$/.test(call.tool) && call.input?.value?.includes(`NATIVE_${id}`));
  const unexpected = calls.some(call => !/^(?:cua_driver_native__|mcp__chrome-devtools-mcp__)/.test(call.tool) || /__(?:evaluate_script|navigate_page)$/.test(call.tool));
  const final = events.findLast(event => event.type === 'final');
  return { nativeClick, nativeType, chromeClick, substituted, unexpected,
    allPassed: !!(receipts.native?.passed && receipts.chrome?.passed && nativeClick && nativeType && chromeClick && !substituted && !unexpected && final?.text?.includes('NATIVE_AND_CHROME_PASS')) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseHarnessArgs(process.argv.slice(2));
    if (options.command === 'repair-workspace') {
      if (process.platform !== 'win32') throw new Error('The directory-permission repair is for Windows only.');
      const saved = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS)) : {};
      const workspace = resolveProjectWorkspace(options.workspace ?? saved.workspace ?? ROOT);
      windowsScript('Repair-DeepSeekWorkspace.ps1', ['-Path', workspace, ...(options.apply ? ['-Apply'] : []), '-BackupDirectory', path.join(RUNTIME, 'recovery', 'workspace-permissions')]);
    } else if (options.command === 'serve') serveHarness();
    else if (options.command === 'stop') {
      stopHarness();
    } else {
      await connectHarness(options);
      if (options.command === 'launch') await launchHarness(options);
      if (options.command === 'test') testHarness();
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
