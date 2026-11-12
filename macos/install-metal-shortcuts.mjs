#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = path.join(root, 'macos', 'metal-codex.mjs');

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shortcut(command) {
  const node = process.execPath;
  return `#!/bin/zsh\nset -u\nexport PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"\n${shellQuote(node)} ${shellQuote(launcher)} ${command} --launch\nresult=$?\nif (( result != 0 )); then\n  printf '\\n切换失败。按回车关闭窗口…'\n  read -r answer\nfi\nexit "$result"\n`;
}

export function installMetalShortcuts(desktopDir = path.join(os.homedir(), 'Desktop')) {
  fs.mkdirSync(desktopDir, { recursive: true });
  const installed = [];
  for (const [name, command] of [['本地 Codex.command', 'local'], ['云端 Codex.command', 'cloud']]) {
    const target = path.join(desktopDir, name);
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, shortcut(command), { encoding: 'utf8', mode: 0o700 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o755);
    installed.push(target);
  }
  const oldDirect = path.join(desktopDir, '本地 Codex（Ollama 直连）.command');
  if (fs.existsSync(oldDirect)) {
    fs.writeFileSync(oldDirect, shortcut('hybrid'), {encoding:'utf8', mode:0o755});
    fs.chmodSync(oldDirect, 0o755);
    installed.push(oldDirect);
  }
  return installed;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  for (const target of installMetalShortcuts()) console.log(`Ready: ${target}`);
}
