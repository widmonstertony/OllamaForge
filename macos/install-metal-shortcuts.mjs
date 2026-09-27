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
  return `#!/bin/zsh\nset -u\n${shellQuote(process.execPath)} ${shellQuote(launcher)} ${command}\nresult=$?\nif (( result == 0 )); then\n  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null 2>&1 || true\n  /bin/sleep 2\n  /usr/bin/open -a ChatGPT\nelse\n  printf '\\n切换失败。按回车关闭窗口…'\n  read -r answer\nfi\nexit "$result"\n`;
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
  return installed;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  for (const target of installMetalShortcuts()) console.log(`Ready: ${target}`);
}
