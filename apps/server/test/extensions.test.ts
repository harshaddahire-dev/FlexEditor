import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtensionsInfo, McpServerInfo } from '@cutroom/core';
import { type PluginContext } from '@cutroom/plugin-sdk';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';

const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
const tmp = async (p: string) => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `cutroom-${p}-`));
  cleanup.push(() => fs.rm(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return d;
};
async function setup(): Promise<{ b: BuiltApp; dataDir: string }> {
  const dataDir = await tmp('ext');
  const b = await buildApp(loadConfig({ dataDir }), { saveDelayMs: 20 });
  cleanup.push(() => b.app.close());
  await b.extensions.settled();
  return { b, dataDir };
}
const info = async (b: BuiltApp): Promise<ExtensionsInfo> => (await b.app.inject({ method: 'GET', url: '/api/extensions' })).json();
const ctx = (): PluginContext => ({ sequence: () => ({}) as never, media: () => [], analysis: async () => null, applyOps: () => ({ revision: 1 }), log: () => undefined });

describe('skills', () => {
  it('ships the eight built-in skills, all valid', async () => {
    const { b } = await setup();
    const { skills, errors } = await info(b);
    expect(errors).toEqual([]);
    const builtin = skills.filter((s) => s.source === 'builtin').map((s) => s.name);
    expect(builtin).toEqual(['beat-sync-montage', 'chapter-markers', 'highlight-reel', 'interview-rough-cut', 'loudness-master', 'podcast-cleanup', 'shorts-reel', 'youtube-retention-cut']);
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.body.length).toBeGreaterThan(100);
    }
  });

  it('adds user and project skills (project wins), reports broken ones, and can switch a skill off', async () => {
    const { b, dataDir } = await setup();
    await fs.mkdir(path.join(dataDir, 'skills', 'my-skill'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: Mine\n---\nDo the thing.');
    await fs.mkdir(path.join(dataDir, 'skills', 'broken'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'skills', 'broken', 'SKILL.md'), 'no frontmatter here');
    const proj = await tmp('proj');
    await fs.mkdir(path.join(proj, '.cutroom', 'skills', 'shorts-reel'), { recursive: true });
    await fs.writeFile(path.join(proj, '.cutroom', 'skills', 'shorts-reel', 'SKILL.md'), '---\nname: shorts-reel\ndescription: Our own shorts recipe\n---\nHouse style.');
    expect((await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: proj } })).statusCode).toBe(200);

    const r = await info(b);
    expect(r.skills.find((s) => s.name === 'my-skill')).toMatchObject({ source: 'user', enabled: true });
    expect(r.skills.find((s) => s.name === 'shorts-reel')).toMatchObject({ source: 'project', description: 'Our own shorts recipe' });
    expect(r.errors.join('\n')).toMatch(/broken[\\/]SKILL\.md: SKILL\.md must start with/);

    await b.app.inject({ method: 'PUT', url: '/api/extensions/skills/my-skill', payload: { enabled: false } });
    expect(b.extensions.skills().map((s) => s.name)).not.toContain('my-skill');
    expect((await info(b)).skills.find((s) => s.name === 'my-skill')!.enabled).toBe(false);
    expect((await b.app.inject({ method: 'PUT', url: '/api/extensions/skills/nope', payload: { enabled: false } })).statusCode).toBe(404);
  });
});

describe('plugins', () => {
  it('loads the example plugin, runs its tool, and lists its skill', async () => {
    const { b } = await setup();
    const r = await info(b);
    const p = r.plugins.find((x) => x.id === 'pacing-tools')!;
    expect(p).toMatchObject({ status: 'ready', enabled: true, skills: ['pacing-check'] });
    expect(p.tools.map((t) => t.name)).toEqual(['plugin_pacing-tools__pacing_report']);
    expect(r.skills.find((s) => s.name === 'pacing-check')).toMatchObject({ source: 'plugin:pacing-tools' });
    const tool = b.extensions.externalTools().find((t) => t.source === 'plugin:pacing-tools')!;
    const seq = { timebase: { rate: 30 }, tracks: [{ kind: 'video', items: { a: { kind: 'clip', duration: 60 }, b: { kind: 'clip', duration: 180 } } }, { kind: 'audio', items: { c: { kind: 'clip', duration: 999 } } }] };
    expect(await tool.call({}, { ...ctx(), sequence: () => seq as never })).toEqual({ clips: 2, averageSeconds: 4, medianSeconds: 6, shortestSeconds: 2, longestSeconds: 6 });
  });

  it('shows a plugin that fails to load as an error, and switching off removes its tools and skills', async () => {
    const { b, dataDir } = await setup();
    const bad = path.join(dataDir, 'plugins', 'bad');
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, 'plugin.json'), JSON.stringify({ id: 'bad', name: 'Bad', version: '1' }));
    await fs.writeFile(path.join(bad, 'index.mjs'), 'throw new Error("boom at import");');
    const wrongId = path.join(dataDir, 'plugins', 'wrong');
    await fs.mkdir(wrongId, { recursive: true });
    await fs.writeFile(path.join(wrongId, 'plugin.json'), JSON.stringify({ id: 'wrong', name: 'Wrong', version: '1' }));
    await fs.writeFile(path.join(wrongId, 'index.mjs'), 'export default { id: "other", name: "x", version: "1" };');
    const r = (await b.app.inject({ method: 'POST', url: '/api/extensions/reload' })).json() as ExtensionsInfo;
    expect(r.plugins.find((p) => p.id === 'bad')).toMatchObject({ status: 'error', error: 'boom at import' });
    expect(r.plugins.find((p) => p.id === 'wrong')).toMatchObject({ status: 'error', error: expect.stringMatching(/does not match plugin\.json/) });
    expect(r.plugins.find((p) => p.id === 'pacing-tools')!.status).toBe('ready');

    await b.app.inject({ method: 'PUT', url: '/api/extensions/plugins/pacing-tools', payload: { enabled: false } });
    expect(b.extensions.externalTools().some((t) => t.source === 'plugin:pacing-tools')).toBe(false);
    expect(b.extensions.skills().some((s) => s.name === 'pacing-check')).toBe(false);
    expect((await info(b)).plugins.find((p) => p.id === 'pacing-tools')).toMatchObject({ enabled: false, status: 'disabled' });
  });
});

describe('MCP servers', () => {
  const add = (b: BuiltApp, payload: object) => b.app.inject({ method: 'POST', url: '/api/extensions/mcp', payload });

  it('connects over stdio, lists and calls tools, and keeps env secrets encrypted and write-only', async () => {
    const { b, dataDir } = await setup();
    const res = await add(b, { name: 'Fake Tools', transport: 'stdio', command: process.execPath, args: [FAKE_MCP], env: { TOKEN: 'sk-super-secret-123' } });
    expect(res.statusCode).toBe(201);
    await b.extensions.settled();
    const s = (await info(b)).mcp[0]!;
    expect(s).toMatchObject({ id: 'fake-tools', status: 'ready', envKeys: ['TOKEN'], tools: expect.arrayContaining([{ name: 'echo', description: 'Echo text back' }]) });
    expect(JSON.stringify(await info(b))).not.toContain('sk-super-secret-123');
    expect(await fs.readFile(path.join(dataDir, 'extensions.json'), 'utf8')).not.toContain('sk-super-secret-123');

    const tools = b.extensions.externalTools();
    const get = (n: string) => tools.find((t) => t.name === `mcp_fake-tools__${n}`)!;
    expect(get('echo')).toMatchObject({ scope: 'read', source: 'mcp:fake-tools', parameters: { required: ['text'] } });
    expect(get('add').scope).toBe('edit');
    expect(await get('echo').call({ text: 'hi' }, ctx())).toEqual({ text: 'echo:hi' });
    expect(await get('add').call({ a: 2, b: 3 }, ctx())).toEqual({ text: '5', data: { sum: 5 } });
    expect(await get('whoami').call({}, ctx())).toEqual({ text: 'sk-super-secret-123' }); // decrypted into the child's environment
    await expect(get('fail').call({}, ctx())).rejects.toThrow('it broke');

    // editing without re-entering the secret keeps it
    const put = await b.app.inject({ method: 'PUT', url: '/api/extensions/mcp/fake-tools', payload: { name: 'Fake Tools', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] } });
    expect(put.statusCode).toBe(200);
    await b.extensions.settled();
    expect(await b.extensions.externalTools().find((t) => t.name === 'mcp_fake-tools__whoami')!.call({}, ctx())).toEqual({ text: 'sk-super-secret-123' });
  });

  it('reports a server that cannot start, can be switched off and removed, and cleans up its process', async () => {
    const { b } = await setup();
    await add(b, { name: 'Missing', transport: 'stdio', command: '/nonexistent/binary-xyz' });
    await b.extensions.settled();
    expect((await info(b)).mcp[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/Could not start/), tools: [] });
    expect(b.extensions.externalTools().filter((t) => t.source === 'mcp:missing')).toEqual([]);

    await add(b, { name: 'Fake', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] });
    await b.extensions.settled();
    expect(b.extensions.externalTools().some((t) => t.source === 'mcp:fake')).toBe(true);
    const off = (await b.app.inject({ method: 'POST', url: '/api/extensions/mcp/fake/enabled', payload: { enabled: false } })).json() as McpServerInfo;
    expect(off).toMatchObject({ enabled: false, status: 'disabled' });
    expect(b.extensions.externalTools().some((t) => t.source === 'mcp:fake')).toBe(false);
    expect((await b.app.inject({ method: 'DELETE', url: '/api/extensions/mcp/fake' })).statusCode).toBe(200);
    expect((await info(b)).mcp.map((m) => m.id)).toEqual(['missing']);
    expect((await add(b, { name: 'x', transport: 'stdio' })).statusCode).toBe(400);
    expect((await add(b, { name: 'x', transport: 'http', url: 'ftp://nope' })).statusCode).toBe(400);
  });

  it('persists servers across restarts and reconnects them', async () => {
    const { b, dataDir } = await setup();
    await add(b, { name: 'Fake', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] });
    await b.app.close();
    cleanup.pop(); // already closed
    const b2 = await buildApp(loadConfig({ dataDir }), { saveDelayMs: 20 });
    cleanup.push(() => b2.app.close());
    await b2.extensions.settled();
    expect((await info(b2)).mcp[0]).toMatchObject({ id: 'fake', status: 'ready' });
  });

  it('speaks streamable HTTP (JSON and event-stream answers) and sends the configured headers', async () => {
    const seen: { auth?: string; session?: string }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seen.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined });
        if (msg.id === undefined) return res.writeHead(202).end();
        const reply = (result: unknown, sse: boolean) => {
          const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
          if (sse) res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's-1' }).end(`event: message\ndata: ${body}\n\n`);
          else res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' }).end(body);
        };
        if (msg.method === 'initialize') return reply({ protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'h', version: '1' } }, false);
        if (msg.method === 'tools/list') return reply({ tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] }, true);
        return reply({ content: [{ type: 'text', text: 'pong' }] }, true);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;

    const { b } = await setup();
    expect((await add(b, { name: 'Remote', transport: 'http', url, headers: { Authorization: 'Bearer abc' } })).statusCode).toBe(201);
    await b.extensions.settled();
    const s = (await info(b)).mcp[0]!;
    expect(s).toMatchObject({ status: 'ready', headerKeys: ['Authorization'], tools: [{ name: 'ping', description: 'Ping' }] });
    expect(await b.extensions.externalTools().find((t) => t.name === 'mcp_remote__ping')!.call({}, ctx())).toEqual({ text: 'pong' });
    expect(seen.every((x) => x.auth === 'Bearer abc')).toBe(true);
    expect(seen.at(-1)!.session).toBe('s-1'); // the session id from initialize is sent back
  });
});

describe('agent runs with extensions', () => {
  /** One scripted OpenAI-compatible "model": first answer calls the MCP echo tool, then it finishes. */
  async function fakeModel(toolName: string): Promise<{ baseUrl: string; requests: any[] }> {
    const requests: any[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/models') return res.setHeader('content-type', 'application/json').end(JSON.stringify({ data: [{ id: 'fake' }] }));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        const round = body.messages.filter((m: any) => m.role === 'assistant').length;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (round === 0) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: toolName, arguments: JSON.stringify({ text: 'from the model' }) } }] } }] })}\n\n`);
        else res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'All done.' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: round === 0 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
  }

  async function runWith(mode: 'auto' | 'full', prompt: string) {
    const model = await fakeModel('mcp_fake__echo');
    const { b } = await setup();
    const proj = await tmp('proj');
    await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: proj } });
    await b.app.inject({ method: 'POST', url: '/api/extensions/mcp', payload: { name: 'Fake', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] } });
    await b.extensions.settled();
    const p = (await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'custom', name: 'Fake', baseUrl: model.baseUrl } })).json();
    await b.app.inject({ method: 'PUT', url: '/api/agent/settings', payload: { providerId: p.id, model: 'fake', effort: 'off', mode } });
    expect((await b.app.inject({ method: 'POST', url: '/api/agent/runs', payload: { prompt } })).statusCode).toBe(202);
    await b.agent.idle();
    return { b, model, chat: (await b.agent.state()).turns[0]! };
  }

  it('Full access lets the model call an MCP tool; the skill index and /skill commands reach it', async () => {
    const { model, chat } = await runWith('full', '/chapter-markers for the talk');
    const first = model.requests[0];
    expect(first.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['mcp_fake__echo', 'use_skill']));
    expect(first.messages[0].content).toMatch(/- youtube-retention-cut: /);
    expect(first.messages.at(-1).content).toMatch(/Use the "chapter-markers" skill[\s\S]*for the talk/);
    expect(chat).toMatchObject({ status: 'done', summary: 'All done.', prompt: '/chapter-markers for the talk' });
    expect(chat.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, tool: 'mcp_fake__echo' });
    expect(model.requests[1].messages.find((m: any) => m.role === 'tool').content).toContain('echo:from the model');
  });

  it('Auto mode does not offer external tools at all', async () => {
    const { model, chat } = await runWith('auto', 'hello');
    expect(model.requests[0].tools.map((t: any) => t.function.name)).not.toContain('mcp_fake__echo');
    expect(chat.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: expect.stringMatching(/Unknown tool/) });
  });
});
