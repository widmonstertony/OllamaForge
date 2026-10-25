import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
function writeJson(file, value) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing a linked test receipt.');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
export function prepareDesktopProbe(root) {
  const id = crypto.randomBytes(8).toString('hex');
  const parent = path.resolve(root, '.ollamaforge-desktop-tests');
  if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Refusing a linked test directory.');
  const directory = path.resolve(root, '.ollamaforge-desktop-tests', id);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `OllamaForge-native-${id}.txt`);
  const initial = 'Temporary OllamaForge native control test.\nAppend the test marker using the Computer Use plugin.\n';
  fs.writeFileSync(file, initial);
  const manifest = {
    version: 1, id, directory, nativeFile: file, baselineHash: hash(initial),
    markerA: `NATIVE_A_${id}`, markerB: `NATIVE_B_${id}`,
    githubBranch: `ollamaforge-test/${id}`, githubFile: `.ollamaforge-probe/${id}.json`,
    githubContent: { id, purpose: 'OllamaForge disposable GitHub read/write test' },
  };
  const manifestPath = path.join(directory, 'manifest.json');
  writeJson(manifestPath, manifest);
  return { manifestPath, ...manifest };
}

export function readDesktopProbe(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const directory = path.resolve(path.dirname(manifestPath));
  const expectedFile = path.join(directory, `OllamaForge-native-${manifest.id}.txt`);
  if (manifest.version !== 1 || !/^[a-f0-9]{16}$/.test(manifest.id) ||
      manifest.markerA !== `NATIVE_A_${manifest.id}` || manifest.markerB !== `NATIVE_B_${manifest.id}` ||
      path.resolve(manifest.directory) !== directory || path.resolve(manifest.nativeFile) !== expectedFile ||
      path.basename(directory) !== manifest.id || path.basename(path.dirname(directory)) !== '.ollamaforge-desktop-tests' ||
      fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(path.dirname(directory)).isSymbolicLink() || fs.lstatSync(expectedFile).isSymbolicLink()) {
    throw new Error('Invalid desktop-test manifest or fixture paths.');
  }
  return manifest;
}

export function verifyNativeProbe(manifestPath, round) {
  const manifest = readDesktopProbe(manifestPath);
  const text = fs.readFileSync(manifest.nativeFile, 'utf8');
  const fileHash = hash(text);
  const reportFile = path.join(manifest.directory, 'native.json');
  const previous = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  if (!text.includes(manifest.markerA) || fileHash === manifest.baselineHash) throw new Error('Native typing/save has not been verified.');
  if (round === 1 && text.includes(manifest.markerB)) throw new Error('Run round 1 before the reopen test.');
  if (round === 2 && (!previous?.round1 || !text.includes(manifest.markerB) || fileHash === previous.round1.hash)) {
    throw new Error('Native reopen/second save has not been verified.');
  }
  if (![1, 2].includes(round)) throw new Error('Native round must be 1 or 2.');
  const result = { ...(previous ?? {}), id: manifest.id, [`round${round}`]: { passed: true, hash: fileHash, at: new Date().toISOString() } };
  writeJson(reportFile, result);
  return result;
}

export function startChromeProbe(manifestPath) {
  const manifest = readDesktopProbe(manifestPath);
  const server = http.createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/verify') {
      let body = ''; for await (const part of request) { body += part; if (body.length > 2048) break; }
      let value; try { value = JSON.parse(body); } catch { }
      const passed = value?.marker === manifest.id;
      if (passed) writeJson(path.join(manifest.directory, 'chrome.json'), { id: manifest.id, passed, at: new Date().toISOString() });
      response.writeHead(passed ? 200 : 400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ passed })); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><title>OllamaForge Chrome test ${manifest.id}</title><h1>OllamaForge Chrome test</h1><p>Enter: ${manifest.id}</p><label>Test marker <input id="marker"></label><button id="verify">Verify browser input</button><p id="result">READY</p><script>document.getElementById('verify').onclick=async()=>{const r=await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({marker:document.getElementById('marker').value})});document.getElementById('result').textContent=r.ok?'PASS':'FAIL';};</script>`);
  });
  server.listen(0, '127.0.0.1');
  return server;
}

export function verifyChromeProbe(manifestPath) {
  const manifest = readDesktopProbe(manifestPath);
  const file = path.join(manifest.directory, 'chrome.json');
  const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (result?.id !== manifest.id || !result.passed) throw new Error('Chrome input/click has not been verified.');
  return result;
}

export function verifyGitHubProbe(manifestPath, repository) {
  const manifest = readDesktopProbe(manifestPath);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const expectedBranch = `ollamaforge-test/${manifest.id}`;
  const expectedFile = `.ollamaforge-probe/${manifest.id}.json`;
  if (manifest.githubBranch !== expectedBranch || manifest.githubFile !== expectedFile) throw new Error('Invalid disposable GitHub test branch.');
  git('fetch', '--no-tags', 'origin', `refs/heads/${expectedBranch}`);
  const commit = git('rev-parse', 'FETCH_HEAD');
  const content = JSON.parse(git('show', `${commit}:${expectedFile}`));
  if (content.id !== manifest.id || content.purpose !== manifest.githubContent.purpose) throw new Error('GitHub round-trip marker mismatch.');
  const result = { id: manifest.id, passed: true, branch: expectedBranch, commit, at: new Date().toISOString() };
  writeJson(path.join(manifest.directory, 'github.json'), result);
  return result;
}

export function writeGitHubProbe(manifestPath, repository) {
  const manifest = readDesktopProbe(manifestPath);
  const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = run('git', ['-C', repository, 'remote', 'get-url', 'origin']);
  const match = origin.match(/^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw new Error('The disposable write test requires an explicitly configured github.com origin.');
  const repo = match[1];
  const endpoint = `repos/${repo}`;
  const api = (suffix, args = []) => JSON.parse(run('gh', ['api', endpoint + suffix, ...args]));
  const branch = `ollamaforge-test/${manifest.id}`;
  const file = `.ollamaforge-probe/${manifest.id}.json`;
  if (manifest.githubBranch !== branch || manifest.githubFile !== file) throw new Error('Invalid disposable write target.');
  const missing = (error) => /HTTP 404|\(404\)/.test(String(error.stderr ?? error.message));
  const base = api('');
  const head = api(`/git/ref/heads/${base.default_branch}`).object.sha;
  let existing;
  try { existing = api(`/git/ref/heads/${branch}`); } catch (error) { if (!missing(error)) throw error; }
  if (!existing) {
    const body = path.join(manifest.directory, 'github-branch-body.json');
    writeJson(body, { ref: `refs/heads/${branch}`, sha: head });
    api('/git/refs', ['--method', 'POST', '--input', body]);
  }
  let previous;
  try { previous = api(`/contents/${file}?ref=${encodeURIComponent(branch)}`); } catch (error) { if (!missing(error)) throw error; }
  if (previous) {
    const content = JSON.parse(Buffer.from(previous.content, 'base64').toString('utf8'));
    if (content.id !== manifest.id || content.purpose !== manifest.githubContent.purpose) throw new Error('Existing test file belongs to another operation.');
  }
  const body = path.join(manifest.directory, 'github-file-body.json');
  writeJson(body, {
    branch, message: 'Test desktop GitHub connectivity',
    content: Buffer.from(JSON.stringify(manifest.githubContent)).toString('base64'),
    ...(previous ? { sha: previous.sha } : {}),
  });
  const response = api(`/contents/${file}`, ['--method', 'PUT', '--input', body]);
  const result = verifyGitHubProbe(manifestPath, repository);
  if (result.commit !== response.commit.sha) throw new Error('GitHub write/read-back commit mismatch.');
  result.writeBackend = 'authenticated GitHub CLI';
  writeJson(path.join(manifest.directory, 'github.json'), result);
  return result;
}

export function verifyDesktopProbe(manifestPath) {
  const manifest = readDesktopProbe(manifestPath);
  const nativeFile = path.join(manifest.directory, 'native.json');
  const githubFile = path.join(manifest.directory, 'github.json');
  const native = fs.existsSync(nativeFile) ? JSON.parse(fs.readFileSync(nativeFile, 'utf8')) : null;
  const github = fs.existsSync(githubFile) ? JSON.parse(fs.readFileSync(githubFile, 'utf8')) : null;
  const chrome = verifyChromeProbe(manifestPath);
  if (native?.id !== manifest.id || !native.round1?.passed || !native.round2?.passed || github?.id !== manifest.id || !github.passed) {
    throw new Error('All three desktop components must pass; missing tests are failures, not skips.');
  }
  if (hash(fs.readFileSync(manifest.nativeFile)) !== native.round2.hash) throw new Error('The native test file changed after verification.');
  const result = { id: manifest.id, allPassed: true, native, chrome, github };
  writeJson(path.join(manifest.directory, 'result.json'), result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, manifestPath, value] = process.argv.slice(2);
    if (command === 'prepare') console.log(JSON.stringify(prepareDesktopProbe(manifestPath ?? process.cwd()), null, 2));
    else if (command === 'native') console.log(JSON.stringify(verifyNativeProbe(manifestPath, Number(value)), null, 2));
    else if (command === 'chrome') console.log(JSON.stringify(verifyChromeProbe(manifestPath), null, 2));
    else if (command === 'github') console.log(JSON.stringify(verifyGitHubProbe(manifestPath, value ?? process.cwd()), null, 2));
    else if (command === 'github-write') console.log(JSON.stringify(writeGitHubProbe(manifestPath, value ?? process.cwd()), null, 2));
    else if (command === 'verify') console.log(JSON.stringify(verifyDesktopProbe(manifestPath), null, 2));
    else if (command === 'serve') {
      const server = startChromeProbe(manifestPath);
      server.on('listening', () => console.log(`http://127.0.0.1:${server.address().port}`));
    } else throw new Error('Usage: desktop-smoke.mjs prepare [repo] | native <manifest> <1|2> | serve <manifest> | chrome <manifest> | github[-write] <manifest> [repo] | verify <manifest>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
