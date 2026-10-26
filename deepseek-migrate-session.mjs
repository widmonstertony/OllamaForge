import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'ollamaforge-preserving-session-migration';
export const inject = ['agents', 'sessions', 'agentPresets', 'workspaceRegistry', 'agentDefaultModel', 'sessionController'];

export function completedSessionSnapshot(bytes, sourceId) {
  const records = zstdDecompressSync(bytes).toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const header = records[0];
  if (header?.type !== 'session' || header.version !== 4 || header.id !== sourceId) throw new Error('Migration source identity/version mismatch.');
  const events = records.slice(1);
  if (!events.every((event, index) => event.seq === index)) throw new Error('Migration source has non-contiguous events.');
  if (events.at(-1)?.type !== 'turn/end') throw new Error('Migration requires a fully ended turn.');
  return { header, events };
}

export async function apply(ctx, config) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const request = JSON.parse(fs.readFileSync(config.requestFile, 'utf8'));
  const directory = fs.realpathSync(request.directory);
  if (!/^session-[a-f0-9-]+$/.test(request.sourceId) || !/^session-[a-f0-9-]+$/.test(request.targetId) || request.sourceId === request.targetId) throw new Error('Invalid session migration identity.');
  const require = createRequire(path.join(root, '.runtime', 'deepseek-harness', 'package.json'));
  const [{ buildForkSeed }, { SessionLogOffset }] = await Promise.all([
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session/fork')).href),
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href),
  ]);
  let existing;
  try { existing = await ctx.sessionController.inspect(request.targetId); } catch { }
  if (!existing) {
    const { events } = completedSessionSnapshot(fs.readFileSync(request.sourceFile), request.sourceId);
    const seed = buildForkSeed(events, events.at(-1).seq);
    const preset = (await ctx.agentPresets.resolve('standard')).id;
    const selected = ctx.agentDefaultModel.currentSelection();
    const handle = await ctx.agents.create({
      sessionId: request.targetId, seed, inheritedEventCount: SessionLogOffset(events.length),
      meta: { cwd: directory, parentSession: request.sourceId, isSeeded: true, agentPreset: preset },
      agentOptions: selected,
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset); },
    });
    await ctx.sessions.flush(handle.agent.session);
    const workspace = await ctx.workspaceRegistry.create(directory, path.basename(directory));
    await workspace.attachSession(request.targetId);
    const titles = ctx.get('sessionTitle');
    const priorTitle = events.findLast(event => event.type === 'session/title')?.data.title ?? 'Recovered session';
    if (titles) titles.rename(handle.agent.session, request.title ?? `${priorTitle} · 已迁移`);
  } else if (fs.realpathSync(existing.meta.cwd) !== directory || existing.meta.parentSession !== request.sourceId) {
    throw new Error('Existing migration target belongs to another operation.');
  }
  const checked = await ctx.sessionController.inspect(request.targetId);
  if (checked.meta.cwd !== directory || checked.meta.parentSession !== request.sourceId) throw new Error('Migrated session header did not retain its project/parent.');
  fs.writeFileSync(request.receiptFile, JSON.stringify({ sourceId: request.sourceId, targetId: request.targetId, directory,
    inheritedEventCount: checked.inheritedEventCount, allPassed: true, at: new Date().toISOString() }, null, 2));
  ctx.provide('ollamaforgeMigrationReady', true);
}
