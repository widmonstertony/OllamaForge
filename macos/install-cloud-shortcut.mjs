#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaultLauncherPath = path.join(root, 'macos', 'ollama-chatgpt-hybrid.mjs');
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

export function buildCloudShortcut({ nodePath, launcherPath, applicationName }) {
  const quotedNode = shellQuote(nodePath);
  const quotedLauncher = shellQuote(launcherPath);
  const quotedApplicationName = shellQuote(applicationName);
  const escapedAppleScriptApplicationName = applicationName.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

  return `#!/bin/zsh
set -u

if ! /usr/bin/osascript \\
  -e 'display dialog "恢复云端默认，并保留 Ollama 本地模型？正在运行的 Codex 任务会被中断。" buttons {"取消", "恢复混合模式"} default button "恢复混合模式" cancel button "取消" with icon caution' \\
  >/dev/null; then
  exit 0
fi

if ! ${quotedNode} ${quotedLauncher}; then
  /usr/bin/osascript \\
    -e 'display dialog "无法恢复云端 + 本地混合模式。请检查 Ollama 是否运行，以及云端配置备份是否存在。" buttons {"好"} default button "好" with icon stop' \\
    >/dev/null 2>&1 || true
  exit 1
fi

/usr/bin/osascript -e 'tell application "${escapedAppleScriptApplicationName}" to quit' >/dev/null 2>&1 || true
for attempt in {1..50}; do
  if ! /usr/bin/pgrep -x ${quotedApplicationName} >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 0.1
done

/usr/bin/open -a ${quotedApplicationName}
/usr/bin/osascript \\
  -e 'display notification "已恢复云端默认，并保留 Ollama 本地模型。" with title "Codex"' \\
  >/dev/null 2>&1 || true
`;
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
