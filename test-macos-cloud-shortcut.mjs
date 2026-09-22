import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCloudShortcut } from './macos/install-cloud-shortcut.mjs';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'local-codex-shortcut-'));
const desktop = path.join(work, 'Desktop Folder');
const launcher = path.join(work, 'repo with spaces', 'macos', 'local-codex.mjs');
fs.mkdirSync(path.dirname(launcher), { recursive: true });
fs.writeFileSync(launcher, '#!/usr/bin/env node\n');

try {
  const shortcut = installCloudShortcut({
    desktopDir: desktop,
    nodePath: '/opt/node with spaces/bin/node',
    launcherPath: launcher,
    applicationName: 'Codex',
  });
  const content = fs.readFileSync(shortcut, 'utf8');
  assert.equal(path.basename(shortcut), '云端 Codex.command');
  if (process.platform !== 'win32') assert.equal(fs.statSync(shortcut).mode & 0o777, 0o755);
  assert.match(content, /^#!\/bin\/zsh\n/);
  assert.match(content, /'\/opt\/node with spaces\/bin\/node'/);
  assert.match(content, /'[^'\n]*repo with spaces[\\/]macos[\\/]local-codex\.mjs'; then/);
  assert.match(content, /tell application "Codex" to quit/);
  assert.match(content, /open -a 'Codex'/);
  assert.match(content, /恢复云端默认，并保留 Ollama 本地模型/);
  assert.match(content, /正在运行的 Codex 任务会被中断/);
  console.log('PASS: macOS cloud-default plus local-model shortcut installation.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
