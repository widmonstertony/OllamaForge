import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const listenHost = '127.0.0.1';
const listenPort = Number.parseInt(process.env.CODEX_OLLAMA_ADAPTER_PORT ?? '11435', 10);
const upstream = new URL(process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434');
const maxRequestBytes = 32 * 1024 * 1024;
const historyPath = process.env.CODEX_LOCAL_HISTORY_PATH || '';
const maxHistoryTokens = Number.parseInt(process.env.CODEX_LOCAL_HISTORY_TOKENS ?? '3000', 10);
const maxHistoryEntries = 64;
const metalCoreToolNames = new Set(['exec_command', 'write_stdin', 'apply_patch', 'view_image']);

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('CODEX_OLLAMA_ADAPTER_PORT must be a valid TCP port.');
}
if (!['127.0.0.1', 'localhost', '::1'].includes(upstream.hostname)) {
  throw new Error('OLLAMA_BASE_URL must point to the local computer.');
}

function loadHistories() {
  if (!historyPath) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return new Map(Array.isArray(parsed.entries) ? parsed.entries : []);
  } catch {
    return new Map();
  }
}

const responseHistories = loadHistories();

function estimateTokens(value) {
  const text = JSON.stringify(value);
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function trimHistory(items) {
  const trimmed = [...items];
  while (trimmed.length > 1 && estimateTokens(trimmed) > maxHistoryTokens) trimmed.shift();
  return trimmed;
}

function saveHistories() {
  if (!historyPath) return;
  fs.mkdirSync(path.dirname(historyPath), { recursive: true, mode: 0o700 });
  const temporary = `${historyPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: [...responseHistories] })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, historyPath);
  fs.chmodSync(historyPath, 0o600);
}

function rememberResponse(response, historyBase) {
  if (!response?.id || !Array.isArray(response.output)) return;
  if (responseHistories.has(response.id)) responseHistories.delete(response.id);
  responseHistories.set(response.id, trimHistory([...historyBase, ...response.output]));
  while (responseHistories.size > maxHistoryEntries) {
    responseHistories.delete(responseHistories.keys().next().value);
  }
  saveHistories();
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

function extractInputText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.output === 'string') return item.output;
  return extractText(item.content);
}

function supportedReasoningEffort(model, effort) {
  if (typeof effort !== 'string') return effort;
  const canonicalModel = String(model ?? '').replace(/:latest$/, '');
  if (canonicalModel === 'qwen3.8-codex-16k') {
    if (['high', 'max', 'ultra', 'xhigh'].includes(effort)) return 'xhigh';
    if (['none', 'minimal', 'low'].includes(effort)) return 'low';
    return 'medium';
  }
  if (canonicalModel === 'qwen3.5-codex-metal-8k') return 'none';
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

const safeMacDiskCommand = 'df -h /\ndu -sh "$HOME"/Desktop "$HOME"/Downloads "$HOME"/Documents "$HOME"/Pictures "$HOME"/Music "$HOME"/Movies "$HOME"/Library /Applications 2>/dev/null';

function sanitizeMetalCommand(argumentsText) {
  if (process.platform !== 'darwin' || typeof argumentsText !== 'string') return argumentsText;
  try {
    const args = JSON.parse(argumentsText);
    const command = typeof args.cmd === 'string' ? args.cmd : '';
    const broadRoot = /(?:^|[\s"'])\/(?:Users|System|private|var)?(?=$|[\s"';&|])/m;
    if (/\bdu\b/.test(command) && broadRoot.test(command)) {
      return JSON.stringify({ ...args, cmd: safeMacDiskCommand });
    }
  } catch {}
  return argumentsText;
}

function rewriteOutputForCodex(value, bridge, metalModel = false) {
  if (Array.isArray(value)) return value.map((item) => rewriteOutputForCodex(item, bridge, metalModel));
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  if (copy.type === 'function_call' && typeof copy.name === 'string') {
    const mapping = bridge.byWireName.get(copy.name);
    if (mapping) {
      copy.name = mapping.name;
      copy.namespace = mapping.namespace;
    }
    if (metalModel && copy.name === 'exec_command') {
      copy.arguments = sanitizeMetalCommand(copy.arguments);
    }
  }
  for (const [key, item] of Object.entries(copy)) {
    if (key !== 'name' && key !== 'namespace' && key !== 'arguments') {
      copy[key] = rewriteOutputForCodex(item, bridge, metalModel);
    }
  }
  return copy;
}

function normalizeResponsesRequest(body) {
  const originalModel = String(body.model ?? '').replace(/:latest$/, '');
  const metalModel = originalModel === 'qwen3.5-codex-metal-8k';
  const systemSections = [];
  const instructionText = metalModel
    ? 'You are Codex, a local coding assistant. Complete the user request and reply in the user\'s language. ' +
      'Plan before using tools. Combine independent read-only shell checks into one exec_command call. ' +
      'Reuse all existing tool results and compaction or handoff summaries; never repeat a completed check or restart the task after compaction. ' +
      'A command with useful stdout is partial success even when its exit code is nonzero. ' +
      'For macOS disk analysis, use at most one exec call: check free space plus the user Desktop, Downloads, Documents, Pictures, Music, Movies, Library, and /Applications; ' +
      'never recursively run du on /, /Users, /System, /private, or /var, and do not request escalation for readable user folders. Then summarize the sizes and actions. ' +
      'Once there is enough evidence, stop using tools and give the final answer. Keep progress messages and output concise. ' +
      'Use only the tools provided in this request and respect tool errors, sandbox limits, and approval boundaries.'
    : extractInstructionText(body.instructions);
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
      if (!metalModel && text.trim()) systemSections.push(text.trim());
      continue;
    }
    if (item?.type === 'function_call_output' && typeof item.call_id !== 'string') {
      const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      });
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

  const previousResponseId = typeof body.previous_response_id === 'string'
    ? body.previous_response_id
    : '';
  const priorHistory = responseHistories.get(previousResponseId) ?? [];
  if (priorHistory.length > 0) input.splice(1, 0, ...priorHistory);

  const selectedNamespace = body.tool_choice && typeof body.tool_choice === 'object'
    ? body.tool_choice.namespace
    : null;
  const selectedToolName = body.tool_choice && typeof body.tool_choice === 'object'
    ? body.tool_choice.name
    : null;
  const recentTaskText = sourceInput.slice(-4).map(extractInputText).join('\n');
  const noToolsRequested = metalModel && (
    /(?:停止|不要|无需|别).{0,12}(?:工具|扫描)/u.test(recentTaskText) ||
    /\b(?:stop|without|do not use|don't use)\b.{0,20}\btools?\b/i.test(recentTaskText)
  );
  const requestedTools = metalModel
    ? (noToolsRequested ? [] : (Array.isArray(body.tools) ? body.tools.filter((tool) =>
        (tool?.type === 'function' && (metalCoreToolNames.has(tool.name) || tool.name === selectedToolName)) ||
        (selectedNamespace && [tool?.name, tool?.server_label].includes(selectedNamespace))
      ) : []))
    : body.tools;
  const bridge = flattenTools(requestedTools);
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
  normalized.model = originalModel;
  delete normalized.previous_response_id;
  const canonicalModel = originalModel;
  const requestedEffort = body.reasoning?.effort ?? body.reasoning_effort;
  if (canonicalModel === 'qwen3.8-codex-16k') {
    // Ollama's Responses shim maps reasoning.effort=xhigh back to "max", which
    // this model's Jinja template rejects. Its top-level field works correctly.
    delete normalized.reasoning;
    if (requestedEffort) normalized.reasoning_effort = supportedReasoningEffort(body.model, requestedEffort);
  } else if ((canonicalModel === 'qwen3.5-codex-fast-16k' || canonicalModel === 'qwen3.5-codex-metal-8k') &&
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
  return {
    normalized,
    bridge,
    metalModel,
    historyBase: normalized.input.slice(1),
    previousResponseId,
    historyHit: priorHistory.length > 0,
  };
}

function transformSseLine(line, context) {
  if (!line.startsWith('data:')) return line;
  const payloadText = line.slice(5).trimStart();
  if (!payloadText || payloadText === '[DONE]') return line;
  try {
    return `data: ${JSON.stringify(rewriteOutputForCodex(JSON.parse(payloadText), context.bridge, context.metalModel))}`;
  } catch {
    return line;
  }
}

function captureSseHistory(line, context) {
  if (!line.startsWith('data:')) return;
  const payloadText = line.slice(5).trimStart();
  if (!payloadText || payloadText === '[DONE]') return;
  try {
    const event = rewriteOutputForCodex(JSON.parse(payloadText), context.bridge, context.metalModel);
    if (event.type === 'response.completed') rememberResponse(event.response, context.historyBase);
  } catch {}
}

function forwardResponse(upstreamResponse, res, context) {
  const { bridge } = context;
  const responseHeaders = { ...upstreamResponse.headers };
  delete responseHeaders.connection;
  const contentType = String(upstreamResponse.headers['content-type'] ?? '').toLowerCase();
  const shouldTransform = context.isResponses &&
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
        captureSseHistory(line, context);
        res.write(transformSseLine(line, context) + newline);
      }
    });
    upstreamResponse.on('end', () => {
      pending += decoder.decode();
      if (pending) {
        captureSseHistory(pending, context);
        res.write(transformSseLine(pending, context));
      }
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
      const translated = rewriteOutputForCodex(payload, bridge, context.metalModel);
      rememberResponse(translated, context.historyBase);
      const output = Buffer.from(JSON.stringify(translated), 'utf8');
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
  let context = {
    bridge: flattenTools([]),
    historyBase: [],
    previousResponseId: '',
    historyHit: false,
    metalModel: false,
    isResponses: false,
  };
  const isResponses = req.method === 'POST' &&
    new URL(req.url ?? '/', 'http://localhost').pathname.endsWith('/responses');
  context.isResponses = isResponses;
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
      context = { ...result, isResponses: true };
      const unsupported = [...new Set(context.bridge.unsupportedTypes)].sort().join(',') || 'none';
      process.stdout.write(`Responses request model=${parsed.model ?? ''} forwarded_model=${normalized.model} namespace_tools=${context.bridge.byWireName.size} unsupported_tool_types=${unsupported} history_id=${result.previousResponseId || 'none'} history_hit=${result.historyHit} reasoning=${JSON.stringify(parsed.reasoning ?? null)} forwarded_reasoning=${JSON.stringify(normalized.reasoning ?? null)} forwarded_effort=${normalized.reasoning_effort ?? ''}\n`);
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
  }, (upstreamResponse) => forwardResponse(upstreamResponse, res, context));

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

export function startAdapter({ host = listenHost, port = listenPort } = {}) {
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

  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    process.stdout.write(`Codex-Ollama adapter ready at http://${host}:${boundPort}\n`);
  });
  return server;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const server = startAdapter();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
