import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { RUNTIME, connectHarness, runHarnessTask, auditControlEvents } from './deepseek-harness.mjs';

await connectHarness({ port: 3080 });
const id = crypto.randomBytes(8).toString('hex');
const title = `OllamaForge Harness Control ${id}`;
const directory = path.join(RUNTIME, `controls-test-${id}`);
fs.mkdirSync(directory);
const receipts = {};
const server = http.createServer(async (request, response) => {
  if (request.method === 'POST' && /^\/(native|chrome)$/.test(request.url)) {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 2048) break; }
    const kind = request.url.slice(1);
    if (body !== `${kind.toUpperCase()}_${id}`) { response.writeHead(400); response.end('Wrong marker'); return; }
    receipts[kind] = { passed: true, at: new Date().toISOString() };
    response.end('PASS'); return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><title>${title}</title></head><body style="font:24px sans-serif;padding:30px"><h1>${title}</h1><p>This page is a disposable local driver test.</p><p><label>Native marker <input id="native" style="font:24px sans-serif"></label> <button onclick="verify('native')" style="font:24px sans-serif">Verify Native</button> <span id="native-result">READY</span></p><p><label>Chrome marker <input id="chrome" style="font:24px sans-serif"></label> <button onclick="verify('chrome')" style="font:24px sans-serif">Verify Chrome</button> <span id="chrome-result">READY</span></p><script>async function verify(kind){const r=await fetch('/'+kind,{method:'POST',body:document.getElementById(kind).value});document.getElementById(kind+'-result').textContent=await r.text();}</script></body></html>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  const task = `Verify the installed computer driver and Chrome driver on this Windows PC using ONLY this disposable page.
1. Use Chrome DevTools tools to open ${url} in a new page. Its title is ${title}.
2. Use cua_driver_native tools to list windows and find the exact Chrome window containing this title. Get a fresh window state. For this scoped Windows test use foreground delivery from the start. Click the Native marker input, type NATIVE_${id}, then click Verify Native. Refresh native window state and confirm PASS. Do not use browser tools, JavaScript, shell, or HTTP requests to fill or submit the Native marker. Use native click/type actions.
3. Use Chrome DevTools snapshot/fill/click tools to fill Chrome marker with CHROME_${id} and click Verify Chrome. Take another browser snapshot and confirm both show PASS. Do not use evaluate_script, shell, or HTTP requests to synthesize either result. Do not touch other apps, tabs, files or permission settings.
4. Reply NATIVE_AND_CHROME_PASS only after both real actions succeed. If the desktop is locked or a permission is missing, report that failure and stop.`;
  const events = await runHarnessTask(task, directory);
  const result = { id, native: receipts.native ?? { passed: false }, chrome: receipts.chrome ?? { passed: false }, ...auditControlEvents(events, id, receipts) };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  if (!result.allPassed) throw new Error(`Computer/Chrome actual actions did not all pass. Inspect ${directory}`);
  console.log(`PASS: native click/type and Chrome fill/click verified by separate HTTP receipts and Harness tool events. Evidence: ${directory}`);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
