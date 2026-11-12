import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicWrite } from './ollama-chatgpt-hybrid.mjs';

export const name = 'ollamaforge-restart-guard';
export const inject = ['agents', 'webServer'];

export function createRestartHandler(agents, secret) {
  return (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const parent = request.headers['x-ollamaforge-parent-pid'];
    if (parent != null && parent !== String(process.ppid)) {
      response.writeHead(412).end();
      return;
    }
    const running = agents.list().filter(agent => agent.status === 'running').length;
    if (running) {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ running }));
      return;
    }
    // Reserve the idle runtime before the launcher signals it.
    agents.closeInitiators();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ parentPid: process.ppid, pid: process.pid }));
  };
}

export function apply(ctx) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const secret = randomBytes(32).toString('hex');
  atomicWrite(path.join(root, '.runtime', 'deepseek-harness', 'restart.key'), secret);
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/ollamaforge/prepare-restart',
    handler: createRestartHandler(ctx.agents, secret),
  }));
  ctx.provide('ollamaforgeRestartGuardReady', {});
}
