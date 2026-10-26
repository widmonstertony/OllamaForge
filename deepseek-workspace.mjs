import fs from 'node:fs';
import path from 'node:path';

export const name = 'ollamaforge-default-workspace';
export const inject = ['workspaceRegistry'];
export async function apply(ctx, config) {
  const directory = fs.realpathSync(config.directory);
  if (!fs.statSync(directory).isDirectory()) throw new Error('Workspace must be an existing directory.');
  await ctx.workspaceRegistry.create(directory, path.basename(directory));
}
