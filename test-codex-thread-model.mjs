import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { updateThreadModel } from './codex-thread-model.mjs';

const threadId = '01a0cb5a-d9a8-7ea1-9fa3-2ef071db74af';
const model = 'gpt-6.1-sol';
const effort = 'xhigh';

function mockServer({notificationDelay = 15, flushDelay = 15, notify = true,
  provider = 'openai', readModel = model, earlyExit = false} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const requests = [], timers = [];
  let buffer = '', applied = false, flushed = false, killed = false, exited = false;
  const respond = value => child.stdout.write(JSON.stringify(value)+'\n');
  const schedule = (callback, milliseconds) => {timers.push(setTimeout(callback, milliseconds));};
  child.stdin = new Writable({
    write(part, _, callback) {
      buffer += part;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0,newline)); buffer = buffer.slice(newline+1);
        requests.push(request);
        if (request.method === 'initialize') respond({id:request.id,result:{}});
        if (request.method === 'thread/resume') {
          respond({id:request.id,result:{thread:{id:threadId},model,modelProvider:provider}});
        }
        if (request.method === 'thread/settings/update') {
          respond({id:request.id,result:{}});
          if (earlyExit) schedule(() => {exited = true; child.emit('exit',1,null);}, 1);
          else if (notify) schedule(() => {
            applied = true;
            respond({method:'thread/settings/updated',params:{threadId,
              threadSettings:{model,modelProvider:provider,effort}}});
          }, notificationDelay);
        }
        if (request.method === 'thread/read') {
          assert.equal(applied,true,'read must follow applied settings, not the queued RPC response');
          respond({id:request.id,result:{thread:{id:threadId,model:readModel,modelProvider:provider,reasoningEffort:effort}}});
        }
      }
      callback();
    },
    final(callback) {
      callback();
      if (exited) return;
      schedule(() => {flushed = true; exited = true; child.emit('exit',0,null);},flushDelay);
    },
  });
  child.kill = () => {
    killed = true;
    for (const timer of timers) clearTimeout(timer);
    if (!exited) {exited = true; child.emit('exit',null,'SIGTERM');}
    return true;
  };
  return {child, requests, state:() => ({applied,flushed,killed}),spawnImpl:() => child};
}

test('waits for settings application and graceful storage flush without starting a turn',async () => {
  const mock = mockServer();
  const result = await updateThreadModel({threadId,model,effort,spawnImpl:mock.spawnImpl});
  assert.deepEqual(result,{threadId,model,provider:'openai',effort});
  assert.deepEqual(mock.state(),{applied:true,flushed:true,killed:false});
  assert.deepEqual(mock.requests.map(request => request.method),[
    'initialize','initialized','thread/resume','thread/settings/update','thread/read',
  ]);
  assert.deepEqual(mock.requests.find(request => request.method === 'thread/resume').params,
    {threadId,model,modelProvider:'openai',excludeTurns:true});
  assert.deepEqual(mock.requests.find(request => request.method === 'thread/settings/update').params,
    {threadId,model,effort});
});

test('refuses a resumed legacy provider and still closes gracefully',async () => {
  const mock = mockServer({provider:'local_qwen'});
  await assert.rejects(updateThreadModel({threadId,model,effort,spawnImpl:mock.spawnImpl}),/Close the desktop app/);
  assert.equal(mock.requests.some(request => request.method === 'thread/settings/update'),false);
  assert.equal(mock.state().flushed,true);
  assert.equal(mock.state().killed,false);
});

test('verifies live metadata instead of reporting the requested value as saved',async () => {
  const mock = mockServer({readModel:'other-model'});
  await assert.rejects(updateThreadModel({threadId,model,effort,spawnImpl:mock.spawnImpl}),/did not apply/);
  assert.equal(mock.state().flushed,true);
});

test('missing applied notification times out without hanging',async () => {
  const mock = mockServer({notify:false});
  await assert.rejects(updateThreadModel({threadId,model,effort,spawnImpl:mock.spawnImpl,timeoutMs:20}),/timed out/);
  assert.equal(mock.state().killed,true);
});

test('an early server exit rejects pending settings wait',async () => {
  const mock = mockServer({earlyExit:true});
  await assert.rejects(updateThreadModel({threadId,model,effort,spawnImpl:mock.spawnImpl}),/connection closed/);
});

test('validates the thread identifier before spawning',async () => {
  await assert.rejects(updateThreadModel({threadId:'------------------------------------',model,
    spawnImpl:() => {throw new Error('should not spawn');}}),/thread ID/);
});
