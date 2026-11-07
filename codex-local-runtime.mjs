import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const METAL_JOB_LABEL = 'com.localcodex.metal-server';
export const METAL_HEALTH_URL = 'http://127.0.0.1:11436/health';
const execute = promisify(execFile);

function aborted() {
  const error = new Error('Local runtime wait was cancelled.');
  error.name = 'AbortError';
  return error;
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Manage the dedicated Metal job without using llama.cpp's GPU sleep/wake path. */
export function createLocalRuntimeController(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const domain = uid === null ? null : `gui/${uid}/${METAL_JOB_LABEL}`;
  const idleMs = options.idleMs ?? 300_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 250;
  const startRetryMs = options.startRetryMs ?? 1_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 1_500;
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  if ((!options.startBackend || !options.stopBackend) && (process.platform !== 'darwin' || domain === null)) {
    throw new Error('The managed Metal runtime requires a macOS GUI session.');
  }
  for (const value of [idleMs, startupTimeoutMs, stopTimeoutMs, pollMs, healthTimeoutMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid local runtime timeout.');
  }
  if (!Number.isFinite(startRetryMs) || startRetryMs <= 0) throw new Error('Invalid local runtime retry interval.');
  const startBackend = options.startBackend ?? (({ timeoutMs = 10_000 } = {}) =>
    execute('/bin/launchctl', ['kickstart', domain], { timeout: Math.min(10_000, timeoutMs) }));
  const stopBackend = options.stopBackend ?? (() => execute('/bin/launchctl', ['kill', 'SIGTERM', domain], { timeout: 10_000 }));
  let active = 0;
  let initialized = null;
  let stopping = null;
  let timer = null;
  let closed = false;
  let backendReady = false;
  let lastErrorCode = null;

  async function healthy(remaining = healthTimeoutMs) {
    try {
      const response = await fetchImpl(METAL_HEALTH_URL, {
        signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(healthTimeoutMs, remaining)))),
      });
      const result = response.ok;
      // Health response bodies are unnecessary; release the socket promptly.
      await response.body?.cancel();
      return result;
    } catch { return false; }
  }

  function clearIdle() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function stopWhenIdle() {
    if (closed || active || initialized || stopping) return;
    stopping = (async () => {
      try {
        await stopBackend();
        const deadline = Date.now() + stopTimeoutMs;
        // SIGTERM acknowledges a signal before the process necessarily finishes exiting.
        while (await healthy(deadline - Date.now())) {
          if (Date.now() >= deadline) throw new Error('Metal job did not stop.');
          await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        }
        backendReady = false;
        lastErrorCode = null;
      } catch {
        lastErrorCode = 'idle_stop_failed';
      }
    })().finally(() => { stopping = null; });
    await stopping;
  }

  function scheduleIdle() {
    clearIdle();
    if (closed || active || initialized || stopping) return;
    timer = setTimeout(() => {
      timer = null;
      void stopWhenIdle();
    }, idleMs);
    timer.unref?.();
  }

  async function initialize() {
    const deadline = Date.now() + startupTimeoutMs;
    if (stopping) await stopping;
    if (closed) throw aborted();
    const alreadyHealthy = await healthy(deadline - Date.now());
    if (closed) throw aborted();
    if (alreadyHealthy) { backendReady = true; lastErrorCode = null; return; }
    backendReady = false;
    let nextStartAt = 0;
    while (!closed && Date.now() < deadline) {
      if (Date.now() >= nextStartAt) {
        // The health port can disappear while the old job is still exiting. A
        // successful kickstart then need not launch a replacement. Without -k,
        // retrying is safe for a job that is already loading or running.
        try { await startBackend({ timeoutMs: Math.max(1, deadline - Date.now()) }); }
        catch { /* A job still exiting can also reject a kickstart temporarily. */ }
        nextStartAt = Date.now() + startRetryMs;
        if (closed) throw aborted();
      }
      const ready = await healthy(deadline - Date.now());
      if (closed) throw aborted();
      if (ready) {
        backendReady = true;
        lastErrorCode = null;
        return;
      }
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    if (closed) throw aborted();
    throw new Error('Local GPU did not become ready before the startup deadline.');
  }

  return {
    ensureReady({ signal } = {}) {
      if (closed || signal?.aborted) return Promise.reject(aborted());
      clearIdle();
      if (!initialized) {
        initialized = initialize().catch(error => {
          if (error.name !== 'AbortError') lastErrorCode = 'startup_failed';
          throw error;
        }).finally(() => {
          initialized = null;
          scheduleIdle();
        });
      }
      return waitWithSignal(initialized, signal);
    },
    onRequestStart() {
      if (closed) return;
      active++;
      clearIdle();
    },
    onRequestEnd() {
      active = Math.max(0, active - 1);
      scheduleIdle();
    },
    getStatus() {
      return { active, starting: initialized !== null, stopping: stopping !== null,
        backendReady, idleScheduled: timer !== null, lastErrorCode };
    },
    close() {
      closed = true;
      clearIdle();
    },
  };
}
