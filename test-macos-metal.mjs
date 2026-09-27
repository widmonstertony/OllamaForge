import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'local-codex-metal-'));
const originalModelPath = process.env.LEETTUTOR_METAL_MODEL_PATH;
const originalServerPath = process.env.LEETTUTOR_METAL_SERVER;

try {
  const fakeModel = path.join(work, 'model.gguf');
  const fakeServer = path.join(work, 'llama-server');
  fs.writeFileSync(fakeModel, 'GGUF');
  fs.writeFileSync(fakeServer, '#!/bin/sh\n');
  fs.chmodSync(fakeServer, 0o755);
  process.env.LEETTUTOR_METAL_MODEL_PATH = fakeModel;
  process.env.LEETTUTOR_METAL_SERVER = fakeServer;

  const runtime = await import('./macos/metal-codex.mjs');
  const shortcuts = await import('./macos/install-metal-shortcuts.mjs');
  assert.equal(runtime.findMetalServer(), fakeServer);
  assert.equal(runtime.resolveOllamaModel(), fakeModel);
  assert.equal(runtime.modelAlias, 'qwen3.5-codex-metal-8k');
  assert.equal(runtime.contextWindow, 8192);

  const fakeGlobalState = path.join(work, '.codex-global-state.json');
  fs.writeFileSync(fakeGlobalState, JSON.stringify({
    'electron-persisted-atom-state': {
      'composer-recent-model-configurations-v1': [
        { model: 'qwen3.5-codex-metal-8k', reasoningEffort: 'none' },
        { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      ],
    },
  }));
  assert.deepEqual(runtime.resolveRecentCloudSelection(fakeGlobalState), {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  });

  const installed = shortcuts.installMetalShortcuts(work);
  assert.equal(installed.length, 2);
  const local = fs.readFileSync(path.join(work, '本地 Codex.command'), 'utf8');
  const cloud = fs.readFileSync(path.join(work, '云端 Codex.command'), 'utf8');
  assert.match(local, /metal-codex\.mjs' local/);
  assert.match(cloud, /metal-codex\.mjs' cloud/);
  assert.doesNotMatch(local, /display dialog|yes/i);
  assert.match(local, /按回车关闭窗口/);
  console.log('PASS: Metal runtime discovery and direct desktop shortcuts.');
} finally {
  if (originalModelPath === undefined) delete process.env.LEETTUTOR_METAL_MODEL_PATH;
  else process.env.LEETTUTOR_METAL_MODEL_PATH = originalModelPath;
  if (originalServerPath === undefined) delete process.env.LEETTUTOR_METAL_SERVER;
  else process.env.LEETTUTOR_METAL_SERVER = originalServerPath;
  fs.rmSync(work, { recursive: true, force: true });
}
