import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from './connect.mjs';
import { STRATA_MODEL } from './strata-codex-bridge.mjs';

const configDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const health = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
if (!health.loaded || health.max_context !== 131072 || health.model !== STRATA_MODEL) {
  throw new Error(`Expected loaded Strata IQ3_S at 128K. Actual: ${JSON.stringify(health)}`);
}
const marker = path.join(configDir, 'ollamaforge-strata.json');
const previous = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
try {
  fs.writeFileSync(marker, `${JSON.stringify({ model: health.model, context: health.max_context, preset: 'Codex IQ3_S 128K' }, null, 2)}\n`);
  const result = connect();
  if (result.catalogRefreshWarning) throw new Error(`Cloud catalog refresh failed: ${result.catalogRefreshWarning}`);
  console.log(JSON.stringify({ defaultModel: result.defaultModel, localModel: result.strata, cloudModels: result.mergedCatalog?.cloudModels, bridge: 'http://127.0.0.1:11436/api/codex/v1' }, null, 2));
} catch (error) {
  if (previous) fs.writeFileSync(marker, previous);
  else fs.rmSync(marker, { force: true });
  throw error;
}
