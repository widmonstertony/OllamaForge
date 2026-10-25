import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { prepareDesktopProbe, readDesktopProbe, verifyNativeProbe, startChromeProbe, verifyChromeProbe, verifyDesktopProbe } from './desktop-smoke.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'of-desktop-unit-'));
let server;
try {
  const work = path.join(root, 'User spaces 用户');
  const probe = prepareDesktopProbe(work);
  assert.ok(!fs.readFileSync(probe.nativeFile, 'utf8').includes(probe.markerA));
  assert.equal(readDesktopProbe(probe.manifestPath).id, probe.id);
  assert.throws(() => verifyNativeProbe(probe.manifestPath, 1), /not been verified/);
  assert.throws(() => verifyChromeProbe(probe.manifestPath), /not been verified/);
  assert.throws(() => verifyDesktopProbe(probe.manifestPath));
  // These are validator unit fixtures, not evidence of real GUI operations.
  fs.appendFileSync(probe.nativeFile, probe.markerA);
  verifyNativeProbe(probe.manifestPath, 1);
  assert.throws(() => verifyNativeProbe(probe.manifestPath, 2), /second save/);
  fs.appendFileSync(probe.nativeFile, probe.markerB);
  verifyNativeProbe(probe.manifestPath, 2);
  assert.throws(() => verifyNativeProbe(probe.manifestPath, 1), /round 1/);
  server = startChromeProbe(probe.manifestPath);
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.match(await fetch(url).then(r => r.text()), /Verify browser input/);
  const wrong = await fetch(`${url}/verify`, { method: 'POST', body: JSON.stringify({ marker: 'wrong' }) });
  assert.equal(wrong.status, 400);
  assert.throws(() => verifyChromeProbe(probe.manifestPath), /not been verified/);
  const correct = await fetch(`${url}/verify`, { method: 'POST', body: JSON.stringify({ marker: probe.id }) });
  assert.equal(correct.status, 200);
  assert.equal(verifyChromeProbe(probe.manifestPath).passed, true);
  assert.throws(() => verifyDesktopProbe(probe.manifestPath), /All three/);
  fs.writeFileSync(path.join(probe.directory, 'github.json'), JSON.stringify({ id: probe.id, passed: true, commit: 'unit-fixture-only' }));
  assert.equal(verifyDesktopProbe(probe.manifestPath).allPassed, true);
  fs.appendFileSync(probe.nativeFile, 'changed afterwards');
  assert.throws(() => verifyDesktopProbe(probe.manifestPath), /changed after/);
  const invalid = JSON.parse(fs.readFileSync(probe.manifestPath, 'utf8'));
  invalid.nativeFile = path.join(root, 'outside.txt');
  fs.writeFileSync(probe.manifestPath, JSON.stringify(invalid));
  assert.throws(() => readDesktopProbe(probe.manifestPath), /Invalid/);
  console.log('PASS: desktop proof validators reject missing/changed results, wrong browser markers and escaped paths; spaces/Unicode work. These unit fixtures do not certify on-device UI access.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  const resolved = path.resolve(root), expected = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(expected) || !path.basename(resolved).startsWith('of-desktop-unit-')) throw new Error('Unexpected test cleanup target.');
  fs.rmSync(resolved, { recursive: true, force: true });
}
