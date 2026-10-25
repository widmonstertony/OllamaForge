import { fileURLToPath } from 'node:url';

// Report sizes and tool identifiers only; never retain prompts, arguments,
// results, headers, or account credentials in diagnostics.
export function describeContext(request) {
  const additional = Array.isArray(request.input) ? request.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? []) : [];
  const tools = [...(request.tools ?? []), ...additional];
  return {
    inputCharacters: JSON.stringify(request.input ?? '').length,
    instructionCharacters: JSON.stringify(request.instructions ?? '').length,
    toolCharacters: JSON.stringify(tools).length,
    repeatedNamespaceCharacters: tools.reduce((sum, tool) => sum + (tool.description?.length ?? 0) * Math.max(0, (tool.tools?.length ?? 0) - 1), 0),
    tools: tools.map((tool) => ({
      name: tool.name ?? tool.type,
      type: tool.type,
      characters: JSON.stringify(tool).length,
      descriptionCharacters: (tool.description ?? '').length,
      children: (tool.tools ?? []).map((child) => ({ name: child.name, type: child.type, characters: JSON.stringify(child).length, descriptionCharacters: (child.description ?? '').length })),
    })),
  };
}

const OPTIONAL_NAMESPACES = /^(?:mcp__)?(?:codex_apps__)?(?:chatgpt_space|sites|pets|artifact_session|codex_document_control)(?:__|$)/;
const MAX_OUTPUT_CHARACTERS = 16000;
const CONTEXT_GUIDANCE = 'OllamaForge local context policy: use bounded file reads and targeted searches. For JSON, select needed fields instead of dumping entire documents. Avoid recursive runtime/model directory listings. Set tool output limits near 4000 tokens. Keep concise progress notes and continue from them after compaction. Computer control, browser/Chrome, GitHub and core coding tools remain available with their original schemas. For Windows native control, follow the installed Computer Use skill and '+fileURLToPath(new URL('./DESKTOP-CONTROL.md',import.meta.url))+'. Recover launcher aliases by re-enumerating actual windows; app approval timeouts require user action; null accessibility needs a screenshot, not a failed verdict. Verify real input and saved content before reporting success.';

function shorten(text) {
  if (typeof text !== 'string' || text.length <= MAX_OUTPUT_CHARACTERS) return text;
  const head = 10000, tail = 5600;
  return `${text.slice(0, head)}\n\n[OllamaForge: ${text.length - head - tail} characters omitted from this tool result. Search the source and read a bounded range or specific JSON fields if needed.]\n\n${text.slice(-tail)}`;
}

function boundedOutput(output) {
  if (typeof output === 'string') {
    // Keep structured tool envelopes valid, including images and continuation IDs.
    try {
      const value = JSON.parse(output);
      if (value && typeof value === 'object') return JSON.stringify(boundedOutput(value));
    } catch { }
    return shorten(output);
  }
  if (Array.isArray(output)) return output.map(boundedOutput);
  if (output && typeof output === 'object') {
    return Object.fromEntries(Object.entries(output).map(([key, value]) => [key,
      ['text', 'document_text', 'output', 'content'].includes(key) ? boundedOutput(value) : value]));
  }
  return output;
}

// Applied only to the local Strata route. No global plugin or cloud config changes.
export function optimizeContext(request, { reasoningBudget = 4096 } = {}) {
  const result = { ...request };
  const documentation = [];
  const optimizeTools = (tools) => tools.filter((tool) => !OPTIONAL_NAMESPACES.test(tool.name ?? '')).map((tool) => {
    if (tool.type !== 'namespace' || !tool.description || (tool.tools?.length ?? 0) < 2) return tool;
    // Strata prepends a namespace's description to EVERY member. Carry it once
    // instead, with its complete wording and the same original parameter schemas.
    documentation.push(`Tool namespace ${tool.name}:\n${tool.description}`);
    return { ...tool, description: '' };
  });
  if (request.tools) result.tools = optimizeTools(request.tools);
  if (Array.isArray(request.input)) {
    result.input = request.input.map((item) => {
      if (item.type === 'additional_tools' && Array.isArray(item.tools)) return { ...item, tools: optimizeTools(item.tools) };
      if (!['function_call_output', 'custom_tool_call_output'].includes(item.type)) return item;
      return { ...item, output: boundedOutput(item.output) };
    });
  }
  if (documentation.length) result.instructions = `${request.instructions ?? ''}\n\n${documentation.join('\n\n')}`;
  if (result.tools?.length && !(result.instructions ?? '').includes(CONTEXT_GUIDANCE)) {
    result.instructions = `${result.instructions ?? ''}\n\n${CONTEXT_GUIDANCE}\nIf GitHub connector writes return 403, inspect the user's repository permission and use already-authenticated git/gh for authorized writes; verify by reading back. Do not repeatedly retry a connector that lacks installation write permission.`;
  }
  if (request.reasoning?.effort && request.reasoning.effort !== 'none' &&
      request.reasoning_budget_tokens == null && request.thinking_budget_tokens == null) {
    result.reasoning_budget_tokens = reasoningBudget;
  }
  try {
    const metadata = JSON.parse(request.client_metadata?.['x-codex-turn-metadata'] ?? 'null');
    if (metadata?.request_kind === 'compaction') result.max_output_tokens = Math.min(request.max_output_tokens ?? 4096, 4096);
  } catch { }
  return result;
}
