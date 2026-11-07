#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createLocalRuntimeController } from './codex-local-runtime.mjs';

export const CLOUD_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const LOCAL_MODEL_ALIAS = 'qwen3.5-codex-metal-8k';
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hopHeaders = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// Local inference never receives the cloud login or account routing credentials.
const localRequestHeaders = new Set(['content-type', 'content-encoding', 'accept',
  'accept-encoding', 'user-agent']);

function validatedUrl(value, { cloud = false, allowTestUpstreams = false } = {}) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid upstream URL.');
  if (cloud && url.href.replace(/\/$/, '') === CLOUD_BASE_URL) return url;
  if ((!cloud || allowTestUpstreams) && url.protocol === 'http:' && loopbackHosts.has(url.hostname)) return url;
  throw new Error(cloud ? 'Cloud upstream must be the official Codex endpoint.' : 'Local upstream must use HTTP on loopback.');
}

function requestPath(rawPath) {
  if (!rawPath?.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) return null;
  const rawName = rawPath.split('?', 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(rawName); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((part) => part === '..' || part === '.')) return null;
  const url = new URL(rawPath, 'http://localhost');
  const pathname = url.pathname.replace(/^\/v1(?=\/)/, '').replace(/^\/backend-api\/codex(?=\/)/, '');
  return { pathname, suffix: `${pathname}${url.search}` };
}

function cleanHeaders(headers, local = false) {
  const connectionHeaders = new Set(String(headers.connection ?? '').toLowerCase().split(',').map((part) => part.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !hopHeaders.has(name.toLowerCase()) && !connectionHeaders.has(name.toLowerCase()) &&
    name.toLowerCase() !== 'content-length' && (!local || localRequestHeaders.has(name.toLowerCase()))));
}

function decodeBody(body, encoding, limit) {
  const options = { maxOutputLength: limit };
  switch (String(encoding ?? 'identity').toLowerCase()) {
    case 'identity': return body;
    case 'gzip': return zlib.gunzipSync(body, options);
    case 'deflate': return zlib.inflateSync(body, options);
    case 'br': return zlib.brotliDecompressSync(body, options);
    case 'zstd':
      if (!zlib.zstdDecompressSync) throw new Error('This Node.js runtime does not support zstd.');
      return zlib.zstdDecompressSync(body, options);
    default: throw new Error('Unsupported content encoding.');
  }
}

function sendError(res, status, type, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from(JSON.stringify({ error: { type, message } }));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

function readCatalog(filePath, aliases, cloud = false) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(raw.models)) return null;
    const models = raw.models.filter((model) => typeof model?.slug === 'string' &&
      (cloud ? !aliases.has(model.slug) : aliases.has(model.slug)));
    const fetchedAt = cloud && typeof raw.fetched_at === 'string' ? raw.fetched_at : null;
    return { catalog: cloud ? { models } : { ...raw, models }, fetchedAt };
  } catch { return null; }
}

/** The cloud destination is fixed in production. Tests may explicitly inject a loopback server. */
export function createHybridGateway(options = {}) {
  const configDir = options.configDir ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const cloudUrl = validatedUrl(options.cloudBaseUrl ?? CLOUD_BASE_URL, {
    cloud: true, allowTestUpstreams: options.allowTestUpstreams === true,
  });
  const localUrl = validatedUrl(options.localBaseUrl ?? 'http://127.0.0.1:11435/v1');
  const aliases = new Set(options.localModelAliases ?? [LOCAL_MODEL_ALIAS]);
  if (!aliases.size || [...aliases].some((alias) => typeof alias !== 'string' || !alias.trim())) throw new Error('Local model aliases must be explicit nonempty strings.');
  const localCatalogPath = options.localCatalogPath ?? path.join(configDir, 'local-qwen-metal-catalog.json');
  const cloudCachePath = options.cloudCachePath ?? path.join(configDir, 'models_cache.json');
  const maxRequestBytes = options.maxRequestBytes ?? 32 * 1024 * 1024;
  const maxCatalogBytes = options.maxCatalogBytes ?? 8 * 1024 * 1024;
  const requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  const catalogTimeoutMs = options.catalogTimeoutMs ?? 4_500;
  const makeRequest = options.makeRequest ?? ((url, requestOptions, callback) =>
    (url.protocol === 'https:' ? https : http).request(url, requestOptions, callback));
  const localRuntime = options.localRuntimeController ?? (options.metalOnDemand
    ? createLocalRuntimeController(options.localRuntimeOptions) : null);
  const stats = { total: 0, cloud: 0, local: 0, active: 0, aborted: 0, upstreamErrors: 0, catalogRefreshes: 0 };
  let latestCloud = null;
  let catalogState = { source: 'none', stale: true, lastCloudFetchAt: null };
  const activeUpstreams = new Set();

  function beginRequest(req, res) {
    stats.total++;
    stats.active++;
    const scope = { cancelled: false, upstream: null, done: false, local: false,
      abortController: new AbortController() };
    function finish(cancelled) {
      if (scope.done) return;
      scope.done = true;
      stats.active--;
      if (scope.local) localRuntime?.onRequestEnd();
      if (cancelled) {
        scope.cancelled = true;
        scope.abortController.abort();
        stats.aborted++;
        scope.upstream?.destroy();
      }
    }
    req.once('aborted', () => finish(true));
    req.once('error', () => finish(true));
    res.once('finish', () => finish(false));
    res.once('close', () => finish(!res.writableFinished));
    return scope;
  }

  function targetUrl(base, suffix) {
    return new URL(`${base.pathname.replace(/\/$/, '')}${suffix}`, base.origin);
  }

  function attachUpstream(scope, upstream, timeout) {
    scope.upstream = upstream;
    activeUpstreams.add(upstream);
    upstream.once('close', () => activeUpstreams.delete(upstream));
    upstream.setTimeout(timeout, () => upstream.destroy(new Error('Upstream timeout.')));
    if (scope.cancelled) upstream.destroy();
  }

  function forward(req, res, scope, body, route, suffix) {
    if (scope.cancelled) return;
    stats[route]++;
    const headers = cleanHeaders(req.headers, route === 'local');
    if (body.length || ['POST', 'PUT', 'PATCH'].includes(req.method)) headers['content-length'] = String(body.length);
    const upstream = makeRequest(targetUrl(route === 'local' ? localUrl : cloudUrl, suffix), {
      method: req.method, headers,
    }, (response) => {
      if (scope.cancelled || res.destroyed) { response.destroy(); return; }
      res.writeHead(response.statusCode ?? 502, cleanHeaders(response.headers));
      response.on('error', () => res.destroy());
      response.on('aborted', () => res.destroy());
      response.pipe(res);
    });
    attachUpstream(scope, upstream, requestTimeoutMs);
    upstream.once('error', () => {
      if (scope.cancelled) return;
      stats.upstreamErrors++;
      sendError(res, 502, `${route}_upstream_error`, `${route === 'local' ? 'Local' : 'Cloud'} endpoint could not be reached.`);
    });
    upstream.end(body);
  }

  function fetchModels(req, scope, suffix) {
    stats.cloud++;
    const headers = cleanHeaders(req.headers);
    // A cloud ETag cannot describe the extra local entries.
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
    headers['accept-encoding'] = 'identity';
    return new Promise((resolve, reject) => {
      const upstream = makeRequest(targetUrl(cloudUrl, suffix), { method: 'GET', headers }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxCatalogBytes) { upstream.destroy(new Error('Catalog too large.')); return; }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Catalog response interrupted.')));
        response.once('end', () => resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      attachUpstream(scope, upstream, catalogTimeoutMs);
      upstream.once('error', reject);
      // Destroy without an error (client cancellation) must settle the promise too.
      upstream.once('close', () => { if (scope.cancelled) reject(new Error('Client disconnected.')); });
      upstream.end();
    });
  }

  async function models(req, res, scope, suffix) {
    let remote;
    let source = 'live';
    try {
      remote = await fetchModels(req, scope, suffix);
      if (scope.cancelled) return;
      if (remote.status === 401 || remote.status === 403) {
        catalogState = { ...catalogState, stale: true };
        res.writeHead(remote.status, cleanHeaders(remote.headers));
        res.end(remote.body);
        return;
      }
      if (remote.status < 200 || remote.status >= 300) throw new Error('Cloud catalog failed.');
      const decoded = decodeBody(remote.body, remote.headers['content-encoding'], maxCatalogBytes);
      const catalog = JSON.parse(decoded.toString('utf8'));
      if (!Array.isArray(catalog.models)) throw new Error('Invalid cloud catalog.');
      latestCloud = { catalog, fetchedAt: new Date().toISOString() };
      stats.catalogRefreshes++;
    } catch {
      if (scope.cancelled) return;
      stats.upstreamErrors++;
      const cached = latestCloud ?? readCatalog(cloudCachePath, aliases, true);
      source = latestCloud ? 'memory' : cached ? 'disk-cache' : 'none';
      catalogState = { source, stale: true, lastCloudFetchAt: cached?.fetchedAt ?? null };
      if (!cached) {
        if (remote) {
          res.writeHead(remote.status >= 400 ? remote.status : 502, cleanHeaders(remote.headers));
          res.end(remote.body);
        } else sendError(res, 502, 'cloud_catalog_unavailable', 'Cloud model catalog is unavailable.');
        return;
      }
      latestCloud ??= cached;
    }
    const local = readCatalog(localCatalogPath, aliases);
    const cloudModels = latestCloud.catalog.models.filter((model) => !aliases.has(model?.slug));
    const merged = { ...latestCloud.catalog, models: [...cloudModels, ...(local?.catalog.models ?? [])] };
    const body = Buffer.from(JSON.stringify(merged));
    const etag = `W/"hybrid-${crypto.createHash('sha256').update(body).digest('hex')}"`;
    catalogState = { source, stale: source !== 'live', lastCloudFetchAt: latestCloud.fetchedAt };
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-cache', etag,
      'x-codex-hybrid-catalog-stale': String(catalogState.stale) };
    const accepted = String(req.headers['if-none-match'] ?? '').split(',').map((value) => value.trim());
    if (accepted.includes(etag) || accepted.includes('*')) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'content-length': body.length });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    const scope = beginRequest(req, res);
    const routePath = requestPath(req.url);
    if (!routePath) { sendError(res, 400, 'invalid_path', 'Invalid request path.'); req.resume(); return; }
    if (req.method === 'GET' && routePath.pathname === '/health') {
      const body = Buffer.from(JSON.stringify({ status: 'ok', catalog: catalogState, requests: { ...stats },
        localRuntime: localRuntime?.getStatus() }));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && routePath.pathname === '/models') {
      req.resume();
      void models(req, res, scope, routePath.suffix).catch(() => sendError(res, 502, 'cloud_catalog_unavailable', 'Cloud model catalog is unavailable.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxRequestBytes) {
        rejected = true;
        chunks.length = 0;
        sendError(res, 413, 'request_too_large', 'Request body exceeds the gateway limit.');
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      if (rejected || scope.cancelled) return;
      const body = Buffer.concat(chunks);
      let route = 'cloud';
      if (req.method === 'POST' && /^\/responses(?:\/|$)/.test(routePath.pathname)) {
        try {
          const decoded = decodeBody(body, req.headers['content-encoding'], maxRequestBytes);
          const parsed = JSON.parse(decoded.toString('utf8'));
          if (aliases.has(parsed.model)) route = 'local';
        } catch {
          sendError(res, 400, 'invalid_request', 'Responses request could not be decoded.');
          return;
        }
      }
      if (route === 'local' && localRuntime) {
        scope.local = true;
        localRuntime.onRequestStart();
        void (async () => {
          try {
            await localRuntime.ensureReady({ signal: scope.abortController.signal });
            if (!scope.done && !scope.cancelled) forward(req, res, scope, body, route, routePath.suffix);
          } catch {
            if (scope.cancelled) return;
            stats.upstreamErrors++;
            sendError(res, 503, 'local_runtime_unavailable', 'Local GPU runtime could not become ready.');
          }
        })();
      } else {
        try { forward(req, res, scope, body, route, routePath.suffix); }
        catch { sendError(res, 502, 'upstream_error', 'Endpoint could not be reached.'); }
      }
    });
  });
  server.on('upgrade', (req, socket) => {
    stats.total++;
    // Codex treats 426 as an immediate instruction to use the HTTP/SSE transport.
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('close', () => {
    localRuntime?.close();
    for (const upstream of activeUpstreams) upstream.destroy();
  });
  return { server, getHealth: () => ({ status: 'ok', catalog: { ...catalogState }, requests: { ...stats },
    localRuntime: localRuntime?.getStatus() }),
    close: async () => {
      localRuntime?.close();
      for (const upstream of activeUpstreams) upstream.destroy();
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    } };
}

export async function startHybridGateway(options = {}) {
  const port = options.port ?? 11437;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid gateway port.');
  const gateway = createHybridGateway(options);
  await new Promise((resolve, reject) => {
    gateway.server.once('error', reject);
    gateway.server.listen(port, '127.0.0.1', () => {
      gateway.server.removeListener('error', reject);
      resolve();
    });
  });
  return gateway;
}

const directRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (directRun) {
  const gateway = await startHybridGateway({
    port: Number.parseInt(process.env.CODEX_HYBRID_GATEWAY_PORT ?? '11437', 10),
    localBaseUrl: process.env.CODEX_LOCAL_ADAPTER_URL ?? 'http://127.0.0.1:11435/v1',
    localCatalogPath: process.env.CODEX_HYBRID_LOCAL_CATALOG ?? process.env.CODEX_LOCAL_CATALOG_PATH,
    cloudCachePath: process.env.CODEX_HYBRID_CLOUD_CACHE ?? process.env.CODEX_CLOUD_CACHE_PATH,
    metalOnDemand: process.env.CODEX_HYBRID_METAL_ON_DEMAND === '1',
  });
  process.stdout.write(`Codex hybrid gateway ready at http://127.0.0.1:${gateway.server.address().port}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    void gateway.close().then(() => process.exit(0));
  });
}
