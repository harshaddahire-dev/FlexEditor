import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FfmpegStatus, Media, ProjectResponse, ScanReport, ServerEvent } from '@cutroom/core';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { generateSyncAsset, fixtures, type Fixtures } from './helpers/media';

let fx: Fixtures;
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  fx = await fixtures();
});
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `cutroom-${prefix}-`));
  cleanup.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

async function makeApp(opts: Parameters<typeof buildApp>[1] = {}): Promise<BuiltApp & { dataDir: string }> {
  const dataDir = await tmp('data');
  const built = await buildApp(loadConfig({ dataDir }), { saveDelayMs: 50, ...opts });
  cleanup.push(() => built.app.close());
  return { ...built, dataDir };
}

/** A project folder with nested media, a text file, a corrupt "video" and ignored directories. */
async function makeFolder(): Promise<string> {
  const dir = await tmp('proj');
  await fs.mkdir(path.join(dir, 'a'), { recursive: true });
  await fs.mkdir(path.join(dir, 'b', 'c'), { recursive: true });
  await fs.mkdir(path.join(dir, '.hidden'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await fs.copyFile(fx.sync, path.join(dir, 'a', 'clip.mp4'));
  await fs.copyFile(fx.tone, path.join(dir, 'b', 'c', 'tone.wav'));
  await fs.copyFile(fx.still, path.join(dir, 'still.png'));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'hello');
  await fs.writeFile(path.join(dir, 'corrupt.mp4'), 'this is not a video');
  await fs.copyFile(fx.sync, path.join(dir, '.hidden', 'skip.mp4'));
  await fs.copyFile(fx.sync, path.join(dir, 'node_modules', 'x', 'skip.mp4'));
  return dir;
}

async function openProject(b: BuiltApp, dir: string) {
  const scans: ScanReport[] = [];
  b.manager.on('scan', (r) => scans.push(r));
  const res = await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: dir } });
  return { res, scans, body: res.json() as ProjectResponse };
}

const byName = (media: Media[], name: string) => media.find((m) => m.name === name)!;

describe('open folder → import', () => {
  it('scans recursively, imports supported media, rejects junk, creates .cutroom', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    const { res, scans, body } = await openProject(b, dir);
    expect(res.statusCode).toBe(200);

    expect(body.project.media.map((m) => m.name).sort()).toEqual(['clip.mp4', 'still.png', 'tone.wav']);
    expect(scans[0]).toMatchObject({ imported: 3, unchanged: 0, missing: 0 });
    expect(scans[0]!.rejected).toEqual([{ path: 'corrupt.mp4', reason: expect.stringMatching(/ffprobe failed/) }]);

    for (const sub of ['project.json', 'proxies', 'cache', 'history', 'index.sqlite']) {
      await expect(fs.stat(path.join(dir, '.cutroom', sub))).resolves.toBeTruthy();
    }
    const clip = byName(body.project.media, 'clip.mp4');
    expect(clip.path).toBe('a/clip.mp4'); // project-relative, POSIX
    expect(clip.id).toMatch(/^m_[0-9a-f]{12}$/);
  });

  it('first video fixes the project settings from the footage', async () => {
    const b = await makeApp();
    const { body } = await openProject(b, await makeFolder());
    expect(body.summary.settings).toMatchObject({ width: 640, height: 360, fps: { num: 30, den: 1 }, sampleRate: 48000, auto: false });
  });

  it('background jobs generate posters and proxies (audio/images skip the proxy)', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    const { body } = await openProject(b, dir);
    await b.jobs.idle();
    const media = b.manager.current!.media;
    const clip = byName(media, 'clip.mp4');
    expect(clip.status).toMatchObject({ probe: 'done', poster: 'done', proxy: 'done' });
    expect(clip.proxyPath).toBe(`.cutroom/proxies/${clip.id}.mp4`);
    expect(clip.proxy).toMatchObject({ width: 640, height: 360, fps: { num: 30, den: 1 } });
    const tone = byName(media, 'tone.wav');
    expect(tone.status).toMatchObject({ poster: 'skipped', proxy: 'skipped' });
    const still = byName(media, 'still.png');
    expect(still.status).toMatchObject({ poster: 'done', proxy: 'skipped' });
    await expect(fs.stat(path.join(dir, clip.proxyPath!))).resolves.toBeTruthy();
    expect(body.project.media).toHaveLength(3);
  });

  it('serves proxy / poster / original with HTTP Range support', async () => {
    const b = await makeApp();
    await openProject(b, await makeFolder());
    await b.jobs.idle();
    const clip = byName(b.manager.current!.media, 'clip.mp4');
    const url = `/api/media/${clip.id}/file`;

    const full = await b.app.inject(`${url}/proxy`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('video/mp4');
    const size = Number(full.headers['content-length']);
    expect(full.rawPayload.length).toBe(size);

    const part = await b.app.inject({ url: `${url}/proxy`, headers: { range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${size}`);
    expect(Buffer.compare(part.rawPayload, full.rawPayload.subarray(100, 200))).toBe(0);

    const tail = await b.app.inject({ url: `${url}/proxy`, headers: { range: 'bytes=-50' } });
    expect(tail.statusCode).toBe(206);
    expect(Buffer.compare(tail.rawPayload, full.rawPayload.subarray(size - 50))).toBe(0);

    const bad = await b.app.inject({ url: `${url}/proxy`, headers: { range: `bytes=${size + 10}-` } });
    expect(bad.statusCode).toBe(416);

    const poster = await b.app.inject(`${url}/poster`);
    expect(poster.headers['content-type']).toBe('image/jpeg');
    expect(poster.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect((await b.app.inject(`${url}/original`)).statusCode).toBe(200);
    expect((await b.app.inject(`${url}/nope`)).statusCode).toBe(400);
    expect((await b.app.inject('/api/media/unknown/file/proxy')).statusCode).toBe(404);
  });
});

describe('persistence', () => {
  it('re-opening restores everything without redoing work', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    const first = await openProject(b, dir);
    await b.jobs.idle();
    await b.manager.flush();
    const before = structuredClone(b.manager.current!);
    await b.app.inject({ method: 'POST', url: '/api/project/close' });
    expect(b.manager.current).toBeNull();

    const jobsBefore = b.jobs.list().length;
    const second = await openProject(b, dir);
    expect(second.body.project.id).toBe(first.body.project.id);
    expect(second.scans[0]).toMatchObject({ imported: 0, unchanged: 3 });
    expect(b.jobs.list().length).toBe(jobsBefore); // no new poster/proxy jobs
    expect(second.body.project.media).toEqual(before.media);
    expect(second.body.project.settings).toEqual(before.settings);
  });

  it('tracks recent projects', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    await openProject(b, dir);
    const recent = (await b.app.inject('/api/recent')).json() as { path: string; name: string }[];
    expect(recent[0]).toMatchObject({ path: dir });
  });

  it('refuses a corrupt project.json without touching it', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    await fs.mkdir(path.join(dir, '.cutroom'), { recursive: true });
    await fs.writeFile(path.join(dir, '.cutroom', 'project.json'), '{ broken');
    const { res } = await openProject(b, dir);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('corrupt_project');
    expect(await fs.readFile(path.join(dir, '.cutroom', 'project.json'), 'utf8')).toBe('{ broken');
  });

  it('regenerates a deleted proxy on re-open', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    await openProject(b, dir);
    await b.jobs.idle();
    const clip = byName(b.manager.current!.media, 'clip.mp4');
    await b.manager.flush();
    await b.app.inject({ method: 'POST', url: '/api/project/close' });
    await fs.rm(path.join(dir, clip.proxyPath!));
    await openProject(b, dir);
    await b.jobs.idle();
    await expect(fs.stat(path.join(dir, clip.proxyPath!))).resolves.toBeTruthy();
    expect(byName(b.manager.current!.media, 'clip.mp4').status.proxy).toBe('done');
  });
});

describe('rescan, missing media and relink', () => {
  it('detects added, changed, moved and missing files', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    await openProject(b, dir);
    await b.jobs.idle();
    const original = byName(b.manager.current!.media, 'clip.mp4');

    // added
    await fs.copyFile(fx.tone, path.join(dir, 'new-tone.wav'));
    // moved: same bytes, new location → relinked by content fingerprint, id preserved
    await fs.mkdir(path.join(dir, 'moved'));
    await fs.rename(path.join(dir, 'a', 'clip.mp4'), path.join(dir, 'moved', 'clip.mp4'));
    // missing
    await fs.rm(path.join(dir, 'still.png'));

    const res = await b.app.inject({ method: 'POST', url: '/api/project/rescan' });
    const report = res.json() as ScanReport;
    expect(report).toMatchObject({ imported: 1, relinked: 1, missing: 1, changed: 0 });

    const media = b.manager.current!.media;
    const moved = media.find((m) => m.id === original.id)!;
    expect(moved.path).toBe('moved/clip.mp4');
    expect(moved.missing).toBe(false);
    expect(moved.status.proxy).toBe('done'); // proxy kept, not regenerated
    expect(byName(media, 'still.png').missing).toBe(true);
    expect(byName(media, 'new-tone.wav').type).toBe('audio');

    // overwrite in place → 'changed'
    await generateSyncAsset(path.join(dir, 'moved', 'clip.mp4'), { seconds: 2 });
    const again = (await b.app.inject({ method: 'POST', url: '/api/project/rescan' })).json() as ScanReport;
    expect(again.changed).toBe(1);
    await b.jobs.idle();
    const changed = b.manager.current!.media.find((m) => m.id === original.id)!;
    expect(Number(changed.duration.num) / Number(changed.duration.den)).toBeCloseTo(2, 1);
    expect(changed.status.proxy).toBe('done');
  });

  it('relinks a missing file, refusing mismatches unless forced', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    await openProject(b, dir);
    await b.jobs.idle();
    const clip = byName(b.manager.current!.media, 'clip.mp4');
    await fs.rm(path.join(dir, 'a', 'clip.mp4'));
    await b.app.inject({ method: 'POST', url: '/api/project/rescan' });
    expect(b.manager.findMedia(clip.id)!.missing).toBe(true);
    expect(((await b.app.inject(`/api/media/${clip.id}/file/original`)).statusCode)).toBe(404);

    // a different-length file is flagged
    const shorter = path.join(dir, 'elsewhere', 'short.mp4');
    await generateSyncAsset(shorter, { seconds: 2 });
    const refused = await b.app.inject({ method: 'POST', url: `/api/media/${clip.id}/relink`, payload: { path: shorter } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'relink_mismatch', message: expect.stringMatching(/Duration differs/) });

    // the right file (same bytes, new name) relinks cleanly and suggestions find same-named files
    const right = path.join(dir, 'elsewhere', 'clip.mp4');
    await fs.copyFile(fx.sync, right);
    const candidates = (await b.app.inject(`/api/media/${clip.id}/relink-candidates`)).json() as string[];
    expect(candidates).toEqual(['elsewhere/clip.mp4']);
    const ok = await b.app.inject({ method: 'POST', url: `/api/media/${clip.id}/relink`, payload: { path: right } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: clip.id, path: 'elsewhere/clip.mp4', missing: false });
  });

  it('removes media and its derived files; reproxy regenerates', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    await openProject(b, dir);
    await b.jobs.idle();
    const clip = byName(b.manager.current!.media, 'clip.mp4');

    const re = await b.app.inject({ method: 'POST', url: `/api/media/${clip.id}/reproxy` });
    expect(re.statusCode).toBe(200);
    expect(['queued', 'running']).toContain(re.json().status.proxy); // never 'done' or stale
    await b.jobs.idle();
    expect(b.manager.findMedia(clip.id)!.status.proxy).toBe('done');

    expect((await b.app.inject({ method: 'DELETE', url: `/api/media/${clip.id}` })).statusCode).toBe(200);
    expect(b.manager.findMedia(clip.id)).toBeUndefined();
    await expect(fs.stat(path.join(dir, '.cutroom', 'proxies', `${clip.id}.mp4`))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'a', 'clip.mp4'))).resolves.toBeTruthy(); // original untouched
    expect((await b.app.inject({ method: 'DELETE', url: `/api/media/${clip.id}` })).statusCode).toBe(404);
  });

  it('a removed file stays removed across rescans and re-opens until explicitly re-included', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    await openProject(b, dir);
    await b.jobs.idle();
    const clip = byName(b.manager.current!.media, 'clip.mp4');
    await b.app.inject({ method: 'DELETE', url: `/api/media/${clip.id}` });
    expect(b.manager.summary()!.ignoredCount).toBe(1);

    const rescan = (await b.app.inject({ method: 'POST', url: '/api/project/rescan' })).json() as ScanReport;
    expect(rescan.imported).toBe(0);
    expect(b.manager.current!.media.map((m) => m.name)).not.toContain('clip.mp4');

    await b.manager.flush();
    await b.app.inject({ method: 'POST', url: '/api/project/close' });
    await openProject(b, dir);
    expect(b.manager.current!.media.map((m) => m.name)).not.toContain('clip.mp4');

    const again = (await b.app.inject({ method: 'POST', url: '/api/project/rescan', payload: { includeIgnored: true } })).json() as ScanReport;
    expect(again.imported).toBe(1);
    expect(b.manager.summary()!.ignoredCount).toBe(0);
    expect(b.manager.current!.media.map((m) => m.name)).toContain('clip.mp4');
  });

  it('explicitly importing a removed file by path brings it back', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    await openProject(b, dir);
    const clip = byName(b.manager.current!.media, 'clip.mp4');
    await b.app.inject({ method: 'DELETE', url: `/api/media/${clip.id}` });
    const res = await b.app.inject({ method: 'POST', url: '/api/media/import', payload: { path: path.join(dir, 'a', 'clip.mp4') } });
    expect(res.statusCode).toBe(200);
    expect(b.manager.summary()!.ignoredCount).toBe(0);
  });
});

describe('upload', () => {
  it('streams a file into <project>/uploads and imports it', async () => {
    const b = await makeApp();
    const dir = await tmp('empty');
    await openProject(b, dir);
    const bytes = await fs.readFile(fx.sync);
    const res = await b.app.inject({
      method: 'PUT',
      url: `/api/project/upload?path=${encodeURIComponent('day 1/take 1.mp4')}`,
      headers: { 'content-type': 'video/mp4' },
      payload: bytes,
    });
    expect(res.statusCode).toBe(201);
    const media = res.json() as Media;
    expect(media).toMatchObject({ name: 'take 1.mp4', path: 'uploads/day 1/take 1.mp4', type: 'video' });
    expect(Buffer.compare(await fs.readFile(path.join(dir, 'uploads', 'day 1', 'take 1.mp4')), bytes)).toBe(0);
    await b.jobs.idle();
    expect(b.manager.findMedia(media.id)!.status.proxy).toBe('done');
    // the first video defines the project settings
    expect(b.manager.current!.settings).toMatchObject({ width: 640, height: 360 });
  });

  it('never overwrites: duplicates get a numeric suffix', async () => {
    const b = await makeApp();
    const dir = await tmp('empty');
    await openProject(b, dir);
    const bytes = await fs.readFile(fx.tone);
    const put = () => b.app.inject({ method: 'PUT', url: '/api/project/upload?path=tone.wav', headers: { 'content-type': 'audio/wav' }, payload: bytes });
    const one = (await put()).json() as Media;
    const two = (await put()).json() as Media;
    expect(one.path).toBe('uploads/tone.wav');
    expect(two.path).toBe('uploads/tone (1).wav');
    expect(one.id).not.toBe(two.id); // identical bytes, distinct files → distinct ids
  });

  it('rejects traversal, unsupported types and non-media bytes (and cleans up)', async () => {
    const b = await makeApp();
    const dir = await tmp('empty');
    await openProject(b, dir);
    const put = (p: string, payload: Buffer | string) =>
      b.app.inject({ method: 'PUT', url: `/api/project/upload?path=${encodeURIComponent(p)}`, headers: { 'content-type': 'application/octet-stream' }, payload });
    expect((await put('../evil.mp4', 'x')).statusCode).toBe(400);
    expect((await put('a/../../evil.mp4', 'x')).statusCode).toBe(400);
    expect((await put('/abs/evil.mp4', 'x')).statusCode).toBe(400);
    expect((await put('notes.txt', 'x')).statusCode).toBe(400);
    const junk = await put('fake.mp4', 'not really a video');
    expect(junk.statusCode).toBe(422);
    await expect(fs.stat(path.join(dir, 'uploads', 'fake.mp4'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, '..', 'evil.mp4'))).rejects.toThrow();
    expect(b.manager.current!.media).toHaveLength(0);
  });

  it('needs an open project', async () => {
    const b = await makeApp();
    const res = await b.app.inject({ method: 'PUT', url: '/api/project/upload?path=a.mp4', headers: { 'content-type': 'video/mp4' }, payload: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_project');
  });
});

describe('guards', () => {
  it('blocks foreign hosts (DNS rebinding) and cross-site origins', async () => {
    const b = await makeApp();
    expect((await b.app.inject({ url: '/api/health', headers: { host: 'evil.example.com' } })).statusCode).toBe(403);
    expect((await b.app.inject({ url: '/api/health', headers: { host: 'localhost:3001', origin: 'https://evil.example.com' } })).statusCode).toBe(403);
    expect((await b.app.inject({ url: '/api/health', headers: { host: 'localhost:3001', origin: 'http://localhost:5173' } })).statusCode).toBe(200);
    const post = await b.app.inject({ method: 'POST', url: '/api/project/open', headers: { host: 'localhost:3001', origin: 'https://evil.example.com' }, payload: { path: '/' } });
    expect(post.statusCode).toBe(403);
  });

  it('reports missing ffmpeg and blocks import-style endpoints with a clear 503', async () => {
    const status: FfmpegStatus = { ok: false, ffmpeg: null, ffprobe: null, encoders: {}, filters: {}, problems: ['ffmpeg was not found.'], warnings: [], platform: 'linux', installHints: ['apt install ffmpeg'] };
    const b = await makeApp({ ffmpegStatus: status });
    const health = (await b.app.inject('/api/health')).json();
    expect(health.ffmpeg).toMatchObject({ ok: false, problems: ['ffmpeg was not found.'], installHints: ['apt install ffmpeg'] });
    const open = await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: await tmp('x') } });
    expect(open.statusCode).toBe(503);
    expect(open.json()).toMatchObject({ error: 'ffmpeg_missing' });
  });

  it('validates request bodies and reports unknown folders', async () => {
    const b = await makeApp();
    expect((await b.app.inject({ method: 'POST', url: '/api/project/open', payload: {} })).statusCode).toBe(400);
    const nf = await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: '/definitely/not/here' } });
    expect(nf.statusCode).toBe(404);
    expect((await b.app.inject('/api/project')).statusCode).toBe(409);
  });

  it('lists folders for the picker', async () => {
    const b = await makeApp();
    const dir = await makeFolder();
    const list = (await b.app.inject(`/api/fs/list?path=${encodeURIComponent(dir)}`)).json();
    expect(list.path).toBe(dir);
    expect(list.entries.map((e: { name: string }) => e.name)).toEqual(['a', 'b', 'node_modules']); // dot-folders hidden
    expect(list.mediaFiles).toBe(2); // still.png + corrupt.mp4 (extension-based)
    expect(list.parent).toBe(path.dirname(dir));
  });

  it('updates and validates project settings', async () => {
    const b = await makeApp();
    await openProject(b, await tmp('empty'));
    const ok = await b.app.inject({ method: 'PATCH', url: '/api/project/settings', payload: { width: 1080, height: 1920, fps: { num: 24000, den: 1001 } } });
    expect(ok.json()).toMatchObject({ width: 1080, height: 1920, fps: { num: 24000, den: 1001 }, auto: false });
    expect((await b.app.inject({ method: 'PATCH', url: '/api/project/settings', payload: { fps: { num: 0, den: 1 } } })).statusCode).toBe(400);
    expect((await b.app.inject({ method: 'PATCH', url: '/api/project/settings', payload: { width: 4 } })).statusCode).toBe(400);
  });
});

describe('websocket', () => {
  it('streams hello, project, media and job events', async () => {
    const b = await makeApp();
    await b.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (b.app.server.address() as { port: number }).port;
    const events: ServerEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'http://localhost:5173' } });
    cleanup.push(async () => ws.close());
    ws.on('message', (d) => events.push(JSON.parse(d.toString()) as ServerEvent));
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => setTimeout(r, 50));
    expect(events[0]).toMatchObject({ type: 'hello', project: null, jobs: [] });

    const dir = await tmp('ws');
    await fs.copyFile(fx.sync, path.join(dir, 'clip.mp4'));
    await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: dir } });
    await b.jobs.idle();
    await new Promise((r) => setTimeout(r, 100));

    const types = new Set(events.map((e) => e.type));
    expect(types).toEqual(new Set(['hello', 'project', 'media', 'job', 'scan']));
    const done = events.filter((e): e is Extract<ServerEvent, { type: 'job' }> => e.type === 'job' && e.job.state === 'done');
    expect(done.map((e) => e.job.kind).sort()).toEqual(['poster', 'proxy']);
    expect(events.some((e) => e.type === 'job' && e.job.kind === 'proxy' && e.job.state === 'running')).toBe(true);
    const lastMedia = [...events].reverse().find((e) => e.type === 'media') as Extract<ServerEvent, { type: 'media' }>;
    expect(lastMedia.media.status.proxy).toBe('done');
  });

  it('rejects cross-site websocket upgrades', async () => {
    const b = await makeApp();
    await b.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (b.app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'https://evil.example.com' } });
    const result = await new Promise<string>((resolve) => {
      ws.once('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    expect(result).toBe('http 403');
  });
});
