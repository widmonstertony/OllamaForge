import assert from 'node:assert/strict';

for (const [model, effort] of [
  ['qwen3.5-codex-fast-16k', 'none'],
  ['qwen3.8-codex-16k', 'low'],
]) {
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:11435/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning: { effort },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply PING.' }] }],
      stream: false,
      max_output_tokens: 48,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `${model}: ${JSON.stringify(payload)}`);
  assert.equal(payload.model?.replace(/:latest$/, ''), model);
  console.log(`${model}: HTTP ${response.status}, ${(Date.now() - started) / 1000}s, output items ${payload.output?.length ?? 0}`);
}
