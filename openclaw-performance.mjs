import path from 'node:path';
import fs from 'node:fs';

// The browser/computer/exec tools are independent of bundled skill discovery.
// Keep the relevant Windows workflows; avoid probing absent media/home CLIs on
// every turn. Explicit user skill selections always take precedence.
export const WINDOWS_BUNDLED_SKILLS = [
  'control-ui', 'github', 'gh-issues', 'healthcheck', 'skill-creator',
  'node-connect', 'node-inspect-debugger', 'python-debugpy',
  'visualize', 'diagram-maker', 'meme-maker', 'weather',
];

export function strataModelDefinition(health) {
  const qwen = /^qwen/i.test(health.model);
  return {
    id: health.model,
    name: health.model === 'qwen3.8-flash-next-iq3_s' ? 'Strata · Qwen3.8 Flash 128K' : `Strata · ${health.model}`,
    contextTokens: health.max_context, maxTokens: 8192,
    // This is a capability flag, not the active thinking level. Setting false
    // prevents the SDK from sending Qwen's actual enable_thinking=false control.
    reasoning: qwen, ...(qwen ? { compat: { thinkingFormat: 'qwen-chat-template' } } : {}),
    input: health.images ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function withOpenClawPerformanceDefaults(config) {
  const next = structuredClone(config);
  next.skills ??= {};
  next.skills.allowBundled ??= [...WINDOWS_BUNDLED_SKILLS];
  next.skills.load ??= {};
  next.skills.load.watch ??= false;
  next.agents ??= {}; next.agents.defaults ??= {};
  next.agents.defaults.heartbeat ??= {};
  next.agents.defaults.heartbeat.every ??= '0m';
  return next;
}

export function openClawToolDirectories(source = process.env, node = process.execPath) {
  const pathKey = Object.keys(source).filter(key => key.toLowerCase() === 'path').sort()[0];
  const candidates = (source[pathKey] ?? '').split(';').filter(Boolean).map(directory => path.join(directory, 'git.exe'));
  if (source.ProgramFiles) candidates.push(path.join(source.ProgramFiles, 'Git', 'cmd', 'git.exe'));
  if (source.LOCALAPPDATA) {
    const desktop = path.join(source.LOCALAPPDATA, 'GitHubDesktop');
    try {
      for (const entry of fs.readdirSync(desktop).filter(name => /^app-\d/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        candidates.push(path.join(desktop, entry, 'resources', 'app', 'git', 'cmd', 'git.exe'));
      }
    } catch { }
  }
  const git = candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  return [path.dirname(node), ...(git ? [path.dirname(git)] : [])];
}

export function openClawEnvironment(source = process.env, toolDirectories = []) {
  const env = { ...source };
  // Match Node's Windows environment-key precedence and remove shadow copies.
  const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path').sort();
  const key = pathKeys[0] ?? 'PATH';
  for (const duplicate of pathKeys.slice(1)) delete env[duplicate];
  const seen = new Set();
  env[key] = [...toolDirectories, ...(env[key] ?? '').split(';')].filter(entry => {
    // Preserve first-entry spelling, order, relative entries and missing paths.
    // Installing a tool later must still work without rebuilding this profile.
    const normalized = path.win32.normalize(entry).toLowerCase();
    const canonical = normalized.length > path.win32.parse(normalized).root.length
      ? normalized.replace(/[\\/]+$/, '') : normalized;
    if (seen.has(canonical)) return false;
    seen.add(canonical); return true;
  }).join(';');
  env.OPENCLAW_DISABLE_BONJOUR = '1';
  env.OPENCLAW_EXEC_SHELL_SNAPSHOT = '0';
  env.OPENCLAW_NO_RESPAWN = '1';
  return env;
}
