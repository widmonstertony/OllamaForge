import fs from 'node:fs';
import crypto from 'node:crypto';

// A small protocol-v4 client avoids launching another OpenClaw process (and
// contending for its SQLite state) for readiness checks and timing probes.
export function loadGatewayIdentity(file) {
  if (!fs.existsSync(file)) {
    const key = crypto.generateKeyPairSync('ed25519');
    const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const identity = {
      deviceId: crypto.createHash('sha256').update(publicKey).digest('hex'),
      publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }),
      privateKeyPem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    try { fs.writeFileSync(file, JSON.stringify(identity), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function connectGateway({ config, identity, timeoutMs = 15000, WebSocketClass = WebSocket }) {
  const port = config.gateway?.port ?? 18789;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local Gateway port.');
  const auth = config.gateway?.auth;
  const token = auth?.mode === 'password' ? undefined : auth?.token;
  const password = auth?.mode === 'password' ? auth.password : undefined;
  if (typeof (token ?? password) !== 'string' || !(token ?? password)) throw new Error('Local Gateway credential is unavailable.');
  const socket = new WebSocketClass(`ws://127.0.0.1:${port}`);
  const pending = new Map(), listeners = new Set();
  let sequence = 0, closed = false;
  const fail = error => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    for (const listener of listeners) listener({ event: 'disconnected', error });
    socket.close();
  };
  const request = (method, params, budget = timeoutMs) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Gateway connection closed.')); return; }
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, budget);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ type: 'req', id, method, params })); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => { const error = new Error('Gateway handshake timed out.'); rejectReady(error); fail(error); }, timeoutMs);
  socket.addEventListener('error', () => { const error = new Error('Local Gateway connection failed.'); rejectReady(error); fail(error); });
  socket.addEventListener('close', () => { const error = new Error('Gateway connection closed.'); rejectReady(error); fail(error); });
  let challenged = false;
  socket.addEventListener('message', async event => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'res') {
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id); clearTimeout(entry.timer);
          if (msg.ok) entry.resolve(msg.payload);
          else {
            const error = new Error(msg.error?.message ?? 'Gateway request failed.');
            error.code = msg.error?.code; error.details = msg.error?.details;
            entry.reject(error);
          }
        }
      } else if (msg.event === 'connect.challenge' && !challenged) {
        challenged = true;
        const { nonce, ts } = msg.payload ?? {};
        if (typeof nonce !== 'string' || !Number.isSafeInteger(ts) || ts < 0) throw new Error('Invalid Gateway challenge.');
        const scopes = ['operator.read', 'operator.write'];
        const payload = ['v3', identity.deviceId, 'cli', 'cli', 'operator', scopes.join(','), String(ts), token ?? '', nonce, 'win32', ''].join('|');
        const publicKey = crypto.createPublicKey(identity.publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
        const hello = await request('connect', {
          minProtocol: 4, maxProtocol: 4,
          client: { id: 'cli', version: '2026.10.8', platform: 'win32', mode: 'cli' },
          role: 'operator', scopes, caps: [], auth: token ? { token } : { password },
          device: { id: identity.deviceId, publicKey, signedAt: ts, nonce,
            signature: crypto.sign(null, Buffer.from(payload), identity.privateKeyPem).toString('base64url') },
        });
        if (hello.type !== 'hello-ok' || hello.protocol !== 4) throw new Error('Unsupported Gateway protocol.');
        resolveReady(hello);
      } else {
        for (const listener of listeners) listener(msg);
      }
    } catch (error) { rejectReady(error); fail(error); }
  });
  try {
    const hello = await ready;
    return { hello, request, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }, close: () => fail(new Error('Client closed.')) };
  } finally { clearTimeout(timer); }
}

export async function gatewayReply(client, { sessionKey, message, marker, timeoutMs = 300000 }) {
  const start = performance.now();
  let firstTextMs, ackMs, runId, settle, rejectResult;
  const result = new Promise((resolve, reject) => { settle = resolve; rejectResult = reject; });
  const cleanup = client.onEvent(event => {
    if (event.event === 'disconnected') { rejectResult(event.error); return; }
    if (event.event !== 'chat' || event.payload?.sessionKey !== sessionKey) return;
    const payload = event.payload;
    if (runId && payload.runId && payload.runId !== runId) return;
    const content = payload.message?.content;
    const text = typeof content === 'string' ? content : (content ?? []).map(c => c.text ?? '').join('');
    if (text && firstTextMs === undefined) firstTextMs = Math.round(performance.now() - start);
    if (payload.state === 'final') {
      if (!text.includes(marker)) { rejectResult(new Error('Gateway reply did not contain the expected verification marker.')); return; }
      settle({ runId: payload.runId ?? runId, ackMs, firstTextMs, totalMs: Math.round(performance.now() - start), text });
    } else if (payload.state === 'error' || payload.state === 'aborted') rejectResult(new Error(`Gateway run ${payload.state}.`));
  });
  const timer = setTimeout(() => rejectResult(new Error('Gateway reply timed out.')), timeoutMs);
  // Attach the rejection handler before awaiting acknowledgement.
  const completed = result.finally(() => { cleanup(); clearTimeout(timer); });
  completed.catch(() => {});
  try {
    const ack = await client.request('chat.send', { sessionKey, message, idempotencyKey: crypto.randomUUID() }, Math.min(timeoutMs, 30000));
    runId = ack.runId; ackMs = Math.round(performance.now() - start);
    const reply = await completed;
    if (!reply.runId) throw new Error('Gateway reply has no run identity.');
    const settled = await client.request('agent.wait', { runId: reply.runId, timeoutMs: 30000 }, 35000);
    if (settled.status !== 'ok') throw new Error(`Gateway run did not settle successfully (${settled.status ?? 'unknown'}).`);
    return { ...reply, settledMs: Math.round(performance.now() - start) };
  } catch (error) { error.runAccepted = Boolean(runId); throw error; }
  finally { cleanup(); clearTimeout(timer); }
}
