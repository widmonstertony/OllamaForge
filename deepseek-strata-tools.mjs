import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'ollamaforge-strata-tools';
export const inject = ['tools', 'systemPrompt'];
const loader = 'load_tools';
const core = new Set([loader, 'read']);
const desktop = ['list_windows', 'bring_to_front', 'get_window_state', 'click', 'type_text', 'press_key', 'hotkey', 'scroll']
  .map(name => 'cua_driver_native__' + name);
const chrome = ['list_pages', 'new_page', 'select_page', 'take_snapshot', 'click', 'fill', 'press_key', 'navigate_page']
  .map(name => 'mcp__chrome-devtools-mcp__' + name);
const nativeBrowser = ['browser_prepare', 'get_browser_state', 'browser_navigate', 'browser_click', 'browser_type', 'browser_dialog']
  .map(name => 'cua_driver_native__' + name);
const groups = new Map([['desktop', desktop], ['cua_driver_native', desktop], ['chrome', chrome],
  ['mcp__chrome-devtools-mcp', chrome], ['github', ['pwsh', 'bash']], ['files', ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash']]]);

export function selectTools(names, available) {
  const matches = names.flatMap(name => {
    const group = name === 'chrome' && !chrome.some(tool => available.includes(tool)) ? nativeBrowser : groups.get(name.replace(/__$/, ''));
    return group ?? [name];
  });
  return [...new Set(matches.filter(name => available.includes(name)))];
}

// Retain the actual agent's post-policy catalog. Loading exposes a schema on
// the following model step. Tool execution and approval stay with the Harness.
export function toolPresentation(agent, catalog, selected) {
  if (!catalog.some(tool => tool.name === loader)) return catalog;
  if (!selected.size) {
    const previous = agent.session?.requestHeader()?.tools ?? [];
    if (previous.some(tool => tool.name === loader)) {
      for (const tool of previous) selected.add(tool.name);
    }
    selected.add(loader);
  }
  return catalog.filter(tool => core.has(tool.name) || selected.has(tool.name));
}

export async function apply(ctx) {
  const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '.runtime/deepseek-harness/package.json'));
  const { defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  const agents = new WeakMap();
  ctx.tools.register(defineTool({
    name: loader,
    description: 'Enable tools for the next step. Load desktop for native computer control, chrome for Chrome, github for a shell with gh, or files for coding. Pass groups together or request individual tools. An empty list shows the catalog.',
    parameters: { names: { type: 'array', items: { type: 'string' }, description: 'Groups or exact names, e.g. ["desktop","chrome"].' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ names = [] }, { agent }) {
      const state = agents.get(agent);
      if (!state) throw new Error('Tool selection requires the current agent context.');
      if (!names.length) return state.available.join(', ');
      const matches = selectTools(names, state.available);
      if (!matches.length) return 'No matches. Available names: ' + state.available.join(', ');
      for (const name of matches) state.selected.add(name);
      return 'Available next step: ' + matches.join(', ');
    },
  }));
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const result = await next();
    if (!agent) return result;
    const state = agents.get(agent) ?? { selected: new Set() };
    state.available = result.tools.map(tool => tool.name);
    agents.set(agent, state);
    return { ...result, tools: toolPresentation(agent, result.tools, state.selected) };
  });
}
