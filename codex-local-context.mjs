// The Radeon runtime has an 8k KV cache. Budget the actual rendered prompt,
// including function schemas, before asking it to generate a response.
export const metalContextWindow = 8192;
export const localContextNotice = '[Local context budget]';

export class LocalContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalContextError';
    this.type = 'local_context_limit';
  }
}

function textOf(item) {
  if (typeof item?.content === 'string') return item.content;
  if (!Array.isArray(item?.content)) return '';
  return item.content.map((part) => part?.text ?? '').join('\n');
}

function notice(text) {
  // Qwen's chat template accepts a system message only at position zero.
  // A visible assistant handoff notice also survives historyBase.slice(1).
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${localContextNotice} ${text}` }] };
}

function isNotice(item) {
  return ['system', 'assistant'].includes(item?.role) && textOf(item).startsWith(localContextNotice);
}

export function isRuntimeContextMessage(item) {
  if (item?.role !== 'user') return false;
  const remaining = textOf(item).replace(/<(environment_context|permissions instructions)>[\s\S]*?<\/\1>/g, '').trim();
  return !remaining && /<(environment_context|permissions instructions)>/.test(textOf(item));
}

// Pair each tool call with all its results. Removing a group always removes
// both sides; this also works when parallel call/results are interleaved.
function inputGroups(input) {
  const parent = input.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) index = parent[index];
    return index;
  };
  const calls = new Map();
  input.forEach((item, index) => {
    if (item?.type === 'function_call' && typeof item.call_id === 'string') calls.set(item.call_id, index);
  });
  input.forEach((item, index) => {
    if (item?.type !== 'function_call_output' || !calls.has(item.call_id)) return;
    const callIndex = calls.get(item.call_id);
    parent[find(index)] = find(callIndex);
  });
  const groups = new Map();
  input.forEach((_, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(index);
  });
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

function preservedIndices(input) {
  const required = new Set();
  let latestUser = -1;
  let latestTaskUser = -1;
  const contextKinds = new Map();
  input.forEach((item, index) => {
    if (['system', 'developer'].includes(item?.role)) required.add(index);
    if (item?.role === 'user') {
      latestUser = index;
      if (!isRuntimeContextMessage(item)) latestTaskUser = index;
      // These are supplied by Codex as user-role messages as well as by its
      // instruction field. Keep the latest host/permission context intact.
      const text = textOf(item);
      for (const kind of ['environment_context', 'permissions instructions', 'cwd', 'AGENTS.md']) {
        if (text.includes(kind === 'cwd' ? '<cwd>' : kind)) contextKinds.set(kind, index);
      }
    }
  });
  if (latestUser >= 0) required.add(latestUser);
  if (latestTaskUser >= 0) required.add(latestTaskUser);
  for (const index of contextKinds.values()) required.add(index);
  // A request ending in a tool result must retain its invocation and result.
  const latest = input.length - 1;
  if (latest >= 0) required.add(latest);
  return required;
}

function prepareInput(rawInput) {
  let alreadyLimited = false;
  const input = rawInput.flatMap((item) => {
    if (isNotice(item)) { alreadyLimited = true; return []; }
    if (['compaction', 'context_compaction'].includes(item?.type)) {
      alreadyLimited = true;
      return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text:
        '[Earlier cloud history is encrypted and cannot be read by the local model. Use the visible messages and handoff summaries; do not claim to remember this missing history.]' }] }];
    }
    if (item?.type === 'reasoning' && (!Array.isArray(item.content) || !item.content.length)) {
      // Encrypted private reasoning is not a portable chat message.
      return [];
    }
    if (item?.type && !['message', 'function_call', 'function_call_output', 'reasoning'].includes(item.type)) {
      // Cloud tool events have no llama.cpp Responses equivalent. Retain their
      // visible evidence as historical assistant text, never as a new command.
      const { encrypted_content, encrypted_function_args, ...visible } = item;
      return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text:
        `[Historical ${item.type} event; execution already occurred]\n${JSON.stringify(visible)}` }] }];
    }
    return [item];
  });
  const calls = new Set(input.filter((item) => item?.type === 'function_call').map((item) => item.call_id));
  let orphaned = false;
  const prepared = input.map((item) => {
    if (item?.type !== 'function_call_output' || calls.has(item.call_id)) return item;
    orphaned = true;
    // An old invocation may already have fallen out of Codex's stored history.
    // Preserve the evidence without inventing an invocation or a tool result ID.
    const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
    return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text:
      `[Historical tool result; invocation unavailable: ${item.call_id}]\n${output}` }] };
  });
  return { input: prepared, alreadyLimited: alreadyLimited || orphaned };
}

function makeInput(input, omitted, compressed = false, alreadyLimited = false) {
  const retained = input.filter((_, index) => !omitted.has(index));
  if (!omitted.size && !compressed && !alreadyLimited) return retained;
  const summary = notice('Earlier conversation items or parts of tool results were omitted to fit the local model. ' +
    'Use the visible recent context and any visible handoff summary. Do not claim to remember omitted history. ' +
    'If missing details are needed, retrieve them with the available tools or ask the user. ' +
    'The latest user message is preserved in full.');
  const systemIndex = retained.findIndex((item) => item?.role === 'system');
  retained.splice(systemIndex < 0 ? 0 : systemIndex + 1, 0, summary);
  return retained;
}

function compressToolOutput(item, maxCharacters) {
  if (item?.type !== 'function_call_output') return item;
  const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
  if (output.length <= maxCharacters) return item;
  const half = Math.floor(maxCharacters / 2);
  return { ...item, output: `${output.slice(0, half)}\n[Local context budget: middle of tool output omitted; retrieve it again if required.]\n${output.slice(-half)}` };
}

// llama.cpp exposes a read-only endpoint that uses the same Responses parsing,
// model chat template, tool formatting and tokenizer as the inference endpoint.
// An older server may not have it. Its fallback deliberately overestimates
// text tokens rather than allowing an overflowing prompt through.
export function createLocalTokenCounter(upstream, fetchImpl = fetch) {
  let countEndpointAvailable = true;
  return async (request) => {
    if (countEndpointAvailable) {
      let response;
      try {
        response = await fetchImpl(new URL('/v1/responses/input_tokens', upstream), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...request, stream: false }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        throw new LocalContextError(`Cannot verify the local model context budget: ${error.message}. Start the local runtime or switch to a cloud model explicitly.`);
      }
      if (response.ok) {
        const payload = await response.json();
        if (Number.isSafeInteger(payload.input_tokens) && payload.input_tokens >= 0) return payload.input_tokens;
        countEndpointAvailable = false;
      } else if ([404, 405, 501].includes(response.status)) {
        countEndpointAvailable = false;
      } else {
        const payload = await response.text();
        throw new LocalContextError(`The local tokenizer rejected the request (${response.status}): ${payload.slice(0, 500)}. No inference was started.`);
      }
    }
    return Buffer.byteLength(JSON.stringify({ input: request.input, tools: request.tools, tool_choice: request.tool_choice }), 'utf8') + 256;
  };
}

export async function fitMetalContext(request, countTokens) {
  const maximumOutput = Number.isFinite(request.max_output_tokens) && request.max_output_tokens > 0
    ? Math.max(1, Math.min(1024, Math.floor(request.max_output_tokens))) : 1024;
  const inputBudget = metalContextWindow - Math.max(256, maximumOutput) - 128;
  const { input, alreadyLimited } = prepareInput(request.input);
  const tools = request.tools.map((tool) => ({ ...tool, ...(typeof tool.description === 'string' && tool.description.length > 800
    ? { description: `${tool.description.slice(0, 800)}\n[Description shortened for the local model; parameter schema is complete.]` } : {}) }));
  const base = { ...request, tools, max_output_tokens: maximumOutput };
  const required = preservedIndices(input);
  const groups = inputGroups(input);
  const removable = groups.filter((group) => !group.some((index) => required.has(index)));
  const omittedFor = (groupCount) => new Set(removable.slice(0, groupCount).flat());
  const candidate = (items, groupCount, compressed = false) => ({ ...base,
    input: makeInput(items, omittedFor(groupCount), compressed, alreadyLimited) });
  let normalized = candidate(input, 0);
  let measuredTokens = await countTokens(normalized);
  if (measuredTokens <= inputBudget) return { normalized, measuredTokens, inputBudget, omittedItems: 0 };

  // Find the smallest oldest-history prefix that frees enough space. Tool
  // pairs are atomic, and retained messages remain in their original order.
  let low = 1;
  let high = removable.length;
  let fitting = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const trial = candidate(input, middle);
    const tokens = await countTokens(trial);
    if (tokens <= inputBudget) {
      fitting = { normalized: trial, measuredTokens: tokens, inputBudget, omittedItems: omittedFor(middle).size };
      high = middle - 1;
    } else low = middle + 1;
  }
  if (fitting) return fitting;

  // Recent tool output can dwarf the complete user request. Shorten only the
  // output, with an explicit marker, and retain the original invocation.
  for (const maxCharacters of [4000, 1600, 400]) {
    const compressed = input.map((item) => compressToolOutput(item, maxCharacters));
    normalized = candidate(compressed, removable.length, true);
    measuredTokens = await countTokens(normalized);
    if (measuredTokens <= inputBudget) {
      return { normalized, measuredTokens, inputBudget, omittedItems: omittedFor(removable.length).size };
    }
  }
  throw new LocalContextError(`The latest user message, required environment/permission instructions, tool arguments and schemas need ${measuredTokens} input tokens; the local 8192-token model allows ${inputBudget} with output space reserved. The user message was not truncated. Shorten the request or explicitly select a cloud model. No cloud request was made.`);
}

// Stored previous_response_id histories use a conservative size estimate. A
// persisted omission notice survives later requests and runtime restarts.
export function trimStoredHistory(items, maxTokens, estimateTokens) {
  const { input, alreadyLimited } = prepareInput(items);
  const required = preservedIndices(input);
  const removable = inputGroups(input).filter((group) => !group.some((index) => required.has(index)));
  const omitted = new Set();
  let retained = makeInput(input, omitted, false, alreadyLimited);
  for (const group of removable) {
    if (estimateTokens(retained) <= maxTokens) break;
    group.forEach((index) => omitted.add(index));
    retained = makeInput(input, omitted, false, alreadyLimited);
  }
  return retained;
}
