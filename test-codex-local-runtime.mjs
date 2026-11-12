import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalRuntimeController, METAL_HEALTH_URL } from './codex-local-runtime.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fakeRuntime(t, options = {}) {
  const state = { ready: false, starts: 0, stops: 0, healthChecks: 0 };
  const controller = createLocalRuntimeController({ idleMs: 30, startupTimeoutMs: 100, stopTimeoutMs: 50, pollMs: 2,
    fetchImpl: async url => { assert.equal(url, METAL_HEALTH_URL); state.healthChecks++; return { ok: state.ready }; },
    startBackend: async () => { state.starts++; state.ready = true; },
    stopBackend: async () => { state.stops++; state.ready = false; },
    ...options,
  });
  t.after(() => controller.close());
  return { controller, state };
}

test('concurrent local requests share one startup and only idle requests stop the job', async t => {
  const { controller, state } = fakeRuntime(t);
  controller.onRequestStart();
  controller.onRequestStart();
  await Promise.all([controller.ensureReady(), controller.ensureReady()]);
  assert.equal(state.starts, 1);
  assert.equal(controller.getStatus().backendReady, true);
  assert.equal(controller.getStatus().active, 2);
  controller.onRequestEnd();
  await delay(45);
  assert.equal(state.stops, 0);
  controller.onRequestEnd();
  await delay(45);
  assert.equal(state.stops, 1);
  assert.equal(state.ready, false);
  assert.equal(controller.getStatus().active, 0);
});

test('an already healthy job is reused without kickstart and close cancels idle timers', async t => {
  const { controller, state } = fakeRuntime(t);
  state.ready = true;
  controller.onRequestStart();
  await controller.ensureReady();
  assert.equal(state.starts, 0);
  controller.onRequestEnd();
  controller.close();
  await delay(45);
  assert.equal(state.stops, 0);
  await assert.rejects(controller.ensureReady(), { name: 'AbortError' });
});

test('cancelling one waiter leaves the shared startup available to another request', async t => {
  let release;
  let state;
  const runtime = fakeRuntime(t, { startBackend: async () => {
    state.starts++;
    await new Promise(resolve => { release = resolve; });
    state.ready = true;
  } });
  state = runtime.state;
  const { controller } = runtime;
  controller.onRequestStart();
  controller.onRequestStart();
  const abortController = new AbortController();
  const cancelled = controller.ensureReady({ signal: abortController.signal });
  const retained = controller.ensureReady();
  await delay(5);
  abortController.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  controller.onRequestEnd();
  release();
  await retained;
  assert.equal(state.starts, 1);
  assert.equal(controller.getStatus().active, 1);
  controller.onRequestEnd();
});

test('startup readiness has a deadline and failure is reported without backend details', async t => {
  const { controller } = fakeRuntime(t, { startupTimeoutMs: 20,
    fetchImpl: async () => ({ ok: false }), startBackend: async () => {} });
  controller.onRequestStart();
  await assert.rejects(controller.ensureReady(), /startup deadline/);
  assert.equal(controller.getStatus().lastErrorCode, 'startup_failed');
  controller.onRequestEnd();
});

test('new local requests wait for an in-progress stop before restarting the job', async t => {
  let releaseStop;
  let stopStarted;
  const stopped = new Promise(resolve => { stopStarted = resolve; });
  let state;
  const runtime = fakeRuntime(t, { idleMs: 10, stopBackend: async () => {
    state.stops++;
    stopStarted();
    await new Promise(resolve => { releaseStop = resolve; });
    state.ready = false;
  } });
  state = runtime.state;
  const { controller } = runtime;
  controller.onRequestStart();
  await controller.ensureReady();
  controller.onRequestEnd();
  await stopped;
  controller.onRequestStart();
  const next = controller.ensureReady();
  assert.equal(controller.getStatus().stopping, true);
  assert.equal(state.starts, 1);
  releaseStop();
  await next;
  assert.equal(state.starts, 2);
  assert.equal(state.stops, 1);
  controller.onRequestEnd();
});

test('a kickstart accepted during external shutdown is retried until the replacement starts', async t => {
  let state;
  let exiting = true;
  let releaseExit;
  const exited = new Promise(resolve => { releaseExit = () => { exiting = false; resolve(); }; });
  const runtime = fakeRuntime(t, { startRetryMs: 5, startBackend: async () => {
    state.starts++;
    if (exiting) { setTimeout(releaseExit, 12); return; }
    state.ready = true;
  } });
  state = runtime.state;
  const { controller } = runtime;
  controller.onRequestStart();
  await Promise.all([controller.ensureReady(), controller.ensureReady()]);
  await exited;
  assert.ok(state.starts >= 2);
  assert.equal(state.ready, true);
  assert.equal(controller.getStatus().backendReady, true);
  assert.equal(controller.getStatus().lastErrorCode, null);
  controller.onRequestEnd();
});

test('idle shutdown can lose health before the job exits without losing the next local request', async t => {
  let state;
  let exiting = false;
  let signalStop;
  let releaseExit;
  const stopSignalled = new Promise(resolve => { signalStop = resolve; });
  const runtime = fakeRuntime(t, { idleMs: 10, startRetryMs: 5,
    startBackend: async () => {
      state.starts++;
      if (!exiting) state.ready = true;
    },
    stopBackend: async () => {
      state.stops++;
      state.ready = false;
      exiting = true;
      releaseExit = () => { exiting = false; };
      signalStop();
    },
  });
  state = runtime.state;
  const { controller } = runtime;
  controller.onRequestStart();
  await controller.ensureReady();
  controller.onRequestEnd();
  await stopSignalled;
  controller.onRequestStart();
  const next = controller.ensureReady();
  await delay(12);
  assert.ok(state.starts >= 2);
  assert.equal(state.ready, false);
  releaseExit();
  await next;
  assert.equal(state.ready, true);
  assert.equal(state.stops, 1);
  assert.equal(controller.getStatus().active, 1);
  controller.onRequestEnd();
});

test('a transient kickstart rejection is retried without failing the shared request', async t => {
  let state;
  const runtime = fakeRuntime(t, { startRetryMs: 5, startBackend: async () => {
    state.starts++;
    if (state.starts === 1) throw new Error('The old job is still exiting.');
    state.ready = true;
  } });
  state = runtime.state;
  const { controller } = runtime;
  controller.onRequestStart();
  await controller.ensureReady();
  assert.equal(state.starts, 2);
  assert.equal(controller.getStatus().backendReady, true);
  assert.equal(controller.getStatus().lastErrorCode, null);
  controller.onRequestEnd();
});

test('closing the controller cancels pending wake waits without stopping cloud or a running job', async t => {
  const { controller, state } = fakeRuntime(t, { fetchImpl: async () => ({ ok: false }), startBackend: async () => {} });
  controller.onRequestStart();
  const ready = controller.ensureReady();
  await delay(5);
  controller.close();
  await assert.rejects(ready, { name: 'AbortError' });
  controller.onRequestEnd();
  assert.equal(state.stops, 0);
  assert.equal(controller.getStatus().idleScheduled, false);
});
