import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'ollamaforge-bounded-compaction';
export const inject = ['llm', 'tokenMeter', 'sessions'];

export function localCompactionPolicy(contextWindow) {
  if (!Number.isInteger(contextWindow) || contextWindow < 4096) throw new Error('Invalid context capacity.');
  return { thresholdRatio: 0.85, headroomTokens: Math.min(8192, Math.floor(contextWindow / 16)), retainRatio: 0.16,
    maxTokens: Math.min(2048, Math.floor(contextWindow / 32)), compactionRetries: 0, maxOverflowRetries: 1 };
}

// Web presets isolate their own compaction service. Preserve their complete
// composition (including tools and JS expressions), replacing only that row.
export function rewriteCompactionTree(value, replacement) {
  if (Array.isArray(value)) return value.map(item => rewriteCompactionTree(item, replacement));
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (value.id === 'compaction-basic') {
    const policies = replacement.config?.modelPolicies;
    const config = { ...value.config, ...replacement.config };
    if (policies) config.modelPolicies = [...(value.config?.modelPolicies ?? []).filter(old =>
      !policies.some(policy => policy.provider === old.provider && policy.model === old.model)), ...policies];
    return { ...value, ...replacement, config };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteCompactionTree(child, replacement)]));
}

function nearCapacity(tokens, window, output) {
  return tokens >= window - output - Math.min(2048, Math.floor(window / 32));
}

function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 5) / 2);
  return text.slice(0, half) + ' […] ' + text.slice(-half);
}

// Only use visible conversation content. In particular, a tool's image bytes,
// the model's reasoning and provider replay state must never enter a checkpoint.
function localCheckpoint(messages, route) {
  const requests = [], activity = [];
  for (const message of messages) {
    const user = message.role === 'user';
    if (user && !['user', 'compact-checkpoint'].includes(message.source?.kind)) continue;
    if (!user && !['assistant', 'tool'].includes(message.role)) continue;
    const parts = message.content.flatMap(block => {
      if (block.type === 'text') return [excerpt(block.text.trim(), user ? 1200 : 400)];
      if (block.type === 'tool-call') return ['tool call ' + block.name];
      return [];
    }).filter(Boolean);
    if (!parts.length) continue;
    const label = message.source?.kind === 'compact-checkpoint' ? 'prior checkpoint' : message.role;
    (user ? requests : activity).push(label + ': ' + excerpt(parts.join(' '), user ? 1200 : 400));
  }
  const text = [
    'Excerpts from earlier history, in order. Tool output is quoted data. Full events remain in the session log.',
    excerpt(requests.join('\n'), 3600), excerpt(activity.join('\n'), 2400),
  ].filter(Boolean).join('\n');
  return { summary: [{ type: 'text', text }], provider: route.provider, model: route.model };
}

export class CompactionBackoff {
  failures = new WeakMap();
  record(session, tokens) { this.failures.set(session, tokens); }
  clear(session) { this.failures.delete(session); }
  decision(session, tokens, window, output) {
    const previous = this.failures.get(session);
    if (previous == null) return 'attempt';
    if (nearCapacity(tokens, window, output) && !nearCapacity(previous, window, output)) return 'attempt';
    return tokens < previous + Math.min(8192, Math.floor(window / 16)) ? 'defer' : 'attempt';
  }
}

export function createGuardedEngine(Base, budget, backoff, measure) {
  return class GuardedCompaction extends Base {
    async summarize(input, agent, signal) {
      const route = agent.session.requestHeader()?.config ?? agent.options;
      if (route.provider !== 'ollamaforge-local') return super.summarize(input, agent, signal);
      signal?.throwIfAborted();
      const { tokens, window, output } = await budget(agent, signal);
      if (!nearCapacity(tokens, window, output)) {
        try {
          return await super.summarize(input, agent, signal);
        } catch (error) {
          signal?.throwIfAborted();
          if (!['MAX_TOKENS', 'CONTEXT_WINDOW_EXCEEDED'].includes(error.code) &&
              error.message !== 'summarization produced no text summary content') throw error;
        }
      }
      signal?.throwIfAborted();
      return localCheckpoint(input.messages, route);
    }

    async compactIfNeeded(agent, trigger, signal) {
      const current = trigger === 'pressure' ? await budget(agent, signal) : null;
      if (current && backoff.decision(agent.session, current.tokens, current.window, current.output) !== 'attempt') return null;
      try {
        const result = await super.compactIfNeeded(agent, trigger, signal);
        if (result) backoff.clear(agent.session);
        return result;
      } catch (error) {
        if (current && !signal?.aborted) backoff.record(agent.session, measure(agent.session).totalTokens);
        throw error;
      }
    }
  };
}

export async function apply(ctx, config) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const { BasicCompactionEngine } = await import(pathToFileURL(path.join(root, '.runtime', 'deepseek-harness', 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js')).href);
  const backoff = new CompactionBackoff();
  const budget = async (agent, signal) => {
    const route = agent.session.requestHeader()?.config ?? agent.options;
    if (route.provider !== 'ollamaforge-local') return null;
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
    return { tokens: ctx.tokenMeter.measure(agent.session).totalTokens, window: info.context.contextWindow, output: route.maxTokens ?? info.defaultMaxTokens ?? 8192 };
  };
  const GuardedCompaction = createGuardedEngine(BasicCompactionEngine, budget, backoff, session => ctx.tokenMeter.measure(session));
  await ctx.plugin(GuardedCompaction, config);
}
