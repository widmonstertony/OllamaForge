export const name = 'ollamaforge-qwen27b-control-tools';
export const inject = ['systemPrompt'];

const development = ['read', 'write', 'edit', 'bash', 'shell', 'grep', 'glob', 'ls', 'find'];
const browser = ['list_pages', 'select_page', 'new_page', 'close_page', 'navigate_page',
  'take_snapshot', 'take_screenshot', 'click', 'fill', 'fill_form', 'press_key',
  'hover', 'scroll', 'wait_for'].map(name => 'mcp__chrome-devtools-mcp__' + name);
const desktop = ['list_apps', 'list_windows', 'get_window_state', 'verify_state',
  'bring_to_front', 'click', 'double_click', 'type_text', 'press_key', 'hotkey',
  'set_value', 'scroll', 'drag', 'invoke_menu'].map(name => 'cua_driver_native__' + name);
const enabled = new Set([...development, ...browser, ...desktop]);

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return { ...assembled, tools: assembled.tools.filter(tool => enabled.has(tool.name)) };
  });
}
