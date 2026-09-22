import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OLLAMA_ENV, TARGET, verifyTargetFile } from './deploy.mjs';
import { buildDirectShortcut, installDirectShortcut } from './macos/install-direct-shortcut.mjs';

assert.equal(TARGET.bytes, 13_083_052_416);
assert.equal(TARGET.sha256, '89434f23dc89c5f990894e3fe9fdad19d88c370f0d3638a176f29933f218b78b');
assert.equal(OLLAMA_ENV.OLLAMA_KV_CACHE_TYPE, 'q4_0');
assert.equal(OLLAMA_ENV.OLLAMA_CONTEXT_LENGTH, '110000');
assert.equal(OLLAMA_ENV.OLLAMA_NUM_PARALLEL, '1');
assert.match(buildDirectShortcut('Codex'), /open -a 'Codex'/);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamaforge-deploy-'));
try {
  const invalidModel = path.join(work, 'model.gguf');
  fs.writeFileSync(invalidModel, 'not a model');
  assert.equal(await verifyTargetFile(invalidModel), false);

  const shortcut = installDirectShortcut({ desktopDir: work, applicationName: 'Codex' });
  assert.equal(path.basename(shortcut), '本地 Codex（Ollama 直连）.command');
  if (process.platform !== 'win32') assert.equal(fs.statSync(shortcut).mode & 0o777, 0o755);

  const windowsInstaller = fs.readFileSync(new URL('./Install-WindowsShortcuts.ps1', import.meta.url), 'utf8');
  assert.match(windowsInstaller, /127\.0\.0\.1|11434/);
  assert.match(windowsInstaller, /shell:AppsFolder\\OpenAI\.Codex/);
  assert.doesNotMatch(windowsInstaller, /Launch-Codex-GUI\.ps1/);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log('PASS: one-command deployment constants, integrity checks, and direct desktop shortcuts.');
