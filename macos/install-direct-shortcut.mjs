#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shortcutName = '本地 Codex（Ollama 直连）.command';

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function findCodexApplicationName() {
  const candidates = [
    { name: 'Codex', paths: ['/Applications/Codex.app', path.join(os.homedir(), 'Applications', 'Codex.app')] },
    { name: 'ChatGPT', paths: ['/Applications/ChatGPT.app', path.join(os.homedir(), 'Applications', 'ChatGPT.app')] },
  ];
  const application = candidates.find((candidate) => candidate.paths.some((candidatePath) => fs.existsSync(candidatePath)));
  if (!application) throw new Error('Codex.app or ChatGPT.app was not found in /Applications or ~/Applications.');
  return application.name;
}

export function buildDirectShortcut(applicationName) {
  return `#!/bin/zsh\nexec /usr/bin/open -a ${shellQuote(applicationName)}\n`;
}

export function installDirectShortcut({
  desktopDir = process.env.OLLAMA_FORGE_DESKTOP || path.join(os.homedir(), 'Desktop'),
  applicationName = findCodexApplicationName(),
} = {}) {
  fs.mkdirSync(desktopDir, { recursive: true });
  const shortcutPath = path.join(desktopDir, shortcutName);
  const temporaryPath = `${shortcutPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, buildDirectShortcut(applicationName), { encoding: 'utf8', mode: 0o700 });
  fs.renameSync(temporaryPath, shortcutPath);
  fs.chmodSync(shortcutPath, 0o755);
  return shortcutPath;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) console.log(`Ready: ${installDirectShortcut()}`);
