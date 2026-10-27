import fs from 'node:fs';
import { connectGateway, gatewayReply, loadGatewayIdentity } from './openclaw-gateway.mjs';

const delay = (ms, signal) => new Promise(resolve => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
});

// HTTP/UI readiness alone does not prove that the agent and model can reply.
// Warm a dedicated session, keeping the user's main chat untouched.
export async function warmOpenClaw({ configFile, identityFile, receiptFile, pid, model, signal, log = console.log, wait = delay }) {
  const start = performance.now();
  const deadline = Date.now() + 15 * 60000;
  let lastError = '', inferenceAttempts = 0;
  while (!signal.aborted && Date.now() < deadline) {
    let client, phase = 'Strata model';
    try {
      const healthResponse = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(5000) });
      const health = await healthResponse.json();
      if (!healthResponse.ok || health.service !== 'strata' || !health.loaded || health.model !== model) throw new Error('Waiting for the saved Strata model.');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      phase = 'Gateway HTTP readiness';
      const port = config.gateway?.port ?? 18789;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local Gateway port.');
      // Do not repeatedly authenticate/open SQLite while startup owns admission.
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (!ready.ok) throw new Error('Waiting for Gateway startup readiness.');
      phase = 'Gateway authentication';
      client = await connectGateway({ config, identity: loadGatewayIdentity(identityFile), timeoutMs: 15000 });
      const marker = 'OLLAMAFORGE_OPENCLAW_READY';
      phase = 'agent inference and settlement';
      const reply = await gatewayReply(client, {
        sessionKey: 'agent:main:ollamaforge-startup-check',
        message: `这是 OllamaForge 登录启动自检。不要调用工具或外部服务，只回复 ${marker}。`, marker,
      });
      if (signal.aborted) return;
      const receipt = { pid, model, verifiedAt: new Date().toISOString(), startupMs: Math.round(performance.now() - start), replyMs: reply.totalMs, firstTextMs: reply.firstTextMs };
      fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
      log(`OpenClaw ready: authenticated agent/model check passed in ${receipt.startupMs} ms (reply ${receipt.replyMs} ms).`);
      return receipt;
    } catch (error) {
      if (signal.aborted) return;
      const message = `OpenClaw preparing (${phase}): ${error.message}`;
      if (message !== lastError) { log(message); lastError = message; }
      // HTTP readiness can precede per-agent background database admission.
      // A rejected startup request has not exercised inference and must not
      // exhaust the three real-inference failure attempts.
      if (error.runAccepted) inferenceAttempts++;
      if (inferenceAttempts >= 3) { log('OpenClaw warmup failed three inference checks; readiness was not published. Inspect the runtime logs.'); return; }
    } finally { client?.close(); }
    await wait(3000, signal);
  }
  if (!signal.aborted) log('OpenClaw startup deadline exceeded; readiness was not published. Inspect the runtime logs.');
}
