import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'ollamaforge-native-computer';
export const inject = ['computerUse', 'tools', 'systemPrompt', 'browserUse'];

// The upstream MCP text projection omits structuredContent. Native actions
// require its exact per-snapshot handles; never invent handles from indices.
export function projectNativeResult(result) {
  const state = result.structuredContent;
  if (!state?.snapshot_id || !Array.isArray(state.elements)) return result;
  const elements = state.elements.slice(0, 120).map(element => Object.fromEntries(
    ['element_index', 'element_token', 'role', 'label', 'value', 'frame', 'actions', 'enabled']
      .filter(key => element[key] !== undefined).map(key => [key, element[key]])));
  const handles = { snapshot_id: state.snapshot_id, pid: state.pid, window_id: state.window_id,
    window_bounds: state.window_bounds, capture_coverage: state.capture_coverage,
    elements_complete: state.elements_complete && elements.length === state.elements.length,
    total_element_count: state.total_element_count, elements };
  return { ...result, content: [...(result.content ?? []), { type: 'text', text:
    'Exact native snapshot handles (use these tokens without modification; refresh after every action; query the window again if needed):\n' + JSON.stringify(handles) }] };
}

export async function apply(ctx) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const require = createRequire(path.join(root, '.runtime', 'deepseek-harness', 'package.json'));
  const load = specifier => import(pathToFileURL(require.resolve(specifier)).href);
  const [{ CuaDriver }, { createMcpToolDefinition }, { ComputerUseProviderName }] = await Promise.all([
    import(pathToFileURL(path.join(root, '.runtime', 'deepseek-harness', 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js')).href),
    load('@deepseek-ai/dsh-mcp-client'), load('@deepseek-ai/dsh-computer-use/brand'),
  ]);
  let driver;
  const lifetime = new AbortController();
  const pending = new Set();
  const dispose = ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('ollamaforge-cua-driver-native'));
    yield async () => {
      lifetime.abort();
      await Promise.allSettled([...pending]);
      if (driver) { await driver.shutdown(); driver.uniffiDestroy(); }
    };
  });
  try {
    driver = CuaDriver.create(undefined);
    const catalog = JSON.parse(await driver.listToolsJson());
    const names = new Set();
    for (const tool of catalog.tools) {
      const publicName = `cua_driver_native__${tool.name}`;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(publicName) || names.has(publicName)) throw new Error('Invalid native driver catalog.');
      names.add(publicName);
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: publicName, rawName: tool.name, description: (tool.description ?? '') + (tool.name === 'get_window_state' ? '\nOllamaForge defaults max_elements to 80 when omitted; request a larger bound or query explicitly when needed.' : ''), inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
        async call(args, execution) {
          const signal = AbortSignal.any([execution.signal, lifetime.signal]);
          signal.throwIfAborted();
          const parameters = tool.name === 'get_window_state' ? { ...args, max_elements: args.max_elements ?? 80 } : args;
          const operation = driver.callTool(tool.name, JSON.stringify(parameters), { signal });
          pending.add(operation);
          try { return projectNativeResult(JSON.parse((await operation).rawJson)); }
          finally { pending.delete(operation); }
        },
      }));
    }
    ctx.systemPrompt.section({ name: 'computer-use:ollamaforge-native', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'), text:
      'Use Cua Driver for native computer control. Discover the exact app/window and capture fresh state before each action. Set max_elements around 80 for a window snapshot. The appended exact snapshot JSON supplies element_token and snapshot_id; use those actual handles, never a bare invented index. A new snapshot invalidates old handles. Honor the selected input delivery mode and driver refusals. Verify outcomes after actions. Operate only the apps and tasks the user authorized. Do not change security/permission settings or share another session\'s desktop workflow.' });
    for (let i = 0; i < 100 && !ctx.browserUse.providerName; i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (!ctx.browserUse.providerName) throw new Error('Chrome provider did not activate; refusing a partial controls setup.');
    ctx.provide('ollamaforgeNativeReady', { toolCount: names.size });
  } catch (error) { await dispose(); throw error; }
}
