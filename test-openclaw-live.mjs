import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectGateway, gatewayReply, loadGatewayIdentity } from './openclaw-gateway.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
const health = await (await fetch('http://127.0.0.1:8080/health')).json();
if (!health.loaded || health.service !== 'strata' || config.agents?.defaults?.model?.primary !== `strata/${health.model}`) throw new Error('The saved Strata model is not ready/selected.');
if (/^qwen/i.test(health.model)) {
  // Validate the installed, pinned SDK's actual outbound body, not just config.
  const dist = path.join(root, '.runtime', 'openclaw', 'node_modules', '@openclaw', 'ai', 'dist');
  const file = fs.readdirSync(dist).find(name => /^openai-completions-transport-.*\.mjs$/.test(name));
  const sdk = await import(pathToFileURL(path.join(dist, file)).href);
  const build = Object.values(sdk).find(value => typeof value === 'function' && value.name === 'buildOpenAICompletionsParams');
  if (!build) throw new Error('Review the installed SDK request-builder contract.');
  const provider = config.models.providers.strata;
  const model = { ...provider.models[0], provider: 'strata', api: provider.api, baseUrl: provider.baseUrl };
  const body = build(model, { systemPrompt: 'Local test', messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }], timestamp: 0 }], tools: [] }, { reasoning: 'none' });
  if (body.chat_template_kwargs?.enable_thinking !== false) throw new Error('Thinking-off is missing from the actual Strata request.');
  console.log('PASS: installed SDK sends chat_template_kwargs.enable_thinking=false.');
}
const start = performance.now();
const observedSince = Date.now() / 1000;
const client = await connectGateway({ config, identity: loadGatewayIdentity(path.join(root, '.runtime', 'openclaw-client-identity.json')) });
const report = { model: health.model, context: health.max_context, connectMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString() };
const nonce = crypto.randomUUID();
const sessionKey = `agent:main:ollamaforge-latency-${nonce}`;
try {
  for (const name of ['first', 'followup']) {
    const marker = `OPENCLAW_${name.toUpperCase()}_${nonce.slice(0, 8)}`;
    const reply = await gatewayReply(client, { sessionKey, marker, message: `这是本机延迟验收。不要使用工具或外部服务，只回复 ${marker}。` });
    report[name] = { ackMs: reply.ackMs, firstTextMs: reply.firstTextMs, totalMs: reply.totalMs, settledMs: reply.settledMs };
    console.log(JSON.stringify({ phase: name, ...report[name] }));
  }
  if (process.argv.includes('--tools')) {
    const workspace = config.agents?.entries?.main?.workspace ?? config.agents.defaults.workspace;
    if (!path.resolve(workspace).startsWith(path.join(root, '.runtime') + path.sep)) throw new Error('Tool proof requires this checkout\'s private runtime workspace.');
    const name = `ollamaforge-proof-${nonce}.txt`, file = path.join(workspace, name);
    const marker = `OPENCLAW_READ_${crypto.randomBytes(12).toString('hex')}`;
    fs.writeFileSync(file, marker, { flag: 'wx' });
    try {
      const reply = await gatewayReply(client, { sessionKey, marker, message: `使用 read 工具读取当前工作区文件 ${name}，只回复文件里的标记。标记必须从文件中读取。` });
      report.readTool = { passed: true, totalMs: reply.totalMs };
      console.log(JSON.stringify({ phase: 'read-tool', ...report.readTool }));
    } finally { fs.unlinkSync(file); }
  }
  const metrics = await (await fetch('http://127.0.0.1:8080/metrics')).json();
  report.strataRequests = (metrics.requests ?? []).filter(request => request.time >= observedSince).map(request => ({
    id: request.id, duration_s: request.duration_s, first_engine_token_s: request.first_engine_token_s,
    prompt_tokens: request.prompt_tokens, reused: request.reused, prompt_ms: request.prompt_ms,
    output_tokens: request.output_tokens, decode_ms: request.decode_ms,
  }));
  fs.writeFileSync(path.join(root, '.runtime', 'openclaw-latency.json'), JSON.stringify(report, null, 2));
} finally { client.close(); }
