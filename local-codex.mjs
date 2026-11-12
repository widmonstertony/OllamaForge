import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findCodex } from './codex-app-server.mjs';
import { LOCAL_PROFILE } from './native-model-isolation.mjs';

const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
if (!fs.existsSync(path.join(home, LOCAL_PROFILE + '.config.toml'))) throw new Error('Run npm run setup to prepare the isolated local profile first.');
const executable = findCodex();
const nodeEntry = /\.[cm]?js$/i.test(executable);
const args = process.argv.slice(2);
// Non-interactive exec must see EOF unless the caller explicitly requests stdin
// with '-'. An inherited automation pipe can otherwise stay open indefinitely.
const stdin = !process.stdin.isTTY && args.some(arg => arg === 'exec' || arg === 'e') && !args.includes('-') ? 'ignore' : 'inherit';
const child = spawn(nodeEntry ? process.execPath : executable,
  [...(nodeEntry ? [executable] : []), '--no-daemon', '--profile', LOCAL_PROFILE, ...args], { stdio: [stdin, 'inherit', 'inherit'], windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
