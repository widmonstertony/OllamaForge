import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Copy first, keep the original, and reject conflicts before writing anything.
export function preserveHarnessWork({ sessionFile, sourceDirectory, targetDirectory, backupDirectory }) {
  for (const directory of [sourceDirectory, path.dirname(targetDirectory)]) {
    if (!fs.statSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Recovery needs ordinary existing project directories.');
  }
  const log = fs.readFileSync(sessionFile);
  const events = zstdDecompressSync(log).toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (!events.some(event => event.type === 'session')) throw new Error('Invalid session snapshot.');
  const files = fs.readdirSync(sourceDirectory).filter(name => name !== '__pycache__').map(name => {
    const from = path.join(sourceDirectory, name), to = path.join(targetDirectory, name);
    if (!fs.lstatSync(from).isFile() || fs.lstatSync(from).isSymbolicLink()) throw new Error('Select a file-only recovery directory.');
    const bytes = fs.readFileSync(from);
    if (fs.existsSync(to) && (fs.lstatSync(to).isSymbolicLink() || sha(fs.readFileSync(to)) !== sha(bytes))) throw new Error(`Refusing to overwrite existing work: ${to}`);
    return { name, from, to, bytes, sha256: sha(bytes) };
  });
  if (fs.existsSync(targetDirectory) && fs.lstatSync(targetDirectory).isSymbolicLink()) throw new Error('Refusing a linked destination.');
  fs.mkdirSync(backupDirectory, { recursive: false });
  fs.writeFileSync(path.join(backupDirectory, 'session.v4.jsonl.zstd'), log, { flag: 'wx' });
  fs.mkdirSync(path.join(backupDirectory, 'files'));
  fs.mkdirSync(targetDirectory, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(backupDirectory, 'files', file.name), file.bytes, { flag: 'wx' });
    if (!fs.existsSync(file.to)) fs.writeFileSync(file.to, file.bytes, { flag: 'wx' });
    if (sha(fs.readFileSync(file.to)) !== file.sha256) throw new Error('Recovery copy hash mismatch.');
  }
  const receipt = { sessionFile, eventCount: events.length, sessionSha256: sha(log), sourceDirectory, targetDirectory,
    files: files.map(({ name, sha256 }) => ({ name, sha256 })), at: new Date().toISOString() };
  fs.writeFileSync(path.join(backupDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
