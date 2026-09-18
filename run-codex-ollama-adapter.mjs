import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = process.env.CODEX_LOCAL_RUNTIME_DIR ??
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'CodexOllama')
    : path.join(os.homedir(), '.local', 'state', 'codex-ollama-agent'));
mkdirSync(runtimeDir, { recursive: true });
const stdoutPath = path.join(runtimeDir, 'codex-ollama-adapter.stdout.log');
const stderrPath = path.join(runtimeDir, 'codex-ollama-adapter.stderr.log');
const adapterPath = fileURLToPath(new URL('./codex-ollama-adapter.mjs', import.meta.url));
let child;
let closing = false;
let crashCount = 0;

function launch() {
  if (closing) return;
  const startedAt = Date.now();
  const stdout = openSync(stdoutPath, 'a');
  const stderr = openSync(stderrPath, 'a');
  child = spawn(process.execPath, [adapterPath], {
    env: {
      ...process.env,
      CODEX_OLLAMA_ADAPTER_PORT: process.env.CODEX_OLLAMA_ADAPTER_PORT ?? '11435',
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    },
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
  });
  closeSync(stdout);
  closeSync(stderr);
  child.once('error', (error) => {
    appendFileSync(stderrPath, `${new Date().toISOString()} Adapter launch failed: ${error.message}\n`);
  });
  child.once('exit', (code, signal) => {
    if (closing) return;
    crashCount = Date.now() - startedAt > 30_000 ? 1 : crashCount + 1;
    const delay = Math.min(1000 * 2 ** Math.min(crashCount - 1, 5), 30_000);
    appendFileSync(stderrPath, `${new Date().toISOString()} Adapter exited code=${code} signal=${signal}; restarting in ${delay}ms\n`);
    setTimeout(launch, delay);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closing = true;
    child?.kill('SIGTERM');
  });
}
launch();
