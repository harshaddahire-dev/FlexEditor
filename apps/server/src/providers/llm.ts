import {
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type Effort,
  type ModelInfo,
  type ProviderKind,
  type ToolCall,
  contextWindowFor,
} from '@cutroom/core';
import { redact } from './secrets';

/** Everything needed to call one provider. `key` is decrypted server-side and never leaves this process. */
export interface Conn {
  kind: ProviderKind;
  baseUrl: string;
  key?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------------ http */

async function call(conn: Conn, url: string, init: RequestInit & { headers: Record<string, string> }, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new LlmError(redact(`Could not reach ${new URL(url).host}: ${(e as Error).message}`, conn.key));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body.slice(0, 400);
    try {
      const j = asObj(JSON.parse(body));
      const err = asObj(j.error);
      message = str(err.message) || str(j.message) || str(asObj(asArr(j.error)[0]).message) || message;
    } catch {
      /* not JSON */
    }
    throw new LlmError(redact(`${res.status} ${res.statusText}: ${message}`.trim(), conn.key), res.status);
  }
  return res;
}

/** Parse a Server-Sent Events body into `{ event, data }` records. */
async function* sse(res: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

const parseArgs = (s: string): Record<string, unknown> => {
  if (!s.trim()) return {};
  try {
    return asObj(JSON.parse(s));
  } catch {
    return { _raw: s };
  }
};

/* ---------------------------------------------------------------- effort */

const ANTHROPIC_BUDGET: Record<Exclude<Effort, 'off'>, number> = { low: 1024, medium: 4096, high: 16_000, max: 32_000 };
const GEMINI_BUDGET: Record<Effort, number> = { off: 0, low: 1024, medium: 4096, high: 16_384, max: 24_576 };
const OPENAI_EFFORT: Record<Exclude<Effort, 'off'>, string> = { low: 'low', medium: 'medium', high: 'high', max: 'high' };

/* ---------------------------------------------------------------- models */

export async function listModels(conn: Conn, signal?: AbortSignal): Promise<ModelInfo[]> {
  const base = conn.baseUrl;
  if (conn.kind === 'anthropic') {
    const res = await call(conn, `${base}/models?limit=1000`, { headers: anthropicHeaders(conn) }, signal);
    const j = asObj(await res.json());
    return asArr(j.data).map((m) => {
      const o = asObj(m);
      const id = str(o.id);
      return { id, name: str(o.display_name) || id, contextWindow: num(o.max_input_tokens) || contextWindowFor(id) };
    });
  }
  if (conn.kind === 'gemini') {
    const res = await call(conn, `${base}/models?pageSize=1000`, { headers: { 'x-goog-api-key': conn.key ?? '' } }, signal);
    const j = asObj(await res.json());
    return asArr(j.models)
      .map(asObj)
      .filter((m) => asArr(m.supportedGenerationMethods).includes('generateContent'))
      .map((m) => {
        const id = str(m.name).replace(/^models\//, '');
        return { id, name: str(m.displayName) || id, contextWindow: num(m.inputTokenLimit) || contextWindowFor(id) };
      });
  }
  const res = await call(conn, `${base}/models`, { headers: openaiHeaders(conn) }, signal);
  const j = asObj(await res.json());
  return asArr(j.data).map((m) => {
    const o = asObj(m);
    const id = str(o.id);
    return { id, name: str(o.name) || id, contextWindow: num(o.context_length) || num(o.context_window) || contextWindowFor(id) };
  });
}

/* ------------------------------------------------------------------ chat */

export async function chat(conn: Conn, req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
  let result: ChatResult | undefined;
  for await (const ev of chatStream(conn, req, signal)) if (ev.type === 'done') result = ev.result;
  if (!result) throw new LlmError('The model returned no result.');
  return result;
}

export function chatStream(conn: Conn, req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  if (conn.kind === 'anthropic') return anthropicStream(conn, req, signal);
  if (conn.kind === 'gemini') return geminiStream(conn, req, signal);
  return openaiStream(conn, req, signal);
}

/* ---------------------------------------------- OpenAI / OpenRouter / custom */

const openaiHeaders = (c: Conn): Record<string, string> => ({ 'content-type': 'application/json', ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) });

export function toOpenAI(messages: ChatMessage[]): Json[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

async function* openaiStream(conn: Conn, req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const body: Json = { model: req.model, messages: toOpenAI(req.messages), stream: true, stream_options: { include_usage: true } };
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (req.maxTokens) body[conn.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
  if (req.temperature !== undefined && !(conn.kind === 'openai' && req.effort && req.effort !== 'off')) body.temperature = req.temperature;
  if (req.effort && req.effort !== 'off') {
    if (conn.kind === 'openai') body.reasoning_effort = OPENAI_EFFORT[req.effort];
    else if (conn.kind === 'openrouter') body.reasoning = { effort: OPENAI_EFFORT[req.effort] };
    // custom servers: unknown parameters are often rejected, so effort is not sent
  }

  const res = await call(conn, `${conn.baseUrl}/chat/completions`, { method: 'POST', headers: openaiHeaders(conn), body: JSON.stringify(body) }, signal);
  let text = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let stop: ChatResult['stopReason'] = 'other';
  const usage = { inputTokens: 0, outputTokens: 0 };

  for await (const { data } of sse(res)) {
    if (data === '[DONE]') break;
    let j: Json;
    try {
      j = asObj(JSON.parse(data));
    } catch {
      continue;
    }
    if (j.error) throw new LlmError(redact(str(asObj(j.error).message) || 'The provider reported an error.', conn.key));
    const u = asObj(j.usage);
    if (Object.keys(u).length) {
      usage.inputTokens = num(u.prompt_tokens);
      usage.outputTokens = num(u.completion_tokens);
    }
    const choice = asObj(asArr(j.choices)[0]);
    const delta = asObj(choice.delta);
    const content = str(delta.content);
    if (content) {
      text += content;
      yield { type: 'text', delta: content };
    }
    const reasoning = str(delta.reasoning_content) || str(delta.reasoning);
    if (reasoning) yield { type: 'thinking', delta: reasoning };
    for (const tc of asArr(delta.tool_calls).map(asObj)) {
      const idx = num(tc.index);
      const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
      const fn = asObj(tc.function);
      if (str(tc.id)) cur.id = str(tc.id);
      if (str(fn.name)) cur.name += str(fn.name);
      cur.args += str(fn.arguments);
      calls.set(idx, cur);
    }
    const fr = str(choice.finish_reason);
    if (fr) stop = fr === 'tool_calls' || fr === 'function_call' ? 'tool_calls' : fr === 'length' ? 'length' : fr === 'stop' ? 'stop' : 'other';
  }
  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseArgs(c.args) }));
  if (toolCalls.length && stop === 'other') stop = 'tool_calls';
  yield { type: 'done', result: { text, toolCalls, usage, stopReason: stop } };
}

/* ----------------------------------------------------------- Anthropic */

const anthropicHeaders = (c: Conn): Record<string, string> => ({ 'content-type': 'application/json', 'x-api-key': c.key ?? '', 'anthropic-version': '2023-06-01' });

export function toAnthropic(messages: ChatMessage[]): { system: string; messages: Json[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out: Json[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out.at(-1);
      if (last && last.role === 'user' && asArr(last.content).every((b) => asObj(b).type === 'tool_result')) (last.content as Json[]).push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      const blocks: Json[] = [...(Array.isArray(m.providerData) ? (m.providerData as Json[]) : [])];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    }
  }
  return { system, messages: out };
}

async function* anthropicStream(conn: Conn, req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const { system, messages } = toAnthropic(req.messages);
  const budget = req.effort && req.effort !== 'off' ? ANTHROPIC_BUDGET[req.effort] : 0;
  const body: Json = { model: req.model, max_tokens: Math.max(req.maxTokens ?? 4096, budget ? budget + 2048 : 0), messages, stream: true };
  if (system) body.system = system;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (budget) body.thinking = { type: 'enabled', budget_tokens: budget };
  else if (req.temperature !== undefined) body.temperature = req.temperature; // not allowed together with thinking

  const res = await call(conn, `${conn.baseUrl}/messages`, { method: 'POST', headers: anthropicHeaders(conn), body: JSON.stringify(body) }, signal);
  let text = '';
  const usage = { inputTokens: 0, outputTokens: 0 };
  let stop: ChatResult['stopReason'] = 'other';
  const blocks = new Map<number, { type: string; id?: string; name?: string; json: string; thinking: string; signature: string; data?: string }>();
  for await (const { data } of sse(res)) {
    let j: Json;
    try {
      j = asObj(JSON.parse(data));
    } catch {
      continue;
    }
    const type = str(j.type);
    if (type === 'error') throw new LlmError(redact(str(asObj(j.error).message) || 'The provider reported an error.', conn.key));
    if (type === 'message_start') usage.inputTokens = num(asObj(asObj(j.message).usage).input_tokens);
    else if (type === 'content_block_start') {
      const cb = asObj(j.content_block);
      blocks.set(num(j.index), { type: str(cb.type), id: str(cb.id) || undefined, name: str(cb.name) || undefined, json: '', thinking: '', signature: '', data: str(cb.data) || undefined });
    } else if (type === 'content_block_delta') {
      const b = blocks.get(num(j.index));
      const d = asObj(j.delta);
      const dt = str(d.type);
      if (dt === 'text_delta') {
        text += str(d.text);
        yield { type: 'text', delta: str(d.text) };
      } else if (dt === 'input_json_delta' && b) b.json += str(d.partial_json);
      else if (dt === 'thinking_delta' && b) {
        b.thinking += str(d.thinking);
        yield { type: 'thinking', delta: str(d.thinking) };
      } else if (dt === 'signature_delta' && b) b.signature += str(d.signature);
    } else if (type === 'message_delta') {
      const sr = str(asObj(j.delta).stop_reason);
      stop = sr === 'tool_use' ? 'tool_calls' : sr === 'max_tokens' ? 'length' : sr === 'end_turn' || sr === 'stop_sequence' ? 'stop' : 'other';
      usage.outputTokens = num(asObj(j.usage).output_tokens) || usage.outputTokens;
    }
  }
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  const toolCalls: ToolCall[] = ordered.filter((b) => b.type === 'tool_use').map((b, i) => ({ id: b.id ?? `call_${i}`, name: b.name ?? '', arguments: parseArgs(b.json) }));
  // thinking blocks must be returned verbatim (with signatures) on the next turn of a tool loop
  const kept = ordered
    .filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
    .map((b) => (b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking, signature: b.signature } : { type: 'redacted_thinking', data: b.data }));
  yield { type: 'done', result: { text, toolCalls, usage, stopReason: toolCalls.length ? 'tool_calls' : stop, providerData: kept.length ? kept : undefined } };
}

/* -------------------------------------------------------------- Gemini */

/** Gemini accepts an OpenAPI subset of JSON Schema: keep only what it understands. */
export function geminiSchema(s: unknown): unknown {
  const o = asObj(s);
  const out: Json = {};
  // unions (anyOf/oneOf): Gemini has none — a number-or-string argument becomes a string (the tools parse both)
  const alts = asArr(o.anyOf).length ? asArr(o.anyOf) : asArr(o.oneOf);
  if (alts.length) {
    const kinds = alts.map((a) => str(asObj(a).type));
    const pick = kinds.includes('string') ? alts.find((a) => asObj(a).type === 'string')! : (alts.find((a) => asObj(a).type !== 'null') ?? alts[0]);
    return { ...(geminiSchema(pick) as Json), ...(str(o.description) ? { description: str(o.description) } : {}) };
  }
  for (const k of ['type', 'description', 'format', 'enum', 'required', 'nullable']) if (o[k] !== undefined) out[k] = o[k];
  if (typeof out.type === 'string') out.type = out.type.toUpperCase();
  if (o.properties) out.properties = Object.fromEntries(Object.entries(asObj(o.properties)).map(([k, v]) => [k, geminiSchema(v)]));
  if (o.items) out.items = geminiSchema(o.items);
  return out;
}

export function toGemini(messages: ChatMessage[]): { system: string; contents: Json[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents: Json[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      let response: unknown = m.content;
      try {
        response = JSON.parse(m.content);
      } catch {
        /* plain text */
      }
      const part = { functionResponse: { name: m.name ?? '', response: typeof response === 'object' && response !== null ? response : { result: response } } };
      const last = contents.at(-1);
      if (last && last.role === 'user' && asArr(last.parts).every((p) => asObj(p).functionResponse)) (last.parts as Json[]).push(part);
      else contents.push({ role: 'user', parts: [part] });
    } else if (m.role === 'assistant') {
      // thought signatures live on the raw parts: send those back as they came
      const parts: Json[] = Array.isArray(m.providerData) ? (m.providerData as Json[]) : [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.arguments } }))];
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
    } else {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    }
  }
  return { system, contents };
}

async function* geminiStream(conn: Conn, req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const { system, contents } = toGemini(req.messages);
  const body: Json = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
  const gen: Json = {};
  if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) gen.temperature = req.temperature;
  if (req.effort) gen.thinkingConfig = req.effort === 'off' ? { thinkingBudget: 0 } : { thinkingBudget: GEMINI_BUDGET[req.effort], includeThoughts: true };
  if (Object.keys(gen).length) body.generationConfig = gen;

  const url = `${conn.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
  const res = await call(conn, url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': conn.key ?? '' }, body: JSON.stringify(body) }, signal);
  let text = '';
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: ToolCall[] = [];
  const rawParts: Json[] = [];
  let stop: ChatResult['stopReason'] = 'other';
  for await (const { data } of sse(res)) {
    let j: Json;
    try {
      j = asObj(JSON.parse(data));
    } catch {
      continue;
    }
    if (j.error) throw new LlmError(redact(str(asObj(j.error).message) || 'The provider reported an error.', conn.key));
    const u = asObj(j.usageMetadata);
    if (Object.keys(u).length) {
      usage.inputTokens = num(u.promptTokenCount);
      usage.outputTokens = num(u.candidatesTokenCount) + num(u.thoughtsTokenCount);
    }
    const cand = asObj(asArr(j.candidates)[0]);
    for (const p of asArr(asObj(cand.content).parts).map(asObj)) {
      rawParts.push(p);
      if (p.functionCall) {
        const fc = asObj(p.functionCall);
        toolCalls.push({ id: `call_${toolCalls.length}`, name: str(fc.name), arguments: asObj(fc.args) });
      } else if (str(p.text)) {
        if (p.thought) yield { type: 'thinking', delta: str(p.text) };
        else {
          text += str(p.text);
          yield { type: 'text', delta: str(p.text) };
        }
      }
    }
    const fr = str(cand.finishReason);
    if (fr) stop = fr === 'STOP' ? 'stop' : fr === 'MAX_TOKENS' ? 'length' : 'other';
  }
  // keep non-thought parts (text + function calls, with their signatures) for the next turn
  const replay = rawParts.filter((p) => !p.thought);
  yield { type: 'done', result: { text, toolCalls, usage, stopReason: toolCalls.length ? 'tool_calls' : stop, providerData: toolCalls.length ? replay : undefined } };
}
