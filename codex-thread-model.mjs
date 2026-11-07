import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function updateThreadModel({threadId, model, effort, cliPath, spawnImpl = spawn,
  timeoutMs = 30_000, shutdownTimeoutMs = 15_000} = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId ?? '') ||
    typeof model !== 'string' || !model.trim()) throw new Error('A thread ID and model are required.');
  const cli = cliPath ?? [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ].find(candidate => fs.existsSync(candidate)) ?? 'codex';
  const child = spawnImpl(cli, ['app-server', '--listen', 'stdio://'], {stdio:['pipe','pipe','pipe']});
  const pending = new Map();
  let buffer = '', sequence = 0, transportError, settingsRequested = false, appliedSettings, settingsWaiter;
  let exited = false, resolveExit;
  const exitPromise = new Promise(resolve => {resolveExit = resolve;});
  const rejectPending = error => {
    transportError ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    settingsWaiter?.reject(error); settingsWaiter = null;
  };
  child.once('error', error => {rejectPending(error); exited = true; resolveExit({error});});
  child.once('exit', (code, signal) => {
    exited = true; resolveExit({code, signal});
    rejectPending(new Error('Codex connection closed.'));
  });
  child.stdin.on('error', rejectPending);
  child.stdout.on('error', rejectPending);
  // Runtime warnings can contain tool connection details; never mirror them or authentication data.
  child.stderr.on('data', () => {});
  child.stdout.on('data', part => {
    buffer += part;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message; try {message = JSON.parse(line);} catch {continue;}
      if (settingsRequested && message.method === 'thread/settings/updated' && message.params?.threadId === threadId) {
        const settings = message.params.threadSettings;
        if (settings?.model === model && settings.modelProvider === 'openai' && (!effort || settings.effort === effort)) {
          appliedSettings = settings;
          settingsWaiter?.resolve(settings); settingsWaiter = null;
        }
      }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve,reject) => {
    if (transportError || exited) {reject(transportError ?? new Error('Codex connection closed.')); return;}
    const id = ++sequence; pending.set(id, {resolve,reject});
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const timer = setTimeout(() => {rejectPending(new Error('Codex thread settings timed out.'));child.kill();}, timeoutMs);
  const closeGracefully = async () => {
    if (!exited) child.stdin.end();
    let shutdownTimer;
    try {
      return await Promise.race([exitPromise, new Promise((_,reject) => {
        shutdownTimer = setTimeout(() => {
          child.kill();
          reject(new Error('Codex did not finish saving the thread settings before shutdown.'));
        }, shutdownTimeoutMs);
      })]);
    } finally {clearTimeout(shutdownTimer);}
  };
  let failure;
  try {
    await rpc('initialize',{clientInfo:{name:'ollamaforge-model-repair',version:'1'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const resumed = await rpc('thread/resume',{threadId,model,modelProvider:'openai',excludeTurns:true});
    if (resumed.thread?.id !== threadId || resumed.modelProvider !== 'openai' || resumed.model !== model) {
      throw new Error('Close the desktop app once before migrating this loaded legacy conversation.');
    }
    // The RPC response acknowledges queuing, so wait for Core's applied settings notification.
    settingsRequested = true;
    await rpc('thread/settings/update',{threadId,model,...(effort ? {effort} : {})});
    if (!appliedSettings) await new Promise((resolve,reject) => {
      if (transportError) reject(transportError);
      else settingsWaiter = {resolve,reject};
    });
    const verified = (await rpc('thread/read',{threadId,includeTurns:false})).thread;
    if (verified?.id !== threadId || verified.modelProvider !== 'openai' || verified.model !== model ||
      (effort && verified.reasoningEffort !== effort)) throw new Error('Codex did not apply the requested thread settings.');
    clearTimeout(timer);
    // Stdio EOF drains and shuts down loaded threads, flushing storage before the process exits.
    const exit = await closeGracefully();
    if (exit.error || exit.code !== 0 || exit.signal) throw new Error('Codex could not finish saving the thread settings.');
    return {threadId,model,provider:'openai',effort:verified.reasoningEffort ?? appliedSettings.effort};
  } catch (error) {
    failure = error; throw error;
  } finally {
    clearTimeout(timer);
    if (!exited) {
      try {await closeGracefully();} catch (error) {if (!failure) throw error;}
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(JSON.stringify(await updateThreadModel({threadId:process.argv[2],model:process.argv[3],effort:process.argv[4]})));
}
