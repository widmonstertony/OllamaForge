#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const endpoint = 'http://127.0.0.1:11434';

async function chat(model, messages, options = {}, tools) {
  const started = performance.now();
  const response = await fetch(endpoint + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, think: false, stream: true, keep_alive: '20m',
      options: { num_ctx: 131072, num_predict: 256, temperature: 0, seed: 42, ...options } }),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(await response.text());
  let pending = '', firstMs = null, final;
  const decoder = new TextDecoder();
  const message = { role: 'assistant', content: '', tool_calls: [] };
  for await (const bytes of response.body) {
    pending += decoder.decode(bytes, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error);
      if (event.message?.content || event.message?.tool_calls?.length) firstMs ??= performance.now() - started;
      message.content += event.message?.content ?? '';
      message.tool_calls.push(...(event.message?.tool_calls ?? []));
      if (event.done) final = event;
    }
  }
  assert.ok(final, 'Missing final inference metrics.');
  if (!message.tool_calls.length) delete message.tool_calls;
  return { wall_ms: performance.now() - started, first_ms: firstMs,
    prompt_tokens: final.prompt_eval_count, cached_tokens: final.prompt_eval_cached_count ?? null,
    prompt_ms: final.prompt_eval_duration / 1e6, load_ms: final.load_duration / 1e6,
    output_tokens: final.eval_count, decode_tps: final.eval_count / (final.eval_duration / 1e9),
    done_reason: final.done_reason, message };
}

export async function benchmarkModel(model) {
  const result = { model, context: 131072, runs: [] };
  const record = (kind, run) => {
    result.runs.push({ kind, ...run });
    console.log(JSON.stringify({ model, kind, ...run, message: undefined }));
  };
  record('warmup', await chat(model, [{ role: 'user', content: 'Reply READY.' }], { num_predict: 16 }));
  const short = [{ role: 'user', content: 'Write a complete Python async retry decorator with exponential backoff and jitter. Include a docstring, type hints and an example. Output code only.' }];
  for (let index = 0; index < 2; index++) record('short-' + (index + 1), await chat(model, short));
  // Identical, synthetic source material: no local documents or user conversations.
  const prefix = Array.from({ length: 900 }, (_, index) =>
    `record_${index}: project=maple; retries=3; timeout=20; cache=enabled; owner=local; status=ready.`).join('\n');
  const long = [{ role: 'user', content: prefix + '\nWrite a Python parser for these records. Include validation, a dataclass, and examples. Output code only.' }];
  const first = await chat(model, long);
  record('long-first', first);
  record('long-followup', await chat(model, [...long, first.message,
    { role: 'user', content: 'Add streaming support using an iterator. Provide the complete revised implementation.' }]));
  const marker = 'MAPLE_' + randomBytes(8).toString('hex');
  const tools = [{ type: 'function', function: { name: 'read_marker',
    description: 'Read the local benchmark marker. Use the key bench.',
    parameters: { type: 'object', properties: { key: { type: 'string', enum: ['bench'] } }, required: ['key'], additionalProperties: false } } }];
  const task = [{ role: 'user', content: 'Call read_marker with key bench, then reply with the exact returned marker only.' }];
  const call = await chat(model, task, {}, tools);
  record('tool-call', call);
  const invocation = call.message.tool_calls?.find(call => call.function?.name === 'read_marker');
  assert.ok(invocation, 'The model must autonomously request the tool.');
  const args = typeof invocation.function.arguments === 'string'
    ? JSON.parse(invocation.function.arguments) : invocation.function.arguments;
  assert.deepEqual(args, { key: 'bench' });
  // This read-only fixture implements the advertised tool locally.
  const reply = await chat(model, [...task, call.message,
    { role: 'tool', tool_name: 'read_marker', content: marker }], {}, tools);
  record('tool-result', reply);
  assert.equal(reply.message.content.trim(), marker, 'Tool result must survive the round trip.');
  result.tool_roundtrip_passed = true;
  const ps = await fetch(endpoint + '/api/ps').then(response => response.json());
  result.runtime = ps.models?.find(entry => entry.name === model || entry.model === model);
  return result;
}

async function main() {
  const models = process.argv.slice(2);
  if (!models.length || models.some(model => model.startsWith('-'))) throw new Error('Pass installed model names. This benchmark never downloads models.');
  const output = path.join(root, '.runtime', 'performance', 'benchmark-' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const running = await fetch(endpoint + '/api/ps').then(response => response.json());
  const preloaded = new Set(running.models?.flatMap(entry => [entry.name, entry.model]));
  const environment = { cpu: os.cpus()[0]?.model, arch: os.arch(), platform: os.platform(),
    memory_bytes: os.totalmem(), ollama: await fetch(endpoint + '/api/version').then(response => response.json()),
    context: 131072, output_limit: 256, temperature: 0, think: false };
  const results = [];
  for (const model of models) {
    try { results.push(await benchmarkModel(model)); }
    catch (error) { results.push({ model, error: error.message }); console.error(model + ': ' + error.message); }
    fs.writeFileSync(output, JSON.stringify({ created_at: new Date().toISOString(), environment, results }, null, 2) + '\n');
    if (!preloaded.has(model)) {
      const response = await fetch(endpoint + '/api/generate', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Could not release benchmark model: ' + await response.text());
      await response.body?.cancel();
    }
  }
  console.log('Results: ' + output);
  if (results.some(result => result.error)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
