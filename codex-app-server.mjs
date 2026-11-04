import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

export function resolveCodexEntrypoint(results, platform = process.platform) {
  const binary = results.find(file => platform !== 'win32' || /\.exe$/i.test(file));
  if (binary) return binary;
  // npm on Windows exposes codex.cmd, which cannot be spawned without a shell.
  // Read the installed official package's bin declaration and use Node directly.
  for (const shim of results) {
    const root = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex');
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.codex;
      if (typeof bin !== 'string') continue;
      const file = path.resolve(root, bin);
      if (file.startsWith(path.resolve(root) + path.sep) && /\.(?:[cm]?js|exe)$/i.test(file) && fs.existsSync(file)) return file;
    } catch { }
  }
  throw new Error('Install Codex CLI or set OLLAMAFORGE_CODEX_BIN to its executable or official Node entrypoint.');
}

export function findCodex(env = process.env, platform = process.platform) {
  if (env.OLLAMAFORGE_CODEX_BIN) {
    if (!fs.existsSync(env.OLLAMAFORGE_CODEX_BIN)) throw new Error('OLLAMAFORGE_CODEX_BIN does not exist.');
    return env.OLLAMAFORGE_CODEX_BIN;
  }
  const command = platform === 'win32' ? 'where.exe' : 'which';
  const results = execFileSync(command, ['codex'], { encoding: 'utf8', windowsHide: true, env }).trim().split(/\r?\n/);
  return resolveCodexEntrypoint(results, platform);
}

// Official stdio protocol only: no app bundle, database, auth or provider patches.
export async function connectCodex({ executable = findCodex(), env = process.env, timeoutMs = 120000, spawnProcess = spawn } = {}) {
  const nodeEntry = /\.[cm]?js$/i.test(executable);
  const child = spawnProcess(nodeEntry ? process.execPath : executable, [...(nodeEntry ? [executable] : []), 'app-server', '--listen', 'stdio://'], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0, closed = false;
  const fail = error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.on('error', error => { closed = true; fail(error); });
  child.on('exit', code => { closed = true; fail(new Error(`Codex app-server exited (${code}).`)); });
  // Drain diagnostics without leaking private paths, auth or conversation text.
  child.stderr.on('data', () => {});
  child.stdin.on('error', error => fail(error));
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { fail(new Error('Invalid app-server JSON.')); return; }
    const p = pending.get(message.id);
    if (p && !message.method) {
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) {
        const error = new Error(message.error.message); error.code = message.error.code; error.data = message.error.data; p.reject(error);
      } else p.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      // This client does maintenance, never agent execution or automatic approval.
      send({ id: message.id, error: { code: -32601, message: 'Interactive execution is not supported by this maintenance client.' } });
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Codex app-server is closed.')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const close = async () => {
    if (closed) return;
    closed = true; fail(new Error('Maintenance client closed.'));
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    lines.close();
  };
  try {
    await request('initialize', { clientInfo: { name: 'ollamaforge_recovery', title: 'OllamaForge Thread Recovery', version: '0.1.0' } });
    send({ method: 'initialized', params: {} });
    return { request, close };
  } catch (error) { await close(); throw error; }
}
