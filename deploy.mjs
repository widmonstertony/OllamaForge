#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { installDirectShortcut } from './macos/install-direct-shortcut.mjs';
import { resolveOllamaExecutable, runSetup } from './setup.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export const TARGET = Object.freeze({
  choice: '27b-iq4-xs',
  alias: 'qwen3.8-codex-iq4-xs-64k',
  longContextAlias: 'qwen3.8-codex-iq4-xs-110k',
  relativePath: path.join('models', 'Qwen3.8-27B-IQ4_XS-3.84bpw.gguf'),
  url: 'https://huggingface.co/byteshape/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-IQ4_XS-3.84bpw.gguf?download=true',
  bytes: 13_083_052_416,
  sha256: '89434f23dc89c5f990894e3fe9fdad19d88c370f0d3638a176f29933f218b78b',
});

export const OLLAMA_ENV = Object.freeze({
  OLLAMA_FLASH_ATTENTION: '1',
  OLLAMA_KV_CACHE_TYPE: 'q4_0',
  OLLAMA_CONTEXT_LENGTH: '110000',
  OLLAMA_NUM_PARALLEL: '1',
});

function run(command, args, { allowFailure = false, stdio = 'inherit', env = process.env } = {}) {
  const result = spawnSync(command, args, { stdio, env, encoding: stdio === 'pipe' ? 'utf8' : undefined });
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const details = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed${details ? `: ${details}` : ` with status ${result.status}`}.`);
  }
  return result;
}

function findCommand(name, platform = process.platform) {
  const result = spawnSync(platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

export async function verifyTargetFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  if (fs.statSync(filePath).size !== TARGET.bytes) return false;
  return (await sha256File(filePath)) === TARGET.sha256;
}

export async function ensureTargetFile({
  targetPath = path.join(rootDir, TARGET.relativePath),
  curl = findCommand(process.platform === 'win32' ? 'curl.exe' : 'curl'),
  availableBytes = () => {
    const stats = fs.statfsSync(path.dirname(targetPath));
    return Number(stats.bavail) * Number(stats.bsize);
  },
  runCommand = run,
} = {}) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (await verifyTargetFile(targetPath)) {
    console.log(`Model already verified: ${targetPath}`);
    return targetPath;
  }
  if (fs.existsSync(targetPath)) {
    const invalidPath = `${targetPath}.invalid-${Date.now()}`;
    fs.renameSync(targetPath, invalidPath);
    console.warn(`Existing model failed verification and was preserved at: ${invalidPath}`);
  }
  if (!curl) throw new Error('curl was not found. Install curl or use a current Windows/macOS release.');
  const partialPath = `${targetPath}.partial`;
  if (fs.existsSync(partialPath) && fs.statSync(partialPath).size >= TARGET.bytes && !(await verifyTargetFile(partialPath))) {
    const invalidPartial = `${partialPath}.invalid-${Date.now()}`;
    fs.renameSync(partialPath, invalidPartial);
    console.warn(`Invalid completed download was preserved at: ${invalidPartial}`);
  }
  const partialBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
  const requiredBytes = Math.max(0, TARGET.bytes - partialBytes) + (2 * 1024 ** 3);
  if (availableBytes() < requiredBytes) {
    throw new Error(`Not enough disk space for the IQ4_XS model. At least ${(requiredBytes / (1024 ** 3)).toFixed(1)} GiB free is required.`);
  }
  console.log(`Downloading ${(TARGET.bytes / (1024 ** 3)).toFixed(2)} GiB IQ4_XS model (resume enabled)...`);
  runCommand(curl, [
    '--location', '--fail', '--retry', '5', '--retry-delay', '5', '--connect-timeout', '30',
    '--continue-at', '-', '--output', partialPath, TARGET.url,
  ]);
  if (!(await verifyTargetFile(partialPath))) {
    throw new Error(`Downloaded model failed size or SHA-256 verification: ${partialPath}`);
  }
  fs.renameSync(partialPath, targetPath);
  console.log(`Model verified: ${TARGET.sha256}`);
  return targetPath;
}

function persistOllamaEnvironment(platform = process.platform) {
  for (const [name, value] of Object.entries(OLLAMA_ENV)) process.env[name] = value;
  if (platform === 'win32') {
    for (const [name, value] of Object.entries(OLLAMA_ENV)) {
      run('reg.exe', ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'pipe' });
    }
  } else if (platform === 'darwin') {
    for (const [name, value] of Object.entries(OLLAMA_ENV)) run('launchctl', ['setenv', name, value], { stdio: 'pipe' });
  } else {
    throw new Error(`Unsupported platform: ${platform}. Codex desktop deployment supports Windows and macOS.`);
  }
}

function startDetached(command, args = []) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
}

async function restartOllama(ollama, platform = process.platform) {
  if (platform === 'win32') {
    run('taskkill.exe', ['/F', '/IM', 'ollama app.exe'], { allowFailure: true, stdio: 'pipe' });
    run('taskkill.exe', ['/F', '/IM', 'ollama.exe'], { allowFailure: true, stdio: 'pipe' });
    await sleep(1500);
    const app = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama app.exe');
    if (app && fs.existsSync(app)) startDetached(app);
    else startDetached(ollama, ['serve']);
  } else {
    run('osascript', ['-e', 'tell application "Ollama" to quit'], { allowFailure: true, stdio: 'pipe' });
    await sleep(1500);
    const opened = run('open', ['-a', 'Ollama'], { allowFailure: true, stdio: 'pipe' });
    if (opened.status !== 0) startDetached(ollama, ['serve']);
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.json();
    } catch {}
    await sleep(500);
  }
  throw new Error('Ollama did not become ready on 127.0.0.1:11434 within 60 seconds.');
}

function installDesktopShortcut(platform = process.platform) {
  if (platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(rootDir, 'Install-WindowsShortcuts.ps1')]);
    return path.join(os.homedir(), 'Desktop', '本地 Codex（GUI）.lnk');
  }
  return installDirectShortcut();
}

function responseText(payload) {
  return (payload.output ?? [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item?.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('');
}

function codexAuthHeaders() {
  const authPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const token = auth.tokens?.access_token || auth.OPENAI_API_KEY;
  if (!token) throw new Error(`Codex authentication token not found in ${authPath}.`);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (auth.tokens?.account_id) headers['chatgpt-account-id'] = auth.tokens.account_id;
  return headers;
}

async function smokeTest() {
  const started = Date.now();
  const url = 'http://127.0.0.1:11434/api/codex/v1/responses?client_version=0.0.0';
  const headers = codexAuthHeaders();
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: TARGET.alias,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Follow the user request exactly.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Setup message.' }] },
        { role: 'system', content: [{ type: 'input_text', text: 'This second system message verifies Codex compatibility.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Reply with PING only.' }] },
      ],
      reasoning: { effort: 'none' },
      max_output_tokens: 64,
      stream: false,
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const payload = await response.json();
  const output = responseText(payload).trim();
  if (!response.ok || output !== 'PING') {
    throw new Error(`Direct Codex smoke test failed (${response.status}): ${JSON.stringify(payload).slice(0, 1000)}`);
  }
  const toolResponse = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: TARGET.alias,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Call the requested function.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Call ping once with value ok.' }] },
      ],
      tools: [{
        type: 'function', name: 'ping', description: 'Return a test value.', strict: true,
        parameters: {
          type: 'object', properties: { value: { type: 'string' } },
          required: ['value'], additionalProperties: false,
        },
      }],
      tool_choice: { type: 'function', name: 'ping' },
      parallel_tool_calls: false,
      reasoning: { effort: 'none' },
      max_output_tokens: 128,
      stream: false,
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const toolPayload = await toolResponse.json();
  const call = toolPayload.output?.find((item) => item.type === 'function_call');
  if (!toolResponse.ok || call?.name !== 'ping' || JSON.parse(call.arguments ?? '{}').value !== 'ok') {
    throw new Error(`Codex tool smoke test failed (${toolResponse.status}): ${JSON.stringify(toolPayload).slice(0, 1000)}`);
  }
  const autonomousResponse = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: TARGET.alias,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Inspect free disk space. Use exec_command now; do not only describe a plan.',
        }],
      }],
      tools: [{
        type: 'function', name: 'exec_command', description: 'Run a PowerShell command.', strict: true,
        parameters: {
          type: 'object', properties: { cmd: { type: 'string' } },
          required: ['cmd'], additionalProperties: false,
        },
      }],
      parallel_tool_calls: false,
      reasoning: { effort: 'none' },
      max_output_tokens: 512,
      stream: false,
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const autonomousPayload = await autonomousResponse.json();
  const autonomousCall = autonomousPayload.output?.find((item) => item.type === 'function_call');
  if (!autonomousResponse.ok || autonomousCall?.name !== 'exec_command' || !JSON.parse(autonomousCall.arguments ?? '{}').cmd) {
    throw new Error(`Codex autonomous tool smoke test failed (${autonomousResponse.status}): ${JSON.stringify(autonomousPayload).slice(0, 1000)}`);
  }
  return { output, tool: call.name, autonomousTool: autonomousCall.name, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function deploy({ skipSmoke = false } = {}) {
  if (!['win32', 'darwin'].includes(process.platform)) {
    throw new Error(`Unsupported platform: ${process.platform}. Codex desktop deployment supports Windows and macOS.`);
  }
  const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  if (!fs.existsSync(configPath)) throw new Error(`Codex config not found: ${configPath}. Open Codex once, then rerun this command.`);
  const ollama = resolveOllamaExecutable();
  await ensureTargetFile();
  persistOllamaEnvironment();
  const version = await restartOllama(ollama);
  const setup = runSetup({ model: TARGET.choice, noPull: true }, { ollamaExecutable: ollama });
  const shortcut = installDesktopShortcut();
  const smoke = skipSmoke ? null : await smokeTest();
  return { version: version.version, setup, shortcut, smoke };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  try {
    const unknown = process.argv.slice(2).filter((argument) => argument !== '--skip-smoke');
    if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')}`);
    const result = await deploy({ skipSmoke: process.argv.includes('--skip-smoke') });
    console.log('\nDeployment complete.');
    console.log(`Ollama: ${result.version}`);
    console.log(`Daily model: ${TARGET.alias}`);
    console.log(`Long-context model: ${TARGET.longContextAlias}`);
    console.log('Codex endpoint: http://127.0.0.1:11434/api/codex/v1');
    console.log(`Desktop shortcut: ${result.shortcut}`);
    if (result.smoke) console.log(`Smoke test: ${result.smoke.output} + ${result.smoke.tool} + autonomous ${result.smoke.autonomousTool} (${result.smoke.seconds}s)`);
    console.log('Quit and reopen Codex. Use qwen3.8-codex-iq4-xs-64k daily; select qwen3.8-codex-iq4-xs-110k only for very large tasks.');
  } catch (error) {
    console.error(`Deployment failed: ${error.message}`);
    process.exitCode = 1;
  }
}
