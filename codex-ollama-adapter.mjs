import http from 'node:http';
import zlib from 'node:zlib';

const listenHost = '127.0.0.1';
const listenPort = Number.parseInt(process.env.CODEX_OLLAMA_ADAPTER_PORT ?? '11435', 10);
const upstream = new URL(process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434');
const maxRequestBytes = 32 * 1024 * 1024;

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('CODEX_OLLAMA_ADAPTER_PORT must be a valid TCP port.');
}
if (!['127.0.0.1', 'localhost', '::1'].includes(upstream.hostname)) {
  throw new Error('OLLAMA_BASE_URL must point to the local computer.');
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && ['input_text', 'output_text', 'text'].includes(part.type))
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n');
}

function extractInstructionText(instructions) {
  if (typeof instructions === 'string') return instructions;
  if (!Array.isArray(instructions)) return '';
  return instructions
    .map((item) => extractText(item?.content ?? item))
    .filter(Boolean)
    .join('\n\n');
}

function supportedReasoningEffort(model, effort) {
  if (typeof effort !== 'string') return effort;
  const canonicalModel = String(model ?? '').replace(/:latest$/, '');
  if (canonicalModel === 'qwen3.8-codex-16k') {
    if (['high', 'max', 'ultra', 'xhigh'].includes(effort)) return 'xhigh';
    if (['none', 'minimal', 'low'].includes(effort)) return 'low';
    return 'medium';
  }
  if (canonicalModel === 'qwen3.5-codex-fast-16k') {
    return effort === 'none' ? 'none' : 'medium';
  }
  return effort;
}

function normalizeResponsesRequest(body) {
  const systemSections = [];
  const instructionText = extractInstructionText(body.instructions);
  if (instructionText.trim()) systemSections.push(instructionText.trim());

  const sourceInput = Array.isArray(body.input)
    ? body.input
    : typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : [];
  const input = [];
  for (const item of sourceInput) {
    if (item && ['system', 'developer'].includes(item.role)) {
      const text = extractText(item.content);
      if (text.trim()) systemSections.push(text.trim());
      continue;
    }
    input.push(item);
  }

  systemSections.push(process.platform === 'win32'
    ? 'Local runtime note: the host operating system is Windows and the shell is PowerShell. ' +
      'Use native PowerShell cmdlets and Windows paths. Do not emit bash-only commands such as find, head, sed, or cat.'
    : 'Local runtime note: the host operating system is macOS and the shell is POSIX-compatible. ' +
      'Use macOS paths and commands; do not emit Windows PowerShell cmdlets.');

  input.unshift({
    type: 'message',
    role: 'system',
    content: [{ type: 'input_text', text: systemSections.join('\n\n') }],
  });

  // Ollama currently accepts ordinary Responses function tools. Codex also
  // advertises namespace and web_search tools that the local runner rejects.
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((tool) => tool?.type === 'function');

  const normalized = { ...body, input, tools };
  const originalModel = String(body.model ?? '').replace(/:latest$/, '');
  normalized.model = originalModel;
  const canonicalModel = originalModel;
  const requestedEffort = body.reasoning?.effort ?? body.reasoning_effort;
  if (canonicalModel === 'qwen3.8-codex-16k') {
    // Ollama's Responses shim maps reasoning.effort=xhigh back to "max", which
    // this model's Jinja template rejects. Its top-level field works correctly.
    delete normalized.reasoning;
    if (requestedEffort) normalized.reasoning_effort = supportedReasoningEffort(body.model, requestedEffort);
  } else if (canonicalModel === 'qwen3.5-codex-fast-16k' &&
             body.reasoning && typeof body.reasoning === 'object' && 'effort' in body.reasoning) {
    normalized.reasoning = {
      ...body.reasoning,
      effort: supportedReasoningEffort(canonicalModel, requestedEffort),
    };
  }
  if (canonicalModel !== 'qwen3.8-codex-16k' && 'reasoning_effort' in body) {
    normalized.reasoning_effort = supportedReasoningEffort(canonicalModel, requestedEffort);
  }
  delete normalized.instructions;
  return normalized;
}

function forward(req, res, rawBody) {
  let outgoingBody = rawBody;
  const isResponses = req.method === 'POST' &&
    new URL(req.url ?? '/', 'http://localhost').pathname.endsWith('/responses');
  if (isResponses) {
    try {
      const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
      const decodedBody = encoding === 'zstd'
        ? zlib.zstdDecompressSync(rawBody)
        : encoding === 'gzip'
          ? zlib.gunzipSync(rawBody)
          : encoding === 'deflate'
            ? zlib.inflateSync(rawBody)
            : encoding === 'br'
              ? zlib.brotliDecompressSync(rawBody)
              : encoding === 'identity'
                ? rawBody
                : (() => { throw new Error(`Unsupported content encoding: ${encoding}`); })();
      const parsed = JSON.parse(decodedBody.toString('utf8'));
      const normalized = normalizeResponsesRequest(parsed);
      process.stdout.write(`Responses request model=${parsed.model ?? ''} forwarded_model=${normalized.model} reasoning=${JSON.stringify(parsed.reasoning ?? null)} forwarded_reasoning=${JSON.stringify(normalized.reasoning ?? null)} forwarded_effort=${normalized.reasoning_effort ?? ''}\n`);
      outgoingBody = Buffer.from(JSON.stringify(normalized), 'utf8');
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'adapter_error', message: `Could not decode Responses request: ${error.message}` } }));
      return;
    }
  }

  const headers = { ...req.headers, host: upstream.host };
  for (const name of ['content-length', 'connection', 'transfer-encoding', 'x-codex-local-preset']) delete headers[name];
  if (isResponses) delete headers['content-encoding'];
  headers['content-length'] = String(outgoingBody.length);

  const upstreamRequest = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders.connection;
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(res);
  });

  upstreamRequest.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'adapter_error', message: error.message } }));
  });
  req.on('aborted', () => upstreamRequest.destroy());
  upstreamRequest.end(outgoingBody);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', upstream: upstream.origin }));
    return;
  }

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxRequestBytes) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'adapter_error', message: 'Request body is too large.' } }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (!res.writableEnded) forward(req, res, Buffer.concat(chunks));
  });
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`Codex-Ollama adapter ready at http://${listenHost}:${listenPort}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
