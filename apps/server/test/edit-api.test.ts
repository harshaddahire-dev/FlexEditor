import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { trackItems, type EditResponse, type HistoryState, type Sequence, type ServerEvent, applyPatches, validateSequence, type Patch } from '@cutroom/core';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { fixtures, type Fixtures } from './helpers/media';

let fx: Fixtures;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  fx = await fixtures();
});
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function tmp(p: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `cutroom-${p}-`));
  cleanup.push(() => fs.rm(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return d;
}

async function setup(): Promise<{ b: BuiltApp; dir: string; mediaId: string; R: number; F: number }> {
  const b = await buildApp(loadConfig({ dataDir: await tmp('data') }), { saveDelayMs: 30 });
  cleanup.push(() => b.app.close());
  const dir = await tmp('proj');
  await fs.copyFile(fx.sync, path.join(dir, 'clip.mp4'));
  const res = await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: dir } });
  expect(res.statusCode).toBe(200);
  const seq = b.manager.requireSession().state;
  return { b, dir, mediaId: b.manager.current!.media[0]!.id, R: seq.timebase.rate, F: (seq.timebase.rate * seq.timebase.fps.den) / seq.timebase.fps.num };
}

const post = (b: BuiltApp, url: string, payload?: unknown) => b.app.inject({ method: 'POST', url, payload: payload as object });
const seqOf = (b: BuiltApp): Sequence => b.manager.requireSession().state;
const clips = (s: Sequence, trackName: string) => trackItems(s.tracks.find((t) => t.name === trackName)!);

function insertAV(ctx: Awaited<ReturnType<typeof setup>>, atFrame: number, sec: number, extra: object = {}) {
  const { b, mediaId, R, F } = ctx;
  const s = seqOf(b);
  const v = s.tracks.find((t) => t.name === 'V1')!.id;
  const a = s.tracks.find((t) => t.name === 'A1')!.id;
  return post(b, '/api/edit', {
    label: 'Add clip',
    ops: [{ type: 'insert', at: atFrame * F, clips: [{ trackId: v, mediaId, sourceIn: 0, sourceOut: sec * R, link: 'x' }, { trackId: a, mediaId, sourceIn: 0, sourceOut: sec * R, link: 'x' }] }],
    ...extra,
  });
}

describe('sequence + edit API', () => {
  it('opening a project creates a sequence from the footage settings', async () => {
    const { b } = await setup();
    const res = (await b.app.inject('/api/sequence')).json() as { revision: number; sequence: Sequence };
    expect(res.revision).toBe(0);
    expect(res.sequence).toMatchObject({ width: 640, height: 360, timebase: { rate: 48000, fps: { num: 30, den: 1 }, sampleRate: 48000 } });
    expect(res.sequence.tracks.map((t) => t.name)).toEqual(['V1', 'V2', 'A1', 'A2']);
    expect(b.manager.current!.sequences).toHaveLength(1);
  });

  it('applies a transaction, returns patches, bumps revision, lists history', async () => {
    const ctx = await setup();
    const res = await insertAV(ctx, 0, 3);
    expect(res.statusCode).toBe(200);
    const body = res.json() as EditResponse;
    expect(body.revision).toBe(1);
    expect(body.transaction).toMatchObject({ label: 'Add clip', origin: 'user', opCount: 1 });
    expect(body.patches.length).toBeGreaterThan(0);
    expect(body.history).toMatchObject({ canUndo: true, canRedo: false });
    const s = seqOf(ctx.b);
    expect(clips(s, 'V1')).toHaveLength(1);
    expect(clips(s, 'A1')).toHaveLength(1);
    expect(validateSequence(s, { getMedia: ctx.b.manager.requireSession().editor.env.getMedia })).toEqual([]);
  });

  it('is atomic: when the 3rd op is rejected nothing from the transaction survives, and the error names the op', async () => {
    const ctx = await setup();
    await insertAV(ctx, 0, 3);
    const before = JSON.stringify(seqOf(ctx.b));
    const rev = ctx.b.manager.revision;
    const v1 = clips(seqOf(ctx.b), 'V1')[0]!.id;
    const res = await post(ctx.b, '/api/edit', {
      ops: [
        { type: 'addMarker', time: 0, label: 'ok' },
        { type: 'split', clipId: v1, at: 30 * ctx.F },
        { type: 'split', clipId: v1, at: 999 * ctx.F }, // outside the clip
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'edit_invalid', details: { code: 'out_of_bounds', opIndex: 2 } });
    expect(res.json().message).toMatch(/Operation 3 \(split\) was rejected/);
    expect(JSON.stringify(seqOf(ctx.b))).toBe(before);
    expect(ctx.b.manager.revision).toBe(rev);
  });

  it('rejects malformed requests, bad origins and stale revisions', async () => {
    const ctx = await setup();
    expect((await post(ctx.b, '/api/edit', { ops: [] })).statusCode).toBe(400);
    expect((await post(ctx.b, '/api/edit', {})).statusCode).toBe(400);
    const nonsense = await post(ctx.b, '/api/edit', { ops: [{ type: 'nope' }] });
    expect(nonsense.statusCode).toBe(422);
    expect(nonsense.json().details.code).toBe('invalid');
    expect((await post(ctx.b, '/api/edit', { origin: 'root', ops: [{ type: 'addMarker', time: 0, label: 'x' }] })).statusCode).toBe(400);
    await insertAV(ctx, 0, 2);
    const stale = await post(ctx.b, '/api/edit', { baseRevision: 0, ops: [{ type: 'addMarker', time: 0, label: 'x' }] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale', details: { revision: 1 } });
    expect((await post(ctx.b, '/api/edit', { baseRevision: 1, ops: [{ type: 'addMarker', time: 0, label: 'x' }] })).statusCode).toBe(200);
  });

  it('undo / redo through the API restore exact states', async () => {
    const ctx = await setup();
    const s0 = JSON.stringify(seqOf(ctx.b));
    await insertAV(ctx, 0, 3);
    const s1 = JSON.stringify(seqOf(ctx.b));
    const u = await post(ctx.b, '/api/history/undo');
    expect(u.json()).toMatchObject({ label: 'Add clip' });
    expect(JSON.stringify(seqOf(ctx.b))).toBe(s0);
    await post(ctx.b, '/api/history/redo');
    expect(JSON.stringify(seqOf(ctx.b))).toBe(s1);
    expect((await post(ctx.b, '/api/history/redo')).json().label).toBeNull(); // nothing left to redo
    const h = (await ctx.b.app.inject('/api/history')).json() as HistoryState;
    expect(h).toMatchObject({ canUndo: true, canRedo: false });
    expect(h.undo).toHaveLength(1);
  });

  it('persists the sequence in project.json and restores it on reopen', async () => {
    const ctx = await setup();
    await insertAV(ctx, 0, 3);
    await insertAV(ctx, 90, 2);
    const before = JSON.parse(JSON.stringify(seqOf(ctx.b)));
    await ctx.b.manager.flush();
    await post(ctx.b, '/api/project/close');
    const onDisk = JSON.parse(await fs.readFile(path.join(ctx.dir, '.cutroom', 'project.json'), 'utf8'));
    expect(onDisk.sequences[0]).toEqual(before);
    await post(ctx.b, '/api/project/open', { path: ctx.dir });
    expect(seqOf(ctx.b)).toEqual(before);
    // ids keep counting from where they left off
    await insertAV(ctx, 300, 1);
    const ids = new Set(seqOf(ctx.b).tracks.flatMap((t) => Object.keys(t.items)));
    expect(ids.size).toBe(6);
  });
});

describe('agent turns', () => {
  it('an agent transaction is one history entry, snapshotted, and can be restored as a new undoable step', async () => {
    const ctx = await setup();
    await insertAV(ctx, 0, 6);
    const v1 = clips(seqOf(ctx.b), 'V1')[0]!.id;
    const afterUser = JSON.stringify(seqOf(ctx.b));

    const turn = await post(ctx.b, '/api/edit', {
      origin: 'agent:cutter',
      label: 'Removed 2 silences · −1.5 s',
      ops: [
        { type: 'removeRange', start: 100 * ctx.F, end: 130 * ctx.F },
        { type: 'removeRange', start: 20 * ctx.F, end: 35 * ctx.F },
      ],
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().transaction).toMatchObject({ origin: 'agent:cutter', opCount: 2, label: 'Removed 2 silences · −1.5 s' });
    const afterAgent = JSON.stringify(seqOf(ctx.b));
    expect(afterAgent).not.toBe(afterUser);
    expect(v1).toBeTruthy();

    await ctx.b.manager.requireSession().flush();
    const h = (await ctx.b.app.inject('/api/history')).json() as HistoryState;
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]).toMatchObject({ origin: 'agent:cutter', label: 'Removed 2 silences · −1.5 s' });
    const snapFiles = await fs.readdir(path.join(ctx.dir, '.cutroom', 'history'));
    expect(snapFiles).toEqual(expect.arrayContaining(['index.json', `${h.snapshots[0]!.id}.json`]));

    // more edits, then jump back to the agent's result
    await post(ctx.b, '/api/edit', { ops: [{ type: 'addMarker', time: 0, label: 'later' }] });
    const restored = await post(ctx.b, '/api/history/restore', { snapshotId: h.snapshots[0]!.id });
    expect(restored.statusCode).toBe(200);
    expect(JSON.stringify(seqOf(ctx.b))).toBe(afterAgent);
    expect(restored.json().transaction.label).toMatch(/^Restore/);
    await post(ctx.b, '/api/history/undo'); // restoring is itself undoable
    expect(seqOf(ctx.b).markers).toHaveLength(1);
    expect((await post(ctx.b, '/api/history/restore', { snapshotId: 'nope' })).statusCode).toBe(404);
  });
});

describe('realtime sync', () => {
  it('patches streamed over the websocket rebuild the server state exactly (commit, undo, redo, restore)', async () => {
    const ctx = await setup();
    await ctx.b.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (ctx.b.app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'http://localhost:5173' } });
    cleanup.push(async () => ws.close());
    const events: ServerEvent[] = [];
    ws.on('message', (d) => events.push(JSON.parse(d.toString()) as ServerEvent));
    await new Promise((r) => ws.once('open', r));

    // the client's mirror starts from the REST snapshot, exactly as the web app does
    const snap = (await ctx.b.app.inject('/api/sequence')).json() as { revision: number; sequence: Sequence };
    let mirror = snap.sequence;
    let rev = snap.revision;

    await insertAV(ctx, 0, 6);
    const v1 = clips(seqOf(ctx.b), 'V1')[0]!.id;
    await post(ctx.b, '/api/edit', { ops: [{ type: 'split', clipId: v1, at: 60 * ctx.F }, { type: 'removeRange', start: 20 * ctx.F, end: 40 * ctx.F }, { type: 'addMarker', time: 5, label: 'm' }] });
    await post(ctx.b, '/api/history/undo');
    await post(ctx.b, '/api/history/redo');
    await post(ctx.b, '/api/edit', { origin: 'agent:motion', ops: [{ type: 'addKeyframe', clipId: v1, prop: 'opacity', keyframe: { time: 0, value: 0, interpolation: 'linear' } }] });
    await new Promise((r) => setTimeout(r, 200));

    for (const e of events) {
      if (e.type !== 'sequence') continue;
      expect(e.revision, 'revisions never go backwards').toBeGreaterThan(rev);
      rev = e.revision;
      mirror = e.kind === 'load' ? e.sequence! : applyPatches(mirror, e.patches as Patch[]);
    }
    expect(rev).toBe(ctx.b.manager.revision);
    expect(mirror).toEqual(seqOf(ctx.b));
    expect(events.some((e) => e.type === 'history')).toBe(true);
    expect(events.filter((e) => e.type === 'sequence').map((e) => (e as { kind: string }).kind)).toEqual(['commit', 'commit', 'undo', 'redo', 'commit']);
  });
});

describe('guards between media, settings and the timeline', () => {
  it('refuses to remove media that clips use, allows it once they are gone', async () => {
    const ctx = await setup();
    await insertAV(ctx, 0, 3);
    const res = await ctx.b.app.inject({ method: 'DELETE', url: `/api/media/${ctx.mediaId}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'media_in_use', details: { clips: 2 } });
    const ids = [...clips(seqOf(ctx.b), 'V1'), ...clips(seqOf(ctx.b), 'A1')].map((c) => c.id);
    await post(ctx.b, '/api/edit', { ops: [{ type: 'delete', itemIds: ids, linked: false }] });
    expect((await ctx.b.app.inject({ method: 'DELETE', url: `/api/media/${ctx.mediaId}` })).statusCode).toBe(200);
  });

  it('frame rate is locked once the timeline has clips; size changes are undoable edits', async () => {
    const ctx = await setup();
    await insertAV(ctx, 0, 3);
    const patch = (payload: object) => ctx.b.app.inject({ method: 'PATCH', url: '/api/project/settings', payload });
    const blocked = await patch({ fps: { num: 25, den: 1 } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('sequence_not_empty');
    expect((await patch({ width: 1080, height: 1920 })).statusCode).toBe(200);
    expect(seqOf(ctx.b)).toMatchObject({ width: 1080, height: 1920 });
    await post(ctx.b, '/api/history/undo');
    expect(seqOf(ctx.b)).toMatchObject({ width: 640, height: 360 });
  });

  it('on an empty timeline a frame-rate change rebuilds the sequence on the new timebase', async () => {
    const ctx = await setup();
    const res = await ctx.b.app.inject({ method: 'PATCH', url: '/api/project/settings', payload: { fps: { num: 30000, den: 1001 } } });
    expect(res.statusCode).toBe(200);
    expect(seqOf(ctx.b).timebase).toMatchObject({ rate: 240000, fps: { num: 30000, den: 1001 } });
    expect(ctx.b.manager.current!.sequences[0]!.timebase.rate).toBe(240000);
  });

  it('the first video added to an empty project defines the sequence', async () => {
    const b = await buildApp(loadConfig({ dataDir: await tmp('data') }), { saveDelayMs: 30 });
    cleanup.push(() => b.app.close());
    const dir = await tmp('empty');
    await post(b, '/api/project/open', { path: dir });
    expect(seqOf(b).timebase.fps).toEqual({ num: 30000, den: 1001 }); // default until footage arrives
    const up = await b.app.inject({ method: 'PUT', url: '/api/project/upload?path=clip.mp4', headers: { 'content-type': 'video/mp4' }, payload: await fs.readFile(fx.sync) });
    expect(up.statusCode).toBe(201);
    expect(seqOf(b)).toMatchObject({ width: 640, height: 360, timebase: { fps: { num: 30, den: 1 }, rate: 48000 } });
  });

  it('edit endpoints need an open project', async () => {
    const b = await buildApp(loadConfig({ dataDir: await tmp('data') }));
    cleanup.push(() => b.app.close());
    expect((await post(b, '/api/edit', { ops: [{ type: 'addMarker', time: 0, label: 'x' }] })).statusCode).toBe(409);
    expect((await b.app.inject('/api/sequence')).statusCode).toBe(409);
  });
});
