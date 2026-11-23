import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { RUNTIME, runHarnessTask } from './deepseek-harness.mjs';

const connection = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'connection.json')));
assert.equal(connection.baseURL, 'http://127.0.0.1:8080/v1');
assert.equal(connection.model, 'qwen3.8-flash-next-iq3_s');
const read = async route => {
  const response = await fetch('http://127.0.0.1:8080/' + route, { signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok, route + ' returned ' + response.status);
  return response.json();
};
const health = await read('health');
assert.equal(health.max_context, 131072);
const directory = fs.mkdtempSync(path.join(RUNTIME, 'latency-'));
const code = String(randomInt(10000, 100000));
let sessionId;
for (const [phase, prompt, answer] of [
  ['first', 'Join the letter A and ' + code + '. Reply with only the result.', 'A' + code],
  ['followup', 'Change the first letter of your previous reply to B. Reply with only the result.', 'B' + code],
]) {
  const before = await read('metrics');
  assert.equal(before.live.queued, 0, 'Another request is queued');
  assert.ok(['idle', 'unloaded'].includes(before.live.state), 'Model is busy');
  const ids = new Set(before.requests.map(row => row.id));
  const start = performance.now();
  const events = await runHarnessTask(prompt, directory, sessionId);
  const wallMs = Math.round(performance.now() - start);
  assert.equal(events.findLast(event => event.type === 'final')?.text.trim(), answer);
  const id = events.find(event => event.type === 'session')?.sessionId;
  assert.ok(id);
  if (sessionId) assert.equal(id, sessionId);
  sessionId = id;
  const metrics = await read('metrics');
  const props = await read('props?model=' + encodeURIComponent(connection.model) + '&autoload=false');
  assert.match(path.basename(props.model_path), /^Qwen3\.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00001-of-00002\.gguf$/i);
  assert.equal(metrics.engine.context, 131072);
  assert.equal(metrics.engine.kv, 'q4_0');
  const rows = metrics.requests.filter(row => !ids.has(row.id));
  assert.equal(rows.length, 1, 'Expected one model request. Run on an idle GPU with the optimized default profile.');
  const row = rows[0];
  if (phase === 'followup') {
    assert.ok(row.reused > row.prompt_read, 'The follow-up reread most of the conversation instead of reusing its prefix.');
  }
  console.log(JSON.stringify({ phase, loadedAtStart: phase === 'first' ? health.loaded : true,
    engineVersion: metrics.engine.version, wallMs, engineSeconds: row.duration_s, firstTokenSeconds: row.first_engine_token_s,
    inputTokens: row.prompt_tokens, readTokens: row.prompt_read, reusedTokens: row.reused, outputTokens: row.output_tokens }));
}
