import assert from 'node:assert/strict';
import { STRATA_MODEL } from './strata-codex-bridge.mjs';

const base = 'http://127.0.0.1:8080';
const health = await fetch(`${base}/health`).then((r) => r.json());
assert.equal(health.model, STRATA_MODEL);
assert.equal(health.loaded, true);
assert.equal(health.max_context, 131072);

const marker = 'STRATA_128K_OK_A7C9';
const makeText = (count) => `The secret verification marker is ${marker}. Remember it.\n<irrelevant_padding>${' apple'.repeat(count)}\n</irrelevant_padding>\nWhat was the secret verification marker at the beginning? Reply with that marker only.`;
const countTokens = async (count) => {
  const response = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: STRATA_MODEL, max_tokens: 64, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: makeText(count) }] }),
    signal: AbortSignal.timeout(120000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).input_tokens;
};
const target = 125000;
const overhead = await countTokens(0);
const perThousand = (await countTokens(1000)) - overhead;
let padding = Math.floor((target - overhead) * 1000 / perThousand);
let measured = await countTokens(padding);
if (measured > 128000 || measured < 123000) {
  padding = Math.floor(padding * (target - overhead) / (measured - overhead));
  measured = await countTokens(padding);
}
assert.ok(measured >= 123000 && measured < 128000, `Input does not exercise the 128K window: ${measured}`);
console.log(`128K window test: ${measured} measured input tokens; model=${STRATA_MODEL}`);
const started = Date.now();
const response = await fetch(process.env.CODEX_RESPONSES_URL || 'http://127.0.0.1:11436/api/codex/v1/responses', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: STRATA_MODEL, input: makeText(padding), reasoning: { effort: 'none' }, stream: false, store: false, max_output_tokens: 64 }),
  signal: AbortSignal.timeout(1200000),
});
const payload = await response.json();
assert.equal(response.status, 200, JSON.stringify(payload));
const output = (payload.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []).map((item) => item.text ?? '').join('').trim();
assert.ok(output.includes(marker), `Long-context recall failed: ${output}`);
assert.ok(payload.usage?.input_tokens >= 123000, `Server did not process the full input: ${JSON.stringify(payload.usage)}`);
console.log(JSON.stringify({ result: 'PASS', model: payload.model, inputTokens: payload.usage.input_tokens, output, seconds: (Date.now() - started) / 1000 }, null, 2));
