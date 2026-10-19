import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type ChatState, type ChatTurn, type ServerEvent, allClips } from '@cutroom/core';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { fixtures, type Fixtures } from './helpers/media';

let fx: Fixtures;
const cleanup: (() => Promise<void> | void)[] = [];
beforeAll(async () => {
  fx = await fixtures();
});
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
const tmp = async (p: string) => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `cutroom-${p}-`));
  cleanup.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

type Step = { text?: string; calls?: { name: string; args: unknown }[] };
/** An OpenAI-compatible endpoint whose "model" follows a script, one step per tool round-trip. */
async function fakeModel(steps: Step[]): Promise<{ baseUrl: string; requests: any[] }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/models') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'fake', context_length: 100000 }] }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const round = body.messages.filter((m: any) => m.role === 'assistant').length;
      const step = steps[Math.min(round, steps.length - 1)]!;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (step.text) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`);
      (step.calls ?? []).forEach((c, i) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${round}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] })}\n\n`));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 500 + round * 100, completion_tokens: 40 } })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

async function setup(steps: Step[], mode: 'ask' | 'auto' | 'full' = 'auto') {
  const model = await fakeModel(steps);
  const dataDir = await tmp('data');
  const b = await buildApp(loadConfig({ dataDir }), { saveDelayMs: 20 });
  cleanup.push(() => b.app.close());
  const dir = await tmp('proj');
  await fs.copyFile(fx.sync, path.join(dir, 'clip.mp4'));
  expect((await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: dir } })).statusCode).toBe(200);
  const p = (await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'custom', name: 'Fake', baseUrl: model.baseUrl } })).json();
  await b.app.inject({ method: 'PUT', url: '/api/agent/settings', payload: { providerId: p.id, model: 'fake', effort: 'off', mode } });
  return { b, model, dir, dataDir };
}
const chat = async (b: BuiltApp): Promise<ChatState> => (await b.app.inject({ method: 'GET', url: '/api/agent/chat' })).json();
const run = async (b: BuiltApp, prompt: string) => (await b.app.inject({ method: 'POST', url: '/api/agent/runs', payload: { prompt } }));

const SCRIPT: Step[] = [
  { text: 'Placing the clip. ', calls: [{ name: 'add_clip', args: { mediaId: 'clip.mp4', at: 0, sourceIn: 0, sourceOut: 6 } }] },
  { calls: [{ name: 'remove_range', args: { from: 1, to: 2 } }] },
  { text: 'Done: removed one second.' },
];

describe('agent runs through the real edit session', () => {
  it('runs end to end: model → tools → grouped agent edits → diff → accept', async () => {
    const { b, model } = await setup(SCRIPT);
    const res = await run(b, 'Put the interview on the timeline and cut out 1–2 s');
    expect(res.statusCode).toBe(202);
    await b.agent.idle();

    const st = await chat(b);
    expect(st.activeRunId).toBeUndefined();
    const turn = st.turns[0]!;
    expect(turn).toMatchObject({ status: 'done', summary: 'Done: removed one second.', edits: 2, review: 'pending', model: 'fake' });
    expect(turn.events.map((e) => e.type)).toEqual(expect.arrayContaining(['run_start', 'text', 'tool_call', 'tool_result', 'done']));
    expect(turn.events.at(-1)).toMatchObject({ type: 'usage' });

    const seq = b.manager.requireSession().state;
    const clips = allClips(seq);
    expect(clips.length).toBeGreaterThanOrEqual(4); // video + audio, cut once → pieces
    expect(clips.every((c) => c.createdBy === 'agent:director' && !c.accepted)).toBe(true);
    const total = Math.max(...clips.map((c) => c.start + c.duration)) / seq.timebase.rate;
    expect(total).toBe(5); // 6 s − 1 s
    expect(turn.diff!.added.length).toBeGreaterThan(0);
    expect(b.manager.requireSession().history().undo.every((t) => t.group === turn.group && t.origin === 'agent:director')).toBe(true);

    // the model got real tool schemas and the system prompt
    const first = model.requests[0];
    expect(first.messages[0].role).toBe('system');
    expect(first.messages[0].content).toContain('You are the Director');
    expect(first.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['get_sequence', 'remove_range', 'delegate']));
    expect(first.tools.find((t: any) => t.function.name === 'split').function.parameters.properties.clipId.type).toBe('string');

    // accept: the "AI" markers go away, in one undoable user transaction
    const accepted = (await b.app.inject({ method: 'POST', url: `/api/agent/runs/${turn.runId}/accept` })).json() as ChatTurn;
    expect(accepted.review).toBe('accepted');
    expect(allClips(b.manager.requireSession().state).every((c) => c.accepted)).toBe(true);
  }, 60_000);

  it('undo reverts the whole run at once', async () => {
    const { b } = await setup(SCRIPT);
    await run(b, 'do it');
    await b.agent.idle();
    const turn = (await chat(b)).turns[0]!;
    const undone = (await b.app.inject({ method: 'POST', url: `/api/agent/runs/${turn.runId}/undo` })).json() as ChatTurn;
    expect(undone.review).toBe('undone');
    expect(allClips(b.manager.requireSession().state)).toHaveLength(0);
    // …and a user edit in between blocks it, with an explanation
    await run(b, 'again');
    await b.agent.idle();
    const t2 = (await chat(b)).turns[1]!;
    b.manager.requireSession().edit({ ops: [{ type: 'addMarker', time: 0, label: 'mine' }], origin: 'user' });
    const blocked = await b.app.inject({ method: 'POST', url: `/api/agent/runs/${t2.runId}/undo` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/newer edits/);
  }, 60_000);

  it('Ask mode pauses on each edit until the user answers; a denial changes nothing', async () => {
    const { b } = await setup(SCRIPT, 'ask');
    await run(b, 'do it');
    const waitPending = async (): Promise<ChatTurn> => {
      for (let i = 0; i < 400; i++) {
        const t = (await chat(b)).turns[0];
        if (t?.pending) return t;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('no approval request appeared');
    };
    const t1 = await waitPending();
    expect(t1.pending).toMatchObject({ tool: 'add_clip', role: 'director' });
    expect(t1.pending!.summary).toBe('Add clip.mp4 at 0');
    expect(allClips(b.manager.requireSession().state)).toHaveLength(0); // nothing happened yet
    await b.app.inject({ method: 'POST', url: `/api/agent/runs/${t1.runId}/approve`, payload: { requestId: t1.pending!.id, decision: 'approve' } });
    const t2 = await waitPending();
    expect(t2.pending!.tool).toBe('remove_range');
    expect(allClips(b.manager.requireSession().state).length).toBeGreaterThan(0);
    await b.app.inject({ method: 'POST', url: `/api/agent/runs/${t2.runId}/approve`, payload: { requestId: t2.pending!.id, decision: 'deny' } });
    await b.agent.idle();
    const turn = (await chat(b)).turns[0]!;
    expect(turn.edits).toBe(1);
    const total = Math.max(...allClips(b.manager.requireSession().state).map((c) => c.start + c.duration)) / 48000;
    expect(total).toBe(6); // the removal was declined
    expect((await b.app.inject({ method: 'POST', url: `/api/agent/runs/${t2.runId}/approve`, payload: { requestId: 'x', decision: 'approve' } })).statusCode).toBe(404);
  }, 60_000);

  it('can be stopped while waiting for approval, and refuses a second run meanwhile', async () => {
    const { b } = await setup(SCRIPT, 'ask');
    const r = (await run(b, 'do it')).json() as { runId: string };
    for (let i = 0; i < 400 && !(await chat(b)).turns[0]?.pending; i++) await new Promise((x) => setTimeout(x, 25));
    expect((await run(b, 'second')).statusCode).toBe(409); // one run at a time
    expect((await run(b, 'second')).json().error).toBe('busy');
    expect((await b.app.inject({ method: 'POST', url: `/api/agent/runs/${r.runId}/cancel` })).statusCode).toBe(200);
    await b.agent.idle();
    expect((await chat(b)).turns[0]).toMatchObject({ status: 'cancelled', edits: 0 });
  }, 60_000);

  it('explains what is missing instead of failing mysteriously', async () => {
    const dataDir = await tmp('data');
    const b = await buildApp(loadConfig({ dataDir }), { saveDelayMs: 20 });
    cleanup.push(() => b.app.close());
    const dir = await tmp('proj');
    await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: dir } });
    const none = await run(b, 'hello');
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ error: 'no_provider' });
    const p = (await b.app.inject({ method: 'POST', url: '/api/providers', payload: { kind: 'custom', baseUrl: 'http://127.0.0.1:9' } })).json();
    await b.app.inject({ method: 'PUT', url: '/api/agent/settings', payload: { providerId: p.id, effort: 'off', mode: 'auto' } });
    expect((await run(b, 'hello')).json()).toMatchObject({ error: 'no_model' });

    // unreachable provider: the run ends with the error, edits none
    await b.app.inject({ method: 'PUT', url: '/api/agent/settings', payload: { providerId: p.id, model: 'm', effort: 'off', mode: 'auto' } });
    const started = await run(b, 'hello');
    expect(started.statusCode).toBe(202);
    await b.agent.idle();
    const turn = (await chat(b)).turns[0]!;
    expect(turn.status).toBe('error');
    expect(turn.summary).toMatch(/Could not reach/);
    expect(turn.review).toBe('dismissed'); // nothing to review
  }, 60_000);

  it('streams agent events over the websocket and keeps the transcript across a restart', async () => {
    const { b, dir, dataDir } = await setup(SCRIPT);
    await b.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (b.app.server.address() as { port: number }).port;
    const events: ServerEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'http://localhost:5173' } });
    cleanup.push(async () => ws.close());
    ws.on('message', (d) => events.push(JSON.parse(d.toString()) as ServerEvent));
    await new Promise((r) => ws.once('open', r));
    await run(b, 'stream me');
    await b.agent.idle();
    await new Promise((r) => setTimeout(r, 100));
    const agent = events.filter((e): e is Extract<ServerEvent, { type: 'agent' }> => e.type === 'agent');
    expect(agent.filter((e) => e.kind === 'turn').length).toBeGreaterThanOrEqual(2); // started, finished
    const kinds = agent.filter((e) => e.kind === 'event').map((e) => (e as { event: { type: string } }).event.type);
    expect(kinds[0]).toBe('run_start');
    expect(kinds.at(-1)).toBe('done');
    expect(kinds).toContain('tool_result');

    // restart: a new app on the same folder restores the conversation
    await b.agent.flush();
    await b.app.close();
    const b2 = await buildApp(loadConfig({ dataDir }), { saveDelayMs: 20 });
    cleanup.push(() => b2.app.close());
    await b2.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: dir } });
    const restored = (await b2.app.inject({ method: 'GET', url: '/api/agent/chat' })).json() as ChatState;
    expect(restored.turns[0]).toMatchObject({ prompt: 'stream me', status: 'done', summary: 'Done: removed one second.' });
    expect((await b2.app.inject({ method: 'DELETE', url: '/api/agent/chat' })).statusCode).toBe(200);
    expect(((await b2.app.inject({ method: 'GET', url: '/api/agent/chat' })).json() as ChatState).turns).toEqual([]);
  }, 60_000);
});
