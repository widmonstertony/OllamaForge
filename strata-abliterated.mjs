import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTargetFile } from './deploy.mjs';

const revision = '90a3350cd800ec1fe0d1660a38414ad9e985782f';
const source = `https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF/resolve/${revision}/IQ3_S`;
export const shards = [
  { name: 'Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00001-of-00002.gguf', bytes: 55063448064, sha256: '40f369eca301ec6ea318dbb671b3132c26a2f0b89aa5458a7051b33215ee296c' },
  { name: 'Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00002-of-00002.gguf', bytes: 28800138432, sha256: '316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113' },
];

export async function prepareShards(directory, ensure = ensureTargetFile) {
  fs.mkdirSync(directory, { recursive: true });
  // Upstream setup searches the entire folder and gives a stock filename priority.
  for (const name of fs.readdirSync(directory)) {
    if (/\.gguf$/i.test(name) && !shards.some(shard => shard.name === name)) {
      throw new Error(`Choose a directory containing only the two SC117 IQ3_S shards. Also found ${name}.`);
    }
  }
  for (const shard of shards) {
    await ensure({ targetPath: path.join(directory, shard.name), target: { ...shard, url: `${source}/${shard.name}` } });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareShards(path.resolve(process.argv[2]));
}
