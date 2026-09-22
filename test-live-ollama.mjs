import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const effortByModel = new Map([
  ['qwen3.5-codex-fast-16k', 'none'],
  ['qwen3.8-codex-16k', 'none'],
  ['qwen3.8-codex-iq4-xs-64k', 'none'],
  ['qwen3.8-codex-iq4-xs-110k', 'none'],
]);
const requestedModels = process.argv.slice(2);
const models = requestedModels.length > 0 ? requestedModels : ['qwen3.5-codex-fast-16k'];
const responsesUrl = process.env.CODEX_RESPONSES_URL || 'http://127.0.0.1:11435/v1/responses';
const timeoutMs = Number(process.env.CODEX_TEST_TIMEOUT_MS || 180_000);
const textTokenLimit = Number(process.env.CODEX_TEST_TEXT_TOKENS || 48);
// Real shell calls often need more than 128 tokens for the command JSON plus tool tags.
// Ollama drops an incomplete auto-selected call as an empty assistant message.
const toolTokenLimit = Number(process.env.CODEX_TEST_TOOL_TOKENS || 512);

function requestHeaders(url) {
  if (!new URL(url).pathname.includes('/api/codex/')) return {};
  const authPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const token = auth.tokens?.access_token || auth.OPENAI_API_KEY;
  if (!token) throw new Error(`Codex authentication token not found in ${authPath}.`);
  return {
    authorization: `Bearer ${token}`,
    ...(auth.tokens?.account_id ? { 'chatgpt-account-id': auth.tokens.account_id } : {}),
  };
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...requestHeaders(url),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        const responseBody = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: response.statusCode, payload: JSON.parse(responseBody) });
        } catch (error) {
          reject(new Error(`Invalid JSON response (${response.statusCode}): ${responseBody}`, { cause: error }));
        }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error(`Request exceeded ${timeoutMs} ms.`)), timeoutMs);
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}

for (const model of models) {
  const effort = effortByModel.get(model);
  if (!effort) throw new Error(`Unknown local model: ${model}`);
  const started = Date.now();
  const response = await postJson(responsesUrl, {
    model,
    reasoning: { effort },
    input: [
      { role: 'system', content: [{ type: 'input_text', text: 'Follow the user request.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Setup.' }] },
      { role: 'system', content: [{ type: 'input_text', text: 'Second system message.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Reply PING.' }] },
    ],
    stream: false,
    max_output_tokens: textTokenLimit,
  });
  const payload = response.payload;
  assert.equal(response.status, 200, `${model}: ${JSON.stringify(payload)}`);
  assert.equal(payload.model?.replace(/:latest$/, ''), model);
  assert.ok(payload.output?.some((item) => item.type === 'message'), `${model}: no message output`);

  const toolResponse = await postJson(responsesUrl, {
    model,
    reasoning: { effort },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Call the ping tool exactly once with value "ok".' }] }],
    tools: [{
      type: 'namespace',
      name: 'self_test',
      tools: [{
        type: 'function',
        name: 'ping',
        description: 'Return a test value.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      }],
    }],
    tool_choice: { type: 'function', namespace: 'self_test', name: 'ping' },
    stream: false,
    max_output_tokens: toolTokenLimit,
  });
  const toolPayload = toolResponse.payload;
  assert.equal(toolResponse.status, 200, `${model} tool call: ${JSON.stringify(toolPayload)}`);
  const toolCall = toolPayload.output?.find((item) => item.type === 'function_call');
  assert.ok(toolCall, `${model}: no function_call output: ${JSON.stringify(toolPayload)}`);
  assert.equal(toolCall.name, 'ping');
  assert.equal(toolCall.namespace, 'self_test');
  assert.equal(JSON.parse(toolCall.arguments).value, 'ok');

  const autonomousToolResponse = await postJson(responsesUrl, {
    model,
    reasoning: { effort },
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: 'Inspect the free disk space on this computer. Use exec_command now. Do not answer from memory or only describe a plan.',
      }],
    }],
    tools: [{
      type: 'namespace',
      name: 'computer',
      tools: [{
        type: 'function',
        name: 'exec_command',
        description: 'Run a PowerShell command on the local computer.',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
          additionalProperties: false,
        },
      }],
    }],
    parallel_tool_calls: false,
    stream: false,
    max_output_tokens: toolTokenLimit,
  });
  const autonomousPayload = autonomousToolResponse.payload;
  assert.equal(autonomousToolResponse.status, 200, `${model} autonomous tool call: ${JSON.stringify(autonomousPayload)}`);
  const autonomousCall = autonomousPayload.output?.find((item) => item.type === 'function_call');
  assert.ok(autonomousCall, `${model}: returned reasoning/plan without an autonomous tool call: ${JSON.stringify(autonomousPayload)}`);
  assert.equal(autonomousCall.name, 'exec_command');
  assert.equal(autonomousCall.namespace, 'computer');
  assert.ok(JSON.parse(autonomousCall.arguments).cmd, `${model}: exec_command did not include cmd`);
  console.log(`${model}: text, forced tool, and autonomous tool calls passed in ${(Date.now() - started) / 1000}s.`);
}
