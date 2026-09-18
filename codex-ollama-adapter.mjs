import http from 'node:http';
import crypto from 'node:crypto';
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

function originalToolKey(namespace, name) {
  return `${namespace}\u0000${name}`;
}

function shortToolName(namespace, name) {
  const digest = crypto.createHash('sha256').update(originalToolKey(namespace, name)).digest('hex').slice(0, 12);
  const readable = `${namespace}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-42);
  return `t_${digest}_${readable}`;
}

function flattenTools(tools) {
  const byWireName = new Map();
  const byOriginalName = new Map();
  const flattened = [];
  const unsupportedTypes = [];

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === 'function') {
      flattened.push(tool);
      continue;
    }

    const isExpandableNamespace = tool?.type === 'namespace' && Array.isArray(tool.tools);
    const isExpandableMcp = tool?.type === 'mcp' && Array.isArray(tool.tools);
    if (isExpandableNamespace || isExpandableMcp) {
      const namespace = String(tool.name ?? tool.server_label ?? 'tools');
      for (const member of tool.tools) {
        if (member?.type !== 'function' || typeof member.name !== 'string') {
          unsupportedTypes.push(`${tool.type}:${member?.type ?? 'unknown'}`);
          continue;
        }
        const wireName = shortToolName(namespace, member.name);
        const mapping = { namespace, name: member.name, wireName };
        byWireName.set(wireName, mapping);
        byOriginalName.set(originalToolKey(namespace, member.name), mapping);
        const descriptionPrefix = `[${namespace}.${member.name}]`;
        const flatTool = {
          ...member,
          type: 'function',
          name: wireName,
          description: member.description
            ? `${descriptionPrefix} ${member.description}`
            : `${descriptionPrefix} Codex namespaced tool.`,
        };
        delete flatTool.defer_loading;
        flattened.push(flatTool);
      }
      continue;
    }

    unsupportedTypes.push(String(tool?.type ?? 'unknown'));
  }

  return { tools: flattened, byWireName, byOriginalName, unsupportedTypes };
}

function rewriteToolReference(value, bridge) {
  if (Array.isArray(value)) return value.map((item) => rewriteToolReference(item, bridge));
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  if (typeof copy.namespace === 'string' && typeof copy.name === 'string') {
    const mapping = bridge.byOriginalName.get(originalToolKey(copy.namespace, copy.name));
    if (mapping) {
      copy.name = mapping.wireName;
      delete copy.namespace;
    }
  }
  for (const [key, item] of Object.entries(copy)) {
    if (key !== 'name' && key !== 'namespace') copy[key] = rewriteToolReference(item, bridge);
  }
  return copy;
}

function rewriteInputForOllama(value, bridge) {
  if (Array.isArray(value)) return value.map((item) => rewriteInputForOllama(item, bridge));
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  if (copy.type === 'function_call' && typeof copy.namespace === 'string' && typeof copy.name === 'string') {
    const mapping = bridge.byOriginalName.get(originalToolKey(copy.namespace, copy.name));
    if (mapping) {
      copy.name = mapping.wireName;
      delete copy.namespace;
    }
  }
  for (const [key, item] of Object.entries(copy)) {
    if (key !== 'name' && key !== 'namespace') copy[key] = rewriteInputForOllama(item, bridge);
  }
  return copy;
}

function rewriteOutputForCodex(value, bridge) {
  if (Array.isArray(value)) return value.map((item) => rewriteOutputForCodex(item, bridge));
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  if (copy.type === 'function_call' && typeof copy.name === 'string') {
    const mapping = bridge.byWireName.get(copy.name);
    if (mapping) {
      copy.name = mapping.name;
      copy.namespace = mapping.namespace;
    }
  }
  for (const [key, item] of Object.entries(copy)) {
    if (key !== 'name' && key !== 'namespace') copy[key] = rewriteOutputForCodex(item, bridge);
  }
  return copy;
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

  const bridge = flattenTools(body.tools);
  if (bridge.byWireName.size > 0) {
    systemSections.push('Some function tools use short t_ names because they represent Codex Apps, MCP, Browser, Chrome, or Computer Use tools. Read each tool description to identify its original namespace and purpose.');
    input[0].content[0].text = systemSections.join('\n\n');
  }

  const normalized = {
    ...body,
    input: rewriteInputForOllama(input, bridge),
    tools: bridge.tools,
    parallel_tool_calls: false,
  };
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    normalized.tool_choice = rewriteToolReference(body.tool_choice, bridge);
  }
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
  return { normalized, bridge };
}

function transformSseLine(line, bridge) {
  if (!line.startsWith('data:')) return line;
  const payloadText = line.slice(5).trimStart();
  if (!payloadText || payloadText === '[DONE]') return line;
  try {
    return `data: ${JSON.stringify(rewriteOutputForCodex(JSON.parse(payloadText), bridge))}`;
  } catch {
    return line;
  }
}

function forwardResponse(upstreamResponse, res, bridge) {
  const responseHeaders = { ...upstreamResponse.headers };
  delete responseHeaders.connection;
  const contentType = String(upstreamResponse.headers['content-type'] ?? '').toLowerCase();
  const shouldTransform = bridge.byWireName.size > 0 &&
    (contentType.includes('application/json') || contentType.includes('text/event-stream'));
  if (!shouldTransform) {
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(res);
    return;
  }

  delete responseHeaders['content-length'];
  delete responseHeaders['content-encoding'];
  delete responseHeaders['transfer-encoding'];
  if (contentType.includes('text/event-stream')) {
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    const decoder = new TextDecoder();
    let pending = '';
    upstreamResponse.on('data', (chunk) => {
      pending += decoder.decode(chunk, { stream: true });
      let newlineIndex;
      while ((newlineIndex = pending.indexOf('\n')) >= 0) {
        let line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const newline = line.endsWith('\r') ? '\r\n' : '\n';
        if (line.endsWith('\r')) line = line.slice(0, -1);
        res.write(transformSseLine(line, bridge) + newline);
      }
    });
    upstreamResponse.on('end', () => {
      pending += decoder.decode();
      if (pending) res.write(transformSseLine(pending, bridge));
      res.end();
    });
    upstreamResponse.on('error', (error) => res.destroy(error));
    return;
  }

  const chunks = [];
  upstreamResponse.on('data', (chunk) => chunks.push(chunk));
  upstreamResponse.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const output = Buffer.from(JSON.stringify(rewriteOutputForCodex(payload, bridge)), 'utf8');
      responseHeaders['content-length'] = String(output.length);
      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      res.end(output);
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'adapter_error', message: `Could not translate upstream response: ${error.message}` } }));
    }
  });
  upstreamResponse.on('error', (error) => res.destroy(error));
}

function forward(req, res, rawBody) {
  let outgoingBody = rawBody;
  let bridge = flattenTools([]);
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
      const result = normalizeResponsesRequest(parsed);
      const normalized = result.normalized;
      bridge = result.bridge;
      const unsupported = [...new Set(bridge.unsupportedTypes)].sort().join(',') || 'none';
      process.stdout.write(`Responses request model=${parsed.model ?? ''} forwarded_model=${normalized.model} namespace_tools=${bridge.byWireName.size} unsupported_tool_types=${unsupported} reasoning=${JSON.stringify(parsed.reasoning ?? null)} forwarded_reasoning=${JSON.stringify(normalized.reasoning ?? null)} forwarded_effort=${normalized.reasoning_effort ?? ''}\n`);
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
  if (isResponses) delete headers['accept-encoding'];
  headers['content-length'] = String(outgoingBody.length);

  const upstreamRequest = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamResponse) => forwardResponse(upstreamResponse, res, bridge));

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
