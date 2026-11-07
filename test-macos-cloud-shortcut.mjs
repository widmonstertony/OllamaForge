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
  assert.match(content, /macos[\\/]local-codex\.mjs' --open/);
  assert.doesNotMatch(content, /osascript|to quit|ollama launch/);
  console.log('PASS: macOS native cloud shortcut opens without a forced restart.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
