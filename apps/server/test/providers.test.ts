import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ProviderInfo, ToolSpec } from '@cutroom/core';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { AppDb } from '../src/db';
import { chat, geminiSchema, listModels, toAnthropic, toGemini, toOpenAI } from '../src/providers/llm';
import { redact, SecretBox } from '../src/providers/secrets';
import { ProviderService } from '../src/providers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
const tmp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-prov-'));
  cleanup.push(() => fs.rm(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return d;
};

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
/** A throwaway HTTP server standing in for a provider. `reply` gets the parsed request and writes the response. */
async function fake(reply: (req: Seen, res: http.ServerResponse) => void): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const s: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      seen.push(s);
      reply(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
const sseOut = (res: http.ServerResponse, events: (string | { event?: string; data: unknown })[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) {
    if (typeof e === 'string') res.write(`data: ${e}\n\n`);
    else res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`);
  }
  res.end();
};
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const TOOL: ToolSpec = { name: 'split_clip', description: 'Split a clip', parameters: { type: 'object', properties: { clipId: { type: 'string' }, at: { type: 'integer', default: 0 } }, required: ['clipId'], additionalProperties: false } };
const KEY = 'sk-test-SECRET-1234567890';

describe('SecretBox', () => {
  it('round-trips, never stores plaintext, and rejects tampering or a different key', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'secret.key');
    const box = new SecretBox(file);
    const sealed = box.seal(KEY);
    expect(sealed).not.toContain(KEY);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(box.seal(KEY)).not.toBe(sealed); // fresh IV every time
    expect(box.open(sealed)).toBe(KEY);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(box.open(parts.join('.'))).toBeNull();
    expect(new SecretBox(path.join(dir, 'other.key')).open(sealed)).toBeNull();
    expect(new SecretBox(file).open(sealed)).toBe(KEY); // the master key persists
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o077).toBe(0); // owner-only
  });
  it('redacts secrets from text', () => {
    expect(redact(`bad key ${KEY} in url`, KEY)).toBe('bad key •••• in url');
    expect(redact('abc', 'abc')).toBe('abc'); // too short to be a secret: leave readable text alone
  });
});

describe('provider store & HTTP API', () => {
  it('keeps keys write-only and encrypted at rest', async () => {
    const dir = await tmp();
    const b = await buildApp(loadConfig({ dataDir: dir }), { saveDelayMs: 20 });
    cleanup.push(() => b.app.close());

    const created = await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'openai', apiKey: KEY, defaultModel: 'gpt-5' } });
    expect(created.statusCode).toBe(201);
    const p = created.json() as ProviderInfo;
    expect(p).toMatchObject({ kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hasKey: true, keyHint: KEY.slice(-4), defaultModel: 'gpt-5' });
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(JSON.stringify((await b.app.inject({ method: 'GET', url: '/api/providers' })).json())).not.toContain(KEY);

    // the database holds ciphertext only
    const files = (await fs.readdir(dir)).filter((n) => n !== 'secret.key'); // app.sqlite and its WAL
    const dbText = (await Promise.all(files.map((n) => fs.readFile(path.join(dir, n)).then((x) => x.toString('latin1'))))).join('');
    expect(dbText).toContain('sealedKey'); // the key is in there…
    expect(dbText).not.toContain(KEY); // …only as ciphertext
    expect(b.providers.store.keyOf(p.id)).toBe(KEY);

    // update: omitted key keeps it, a new key replaces it, an empty key removes it
    await b.app.inject({ method: 'PATCH', url: `/api/providers/${p.id}`, payload: { name: 'Work' } });
    expect(b.providers.store.keyOf(p.id)).toBe(KEY);
    await b.app.inject({ method: 'PATCH', url: `/api/providers/${p.id}`, payload: { apiKey: 'sk-new-0000000000' } });
    expect(b.providers.store.keyOf(p.id)).toBe('sk-new-0000000000');
    const cleared = (await b.app.inject({ method: 'PATCH', url: `/api/providers/${p.id}`, payload: { apiKey: '' } })).json() as ProviderInfo;
    expect(cleared.hasKey).toBe(false);
    expect(cleared.name).toBe('Work');

    // built-in providers cannot be pointed elsewhere; custom ones can, but must be http(s)
    expect((await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'anthropic', baseUrl: 'https://evil.example/v1' } })).statusCode).toBe(400);
    expect((await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'custom', baseUrl: 'file:///etc/passwd' } })).statusCode).toBe(400);
    expect((await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'custom', baseUrl: 'not a url' } })).statusCode).toBe(400);
    const custom = await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'custom', name: 'Ollama', baseUrl: 'http://localhost:11434/v1/' } });
    expect((custom.json() as ProviderInfo).baseUrl).toBe('http://localhost:11434/v1');

    // agent settings follow provider removal
    const set = await b.app.inject({ method: 'PUT', url: '/api/agent/settings', payload: { providerId: p.id, model: 'gpt-5', effort: 'high', mode: 'auto' } });
    expect(set.json()).toMatchObject({ providerId: p.id, model: 'gpt-5', effort: 'high', mode: 'auto' });
    expect((await b.app.inject({ method: 'PUT', url: '/api/agent/settings', payload: { providerId: 'prov_nope', effort: 'low', mode: 'ask' } })).statusCode).toBe(404);
    expect((await b.app.inject({ method: 'PUT', url: '/api/agent/settings', payload: { effort: 'warp', mode: 'ask' } })).statusCode).toBe(400);
    await b.app.inject({ method: 'DELETE', url: `/api/providers/${p.id}` });
    expect(((await b.app.inject({ method: 'GET', url: '/api/providers' })).json() as { agent: { providerId?: string } }).agent.providerId).toBeUndefined();
    expect((await b.app.inject({ method: 'DELETE', url: `/api/providers/${p.id}` })).statusCode).toBe(404);
  });

  it('tests a provider and lists its models through the API, without leaking the key in errors', async () => {
    const f = await fake((req, res) => {
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: `Incorrect API key provided: ${req.headers.authorization}` } });
      json(res, 200, { data: [{ id: 'm-big', context_window: 200_000 }, { id: 'claude-sonnet-x' }, { id: 'unknown-model' }] });
    });
    const dir = await tmp();
    const b = await buildApp(loadConfig({ dataDir: dir }), { saveDelayMs: 20 });
    cleanup.push(() => b.app.close());

    const bad = (await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'custom', baseUrl: f.baseUrl, apiKey: 'wrong-key-123456' } })).json() as ProviderInfo;
    const badTest = (await b.app.inject({ method: 'POST', url: `/api/providers/${bad.id}/test` })).json() as { ok: boolean; error?: string };
    expect(badTest.ok).toBe(false);
    expect(badTest.error).toMatch(/401/);
    expect(badTest.error).not.toContain('wrong-key-123456');

    const good = (await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'custom', baseUrl: f.baseUrl, apiKey: KEY } })).json() as ProviderInfo;
    expect((await b.app.inject({ method: 'POST', url: `/api/providers/${good.id}/test` })).json()).toEqual({ ok: true, models: 3 });
    const models = ((await b.app.inject({ method: 'GET', url: `/api/providers/${good.id}/models` })).json() as { models: { id: string; contextWindow: number | null }[] }).models;
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([['claude-sonnet-x', 200_000], ['m-big', 200_000], ['unknown-model', null]]); // table fills the gap

    const noKey = (await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'openai' } })).json() as ProviderInfo;
    expect((await b.app.inject({ method: 'POST', url: `/api/providers/${noKey.id}/test` })).json()).toMatchObject({ ok: false, error: 'Add an API key first.' });
  });

  it('caches models for a while', async () => {
    let n = 0;
    const f = await fake((_req, res) => {
      n++;
      json(res, 200, { data: [{ id: 'a' }] });
    });
    const dir = await tmp();
    const svc = new ProviderService(new AppDb(path.join(dir, 'app.sqlite')), path.join(dir, 'k'));
    const p = svc.store.add({ kind: 'custom', baseUrl: f.baseUrl });
    await svc.models(p.id);
    await svc.models(p.id);
    expect(n).toBe(1);
    await svc.models(p.id, true);
    expect(n).toBe(2);
  });
});

describe('OpenAI-compatible adapter (OpenAI, OpenRouter, custom)', () => {
  const stream = (res: http.ServerResponse) =>
    sseOut(res, [
      { data: { choices: [{ delta: { content: 'Cutting ' } }] } },
      { data: { choices: [{ delta: { content: 'now.' } }] } },
      { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'split_clip', arguments: '{"clipId":"c' } }] } }] } },
      { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1","at":4800}' } }] } }] } },
      { data: { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'split_clip', arguments: '{"clipId":"c2"}' } }] }, finish_reason: 'tool_calls' }] } },
      { data: { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } } },
      '[DONE]',
    ]);

  it('streams text, assembles split tool-call arguments and reports usage', async () => {
    const f = await fake((_r, res) => stream(res));
    const events: string[] = [];
    const messages: ChatMessage[] = [{ role: 'system', content: 'You are an editor.' }, { role: 'user', content: 'split it' }];
    const { chatStream } = await import('../src/providers/llm');
    let result;
    for await (const e of chatStream({ kind: 'openai', baseUrl: f.baseUrl, key: KEY }, { model: 'gpt-5', messages, tools: [TOOL], effort: 'high', maxTokens: 800, temperature: 0.2 })) {
      if (e.type === 'text') events.push(e.delta);
      if (e.type === 'done') result = e.result;
    }
    expect(events.join('')).toBe('Cutting now.');
    expect(result).toEqual({
      text: 'Cutting now.',
      toolCalls: [{ id: 'call_a', name: 'split_clip', arguments: { clipId: 'c1', at: 4800 } }, { id: 'call_b', name: 'split_clip', arguments: { clipId: 'c2' } }],
      usage: { inputTokens: 120, outputTokens: 30 },
      stopReason: 'tool_calls',
    });
    const req = f.seen[0]!;
    expect(req.url).toBe('/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toMatchObject({ model: 'gpt-5', stream: true, reasoning_effort: 'high', max_completion_tokens: 800 });
    expect(req.body.temperature).toBeUndefined(); // reasoning models reject it
    expect(req.body.tools[0]).toEqual({ type: 'function', function: { name: 'split_clip', description: 'Split a clip', parameters: TOOL.parameters } });
  });

  it('maps effort per provider: reasoning_effort, reasoning{effort}, or nothing for custom servers', async () => {
    const f = await fake((_r, res) => sseOut(res, [{ data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } }, '[DONE]']));
    const base = { model: 'm', messages: [{ role: 'user', content: 'hi' } as ChatMessage] };
    await chat({ kind: 'openrouter', baseUrl: f.baseUrl, key: KEY }, { ...base, effort: 'max', maxTokens: 50, temperature: 0.5 });
    await chat({ kind: 'custom', baseUrl: f.baseUrl }, { ...base, effort: 'high', maxTokens: 50, temperature: 0.5 });
    await chat({ kind: 'openai', baseUrl: f.baseUrl, key: KEY }, { ...base, effort: 'off' });
    const [or, custom, off] = f.seen.map((s) => s.body);
    expect(or.reasoning).toEqual({ effort: 'high' });
    expect(or.max_tokens).toBe(50);
    expect(or.temperature).toBe(0.5);
    expect(custom.reasoning).toBeUndefined();
    expect(custom.reasoning_effort).toBeUndefined();
    expect(f.seen[1]!.headers.authorization).toBeUndefined(); // no key, no header
    expect(off.reasoning_effort).toBeUndefined();
  });

  it('converts tool turns', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'split_clip', arguments: { clipId: 'c1' } }] },
      { role: 'tool', toolCallId: 't1', name: 'split_clip', content: '{"ok":true}' },
    ];
    expect(toOpenAI(msgs)).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'split_clip', arguments: '{"clipId":"c1"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '{"ok":true}' },
    ]);
  });

  it('turns HTTP errors into readable messages that never contain the key', async () => {
    const f = await fake((req, res) => json(res, 429, { error: { message: `Rate limited for ${req.headers.authorization}` } }));
    await expect(chat({ kind: 'openai', baseUrl: f.baseUrl, key: KEY }, { model: 'm', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/429.*Rate limited for Bearer ••••/s);
  });
});

describe('Anthropic adapter', () => {
  it('shapes the request (system, thinking budget, tools) and parses thinking, text and tool_use', async () => {
    const f = await fake((_r, res) =>
      sseOut(res, [
        { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 200 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Splitting.' } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'split_clip' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"clipId":' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"c9"}' } } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 77 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    );
    const conn = { kind: 'anthropic' as const, baseUrl: f.baseUrl, key: KEY };
    const r = await chat(conn, { model: 'claude-x', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'split c9' }], tools: [TOOL], effort: 'medium', temperature: 0.3 });
    expect(r).toEqual({
      text: 'Splitting.',
      toolCalls: [{ id: 'toolu_1', name: 'split_clip', arguments: { clipId: 'c9' } }],
      usage: { inputTokens: 200, outputTokens: 77 },
      stopReason: 'tool_calls',
      providerData: [{ type: 'thinking', thinking: 'hmm', signature: 'SIG' }],
    });
    const req = f.seen[0]!;
    expect(req.url).toBe('/messages');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.body.system).toBe('Be brief.');
    expect(req.body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(req.body.max_tokens).toBeGreaterThan(4096);
    expect(req.body.temperature).toBeUndefined(); // incompatible with thinking
    expect(req.body.tools[0]).toMatchObject({ name: 'split_clip', input_schema: TOOL.parameters });
    expect(req.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'split c9' }] }]);
  });

  it('replays thinking blocks and folds consecutive tool results into one user turn', () => {
    const { system, messages } = toAnthropic([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok', providerData: [{ type: 'thinking', thinking: 'x', signature: 'SIG' }], toolCalls: [{ id: 'a', name: 'f', arguments: { n: 1 } }, { id: 'b', name: 'g', arguments: {} }] },
      { role: 'tool', toolCallId: 'a', name: 'f', content: 'one' },
      { role: 'tool', toolCallId: 'b', name: 'g', content: 'two' },
    ]);
    expect(system).toBe('S');
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'x', signature: 'SIG' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'a', name: 'f', input: { n: 1 } }, { type: 'tool_use', id: 'b', name: 'g', input: {} }],
    });
    expect(messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'one' }, { type: 'tool_result', tool_use_id: 'b', content: 'two' }] });
  });

  it('lists models with context windows', async () => {
    const f = await fake((req, res) => json(res, 200, { data: [{ id: 'claude-opus-x', display_name: 'Claude Opus X' }], headers: req.headers['x-api-key'] }));
    expect(await listModels({ kind: 'anthropic', baseUrl: f.baseUrl, key: KEY })).toEqual([{ id: 'claude-opus-x', name: 'Claude Opus X', contextWindow: 200_000 }]);
    expect(f.seen[0]!.headers['x-api-key']).toBe(KEY);
  });
});

describe('Gemini adapter', () => {
  it('shapes the request (schema subset, thinking budget) and parses text, thoughts and function calls', async () => {
    const f = await fake((_r, res) =>
      sseOut(res, [
        { data: { candidates: [{ content: { parts: [{ text: 'considering', thought: true }] } }] } },
        { data: { candidates: [{ content: { parts: [{ text: 'On it.' }, { functionCall: { name: 'split_clip', args: { clipId: 'c5' } }, thoughtSignature: 'TS' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12, thoughtsTokenCount: 8 } } },
      ]),
    );
    const conn = { kind: 'gemini' as const, baseUrl: f.baseUrl, key: KEY };
    const r = await chat(conn, { model: 'gemini-x', messages: [{ role: 'system', content: 'Edit.' }, { role: 'user', content: 'split c5' }], tools: [TOOL], effort: 'low', maxTokens: 500 });
    expect(r.text).toBe('On it.');
    expect(r.toolCalls).toEqual([{ id: 'call_0', name: 'split_clip', arguments: { clipId: 'c5' } }]);
    expect(r.usage).toEqual({ inputTokens: 90, outputTokens: 20 });
    expect(r.stopReason).toBe('tool_calls');
    expect(r.providerData).toEqual([{ text: 'On it.' }, { functionCall: { name: 'split_clip', args: { clipId: 'c5' } }, thoughtSignature: 'TS' }]);
    const req = f.seen[0]!;
    expect(req.url).toBe('/models/gemini-x:streamGenerateContent?alt=sse');
    expect(req.headers['x-goog-api-key']).toBe(KEY);
    expect(req.body.systemInstruction).toEqual({ parts: [{ text: 'Edit.' }] });
    expect(req.body.generationConfig).toEqual({ maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } });
    expect(req.body.tools[0].functionDeclarations[0].parameters).toEqual({ type: 'OBJECT', properties: { clipId: { type: 'STRING' }, at: { type: 'INTEGER' } }, required: ['clipId'] });
  });

  it('keeps raw parts (thought signatures) on replay and answers function calls', () => {
    const { contents } = toGemini([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'x', providerData: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'TS' }], toolCalls: [{ id: 'call_0', name: 'f', arguments: {} }] },
      { role: 'tool', toolCallId: 'call_0', name: 'f', content: '{"ok":true}' },
      { role: 'tool', toolCallId: 'call_1', name: 'g', content: 'plain text' },
    ]);
    expect(contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'TS' }] });
    expect(contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }, { functionResponse: { name: 'g', response: { result: 'plain text' } } }] });
    expect(geminiSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'array', items: { type: 'number', default: 1 } } } })).toEqual({ type: 'OBJECT', properties: { a: { type: 'ARRAY', items: { type: 'NUMBER' } } } });
  });

  it('lists only models that can generate content', async () => {
    const f = await fake((_r, res) =>
      json(res, 200, { models: [{ name: 'models/gemini-pro-x', displayName: 'Gemini Pro X', inputTokenLimit: 1_048_576, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed-1', supportedGenerationMethods: ['embedContent'] }] }),
    );
    expect(await listModels({ kind: 'gemini', baseUrl: f.baseUrl, key: KEY })).toEqual([{ id: 'gemini-pro-x', name: 'Gemini Pro X', contextWindow: 1_048_576 }]);
  });
});
