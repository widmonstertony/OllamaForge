#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaultLauncherPath = path.join(root, 'macos', 'native-codex.mjs');
const shortcutName = '云端 Codex.command';

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function findCodexApplicationName() {
  const candidates = [
    { name: 'Codex', paths: ['/Applications/Codex.app', path.join(os.homedir(), 'Applications', 'Codex.app')] },
    { name: 'ChatGPT', paths: ['/Applications/ChatGPT.app', path.join(os.homedir(), 'Applications', 'ChatGPT.app')] },
  ];
  const application = candidates.find((candidate) => candidate.paths.some((candidatePath) => fs.existsSync(candidatePath)));
  if (!application) {
    throw new Error('Codex.app or ChatGPT.app was not found in /Applications or ~/Applications.');
  }
  return application.name;
}

export function buildCloudShortcut({ nodePath, launcherPath }) {
  return `#!/bin/zsh\nexec ${shellQuote(nodePath)} ${shellQuote(launcherPath)} --open\n`;
}

export function installCloudShortcut({
  desktopDir = process.env.OLLAMA_FORGE_DESKTOP || path.join(os.homedir(), 'Desktop'),
  nodePath = process.execPath,
  launcherPath = defaultLauncherPath,
  applicationName = findCodexApplicationName(),
} = {}) {
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`Missing macOS Codex launcher: ${launcherPath}`);
  }
  fs.mkdirSync(desktopDir, { recursive: true });
  const shortcutPath = path.join(desktopDir, shortcutName);
  const temporaryPath = `${shortcutPath}.tmp-${process.pid}`;
  const content = buildCloudShortcut({ nodePath, launcherPath, applicationName });
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o700 });
  fs.renameSync(temporaryPath, shortcutPath);
  fs.chmodSync(shortcutPath, 0o755);
  return shortcutPath;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const shortcutPath = installCloudShortcut();
  console.log(`Ready: ${shortcutPath}`);
  console.log('Double-click it to restore the cloud-default plus local-Ollama model catalog and restart Codex.');
}
