import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const STRATA_MODEL = 'qwen3.8-flash-next-iq3_s';
export const BRIDGE_BASE = 'http://127.0.0.1:11436/api/codex/v1';

function decode(body, encoding) {
  switch (encoding ?? 'identity') {
    case 'identity': return body;
    case 'zstd': return zlib.zstdDecompressSync(body);
    case 'gzip': return zlib.gunzipSync(body);
    case 'deflate': return zlib.inflateSync(body);
    case 'br': return zlib.brotliDecompressSync(body);
    default: throw new Error('Unsupported request compression.');
  }
}

// Only the exact Strata model goes to Strata. Everything else retains Ollama's
// existing cloud/local routing. Never send the user's cloud credentials to Strata.
export function startBridge({ port = 11436, strataBase = 'http://127.0.0.1:8080', ollamaBase = 'http://127.0.0.1:11434' } = {}) {
  for (const base of [strataBase, ollamaBase]) {
    const url = new URL(base);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Upstreams must be loopback HTTP.');
  }
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/health') return json(200, { status: 'ok', service: 'ollamaforge-strata-bridge', model: STRATA_MODEL });
    if (!req.url?.startsWith('/api/codex/v1/')) return json(404, { error: { message: 'Unknown bridge endpoint.' } });
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64 * 1024 * 1024) return json(413, { error: { message: 'Request exceeds 64 MiB.' } });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const decoded = raw.length ? decode(raw, req.headers['content-encoding']) : raw;
      const parsed = decoded.length ? JSON.parse(decoded) : null;
      const local = parsed?.model === STRATA_MODEL;
      if (local) {
        let health;
        try {
          const response = await fetch(`${strataBase}/health`, { signal: AbortSignal.timeout(5000) });
          health = await response.json();
        } catch {
          return json(503, { error: { message: 'Strata is not ready. Start the Codex IQ3_S 128K preset.', type: 'bridge_error' } });
        }
        if (!health.loaded || health.model !== STRATA_MODEL || health.max_context !== 131072) {
          return json(409, { error: { message: `Expected ${STRATA_MODEL} at 128K; the loaded runtime reports ${health.model ?? 'no model'} at ${health.max_context ?? 0}. Start the matching preset.`, type: 'model_mismatch' } });
        }
      }
      const suffix = req.url.slice('/api/codex/v1'.length);
      const target = new URL(local ? `/v1${suffix}` : req.url, local ? strataBase : ollamaBase);
      const headers = { ...req.headers, host: target.host };
      for (const key of ['connection', 'transfer-encoding', 'content-length']) delete headers[key];
      let body = raw;
      if (local) {
        for (const key of Object.keys(headers)) {
          if (!['content-type', 'accept', 'user-agent'].includes(key)) delete headers[key];
        }
        // Strata's Responses implementation is stateless and already understands
        // namespace/custom tools; preserve those tools and the full input history.
        parsed.store = false;
        body = Buffer.from(JSON.stringify(parsed));
        headers['content-type'] = 'application/json';
      }
      if (body.length) headers['content-length'] = String(body.length);
      process.stdout.write(`${new Date().toISOString()} model=${parsed?.model ?? '-'} route=${local ? 'strata' : 'ollama-gateway'}\n`);
      const upstream = http.request(target, { method: req.method, headers, timeout: 600_000 }, (response) => {
        const responseHeaders = { ...response.headers };
        delete responseHeaders.connection;
        delete responseHeaders['transfer-encoding'];
        res.writeHead(response.statusCode ?? 502, responseHeaders);
        response.pipe(res);
        response.on('error', (error) => res.destroy(error));
      });
      upstream.on('timeout', () => upstream.destroy(new Error('Upstream timed out.')));
      upstream.on('error', (error) => {
        if (res.headersSent) return res.destroy(error);
        json(502, { error: { message: error.message, type: 'bridge_error' } });
      });
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end(body);
    } catch (error) {
      if (!res.headersSent) json(400, { error: { message: error.message, type: 'bridge_error' } });
      else res.destroy(error);
    }
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.listen(port, '127.0.0.1');
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge().on('listening', () => console.log(`OllamaForge Strata bridge ready: ${BRIDGE_BASE}`));
}
