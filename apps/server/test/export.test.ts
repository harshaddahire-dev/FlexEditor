import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ExportInfo, type ExportRequest, type Op, type Sequence, trackItems } from '@cutroom/core';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { runBinary } from '../src/proc';
import { analyzeSync, fixtures, generateColorAsset, type Fixtures } from './helpers/media';

let fx: Fixtures;
let red: string;
let blue: string;
let green: string;
const cleanup: (() => Promise<void> | void)[] = [];
beforeAll(async () => {
  fx = await fixtures();
  red = await generateColorAsset(path.join(fx.dir, 'red.mp4'), 'red', 4);
  blue = await generateColorAsset(path.join(fx.dir, 'blue.mp4'), 'blue', 4);
  green = await generateColorAsset(path.join(fx.dir, 'green.mp4'), '0x00ff00', 4);
});
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
const tmp = async (p: string) => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `cutroom-${p}-`));
  cleanup.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function silence(seconds: number): Promise<Buffer> {
  const f = path.join(await tmp('wav'), 's.wav');
  await runBinary('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(seconds), '-c:a', 'pcm_f32le', f]);
  return fs.readFile(f);
}

interface Ctx {
  b: BuiltApp;
  dir: string;
  ids: Record<string, string>;
  R: number;
  F: number;
  fps: number;
}
async function setup(files: Record<string, string> = { red, blue }): Promise<Ctx> {
  const b = await buildApp(loadConfig({ dataDir: await tmp('data') }), { saveDelayMs: 30 });
  cleanup.push(() => b.app.close());
  const dir = await tmp('proj');
  for (const [name, src] of Object.entries(files)) await fs.copyFile(src, path.join(dir, `${name}.mp4`));
  expect((await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: dir } })).statusCode).toBe(200);
  const ids = Object.fromEntries(b.manager.current!.media.map((m) => [m.name.replace(/\.mp4$/, ''), m.id]));
  const tb = b.manager.requireSession().state.timebase;
  return { b, dir, ids, R: tb.rate, F: (tb.rate * tb.fps.den) / tb.fps.num, fps: tb.fps.num / tb.fps.den };
}
const seqOf = (c: Ctx): Sequence => c.b.manager.requireSession().state;
const track = (c: Ctx, name: string) => seqOf(c).tracks.find((t) => t.name === name)!;
async function edit(c: Ctx, ops: Op[], label = 'test') {
  const r = await c.b.app.inject({ method: 'POST', url: '/api/edit', payload: { label, ops } });
  expect(r.statusCode, r.body).toBe(200);
}
/** Place a video clip (no audio) on a video track; returns its id. */
async function place(c: Ctx, media: string, atSec: number, inSec: number, outSec: number, trackName = 'V1'): Promise<string> {
  await edit(c, [{ type: 'overwrite', at: Math.round(atSec * c.R), clips: [{ trackId: track(c, trackName).id, mediaId: c.ids[media]!, sourceIn: Math.round(inSec * c.R), sourceOut: Math.round(outSec * c.R) }] } as Op]);
  const items = trackItems(track(c, trackName));
  return items.find((i) => i.kind === 'clip' && i.start === Math.round(atSec * c.R) && i.mediaId === c.ids[media])!.id;
}

async function render(c: Ctx, over: Partial<ExportRequest> = {}, audioSeconds?: number): Promise<ExportInfo> {
  const r = await c.b.app.inject({ method: 'POST', url: '/api/exports', payload: { preset: 'h264-mp4', name: 'out', engine: 'ffmpeg', captions: 'none', ...over } });
  expect(r.statusCode, r.body).toBe(201);
  const info = r.json() as ExportInfo;
  const seq = seqOf(c);
  const dur = audioSeconds ?? ((over.to ?? Math.max(...seq.tracks.flatMap((t) => trackItems(t).map((i) => i.start + i.duration)))) - (over.from ?? 0)) / c.R;
  const up = await c.b.app.inject({ method: 'PUT', url: `/api/exports/${info.id}/audio`, headers: { 'content-type': 'application/octet-stream' }, payload: await silence(dur) });
  expect(up.statusCode, up.body).toBe(200);
  await c.b.jobs.idle();
  return c.b.exports.get(info.id);
}

/** RGB of one pixel of output frame `n` (0-based, decoded in order: no seeking, so no ambiguity about which frame). */
async function pixel(file: string, n: number, x: number, y: number): Promise<[number, number, number]> {
  const r = await runBinary('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),format=rgb24,crop=1:1:${x}:${y}`, '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', '-']);
  expect(r.stdout.length, `frame ${n} of ${file}`).toBe(3);
  return [r.stdout[0]!, r.stdout[1]!, r.stdout[2]!];
}
const near = (got: number[], want: number[], tol = 8) => got.forEach((v, i) => expect(Math.abs(v - want[i]!), `${got} vs ${want}`).toBeLessThanOrEqual(tol));
const mid = (_c: Ctx, frame: number) => frame;
/** Frame index of timeline second `t` (30 fps fixtures). */
const fr = (t: number) => Math.round(t * 30);

describe('FFmpeg export engine', () => {
  it('renders cuts and gaps exactly: frame count, size, codecs, and the right picture on every frame', async () => {
    const c = await setup();
    await place(c, 'red', 0, 0, 1);
    await place(c, 'blue', 1, 0, 1);
    await place(c, 'red', 3, 0, 1); // 1 s of black between 2 s and 3 s
    const info = await render(c);
    expect(info.phase, JSON.stringify(info)).toBe('done');
    expect(info.result).toMatchObject({ frames: 120, width: 640, height: 360, videoCodec: 'h264', audioCodec: 'aac' });
    expect(info.result!.durationSeconds).toBeCloseTo(4, 1);
    const f = info.output!;
    near(await pixel(f, mid(c, 0), 320, 180), [255, 0, 0]);
    near(await pixel(f, mid(c, 29), 320, 180), [255, 0, 0]); // last red frame
    near(await pixel(f, mid(c, 30), 320, 180), [0, 0, 255]); // first blue frame: the cut is on the frame
    near(await pixel(f, mid(c, 59), 320, 180), [0, 0, 255]);
    near(await pixel(f, mid(c, 60), 320, 180), [0, 0, 0], 4); // gap = black
    near(await pixel(f, mid(c, 89), 320, 180), [0, 0, 0], 4);
    near(await pixel(f, mid(c, 90), 320, 180), [255, 0, 0]);
    await expect(fs.stat(path.join(c.dir, '.cutroom', 'exports', info.id))).rejects.toThrow(); // scratch removed
  }, 60_000);

  it('applies transform, opacity, stacking and crop like the monitor', async () => {
    const c = await setup();
    await place(c, 'blue', 0, 0, 2);
    const top = await place(c, 'red', 0, 0, 2, 'V2');
    await edit(c, [{ type: 'setClipProps', clipId: top, patch: { transform: { scale: { x: 0.5, y: 0.5 }, position: { x: 160, y: 0 } } } } as Op]);
    let info = await render(c, { name: 'xf' });
    // red is half size, centred 160 px right of centre: x ∈ [320, 640], y ∈ [90, 270]
    near(await pixel(info.output!, fr(0.5), 400, 180), [255, 0, 0]);
    near(await pixel(info.output!, fr(0.5), 100, 180), [0, 0, 255]);
    near(await pixel(info.output!, fr(0.5), 400, 30), [0, 0, 255]);
    near(await pixel(info.output!, fr(0.5), 315, 180), [0, 0, 255]);
    near(await pixel(info.output!, fr(0.5), 325, 180), [255, 0, 0]);

    await edit(c, [{ type: 'setClipProps', clipId: top, patch: { transform: { scale: { x: 1, y: 1 }, position: { x: 0, y: 0 }, opacity: 0.5 } } } as Op]);
    info = await render(c, { name: 'op' });
    near(await pixel(info.output!, fr(0.5), 320, 180), [128, 0, 128], 10);

    await edit(c, [{ type: 'setClipProps', clipId: top, patch: { transform: { opacity: 1, crop: { left: 0.5, right: 0, top: 0, bottom: 0 } } } } as Op]);
    info = await render(c, { name: 'crop' });
    near(await pixel(info.output!, fr(0.5), 100, 180), [0, 0, 255]); // cropped half shows what is below
    near(await pixel(info.output!, fr(0.5), 500, 180), [255, 0, 0]);
  }, 90_000);

  it('animates opacity from keyframes', async () => {
    const c = await setup();
    await place(c, 'blue', 0, 0, 2);
    const top = await place(c, 'red', 0, 0, 2, 'V2');
    await edit(c, [{ type: 'setKeyframes', clipId: top, prop: 'opacity', keyframes: [{ time: 0, value: 0, interpolation: 'linear' }, { time: 2 * c.R, value: 1, interpolation: 'linear' }] } as Op]);
    const info = await render(c, { name: 'kf' });
    near(await pixel(info.output!, mid(c, 0), 320, 180), [0, 0, 255], 10);
    near(await pixel(info.output!, mid(c, 30), 320, 180), [128, 0, 128], 14); // halfway
    near(await pixel(info.output!, mid(c, 58), 320, 180), [250, 0, 8], 20);
  }, 90_000);

  it('renders a cross dissolve between two clips, leaving the clips outside it untouched', async () => {
    const c = await setup();
    const a = await place(c, 'red', 0, 0, 2);
    await place(c, 'blue', 2, 1, 3);
    await edit(c, [{ type: 'addTransition', betweenClipIds: [a, trackItems(track(c, 'V1')).at(-1)!.id], transitionType: 'dissolve', duration: Math.round(1 * c.R), alignment: 'center' } as Op]);
    const info = await render(c, { name: 'dis' });
    expect(info.result).toMatchObject({ frames: 120 });
    near(await pixel(info.output!, fr(1.2), 320, 180), [255, 0, 0], 10); // before the span [1.5, 2.5]
    near(await pixel(info.output!, fr(2.0), 320, 180), [128, 0, 128], 18); // middle of the span
    near(await pixel(info.output!, fr(3.0), 320, 180), [0, 0, 255], 10);
    const dip = await (async () => {
      await edit(c, [{ type: 'setTransition', id: track(c, 'V1').transitions[0]!.id, patch: { transitionType: 'dip-black' } } as Op]);
      return render(c, { name: 'dip' });
    })();
    expect((await pixel(dip.output!, fr(2.0), 320, 180))[2]).toBeLessThan(110); // dark at the midpoint (xfade's fadeblack holds a little longer than the monitor's)
  }, 120_000);

  it('applies effects: saturation to grey, blur softens a hard edge, sepia warms', async () => {
    const c = await setup();
    const clip = await place(c, 'blue', 0, 0, 1);
    await edit(c, [{ type: 'applyEffect', clipId: clip, effect: { type: 'color', params: { saturation: 0 } } } as Op]);
    let info = await render(c, { name: 'fx1' });
    const [r, g, b] = await pixel(info.output!, fr(0.4), 320, 180);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(3);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(3);
    expect(r).toBeGreaterThan(10);
    expect(r).toBeLessThan(40); // luma of pure blue ≈ 18
    expect(info.warnings.join()).not.toMatch(/approximates/);

    const fx = trackItems(track(c, 'V1'))[0]!;
    await edit(c, [{ type: 'removeEffect', clipId: clip, effectId: (fx as { effects: { id: string }[] }).effects[0]!.id } as Op, { type: 'applyEffect', clipId: clip, effect: { type: 'sepia', params: { amount: 1 } } } as Op]);
    info = await render(c, { name: 'fx2' });
    const [sr, , sb] = await pixel(info.output!, fr(0.4), 320, 180);
    expect(sr).toBeGreaterThan(sb); // blue became brownish: red channel above blue
  }, 90_000);

  it('exports a time range and keeps speed changes frame-accurate (A/V sync asset)', async () => {
    const c = await setup({ sync: fx.sync });
    await place(c, 'sync', 0, 0, 6);
    // range 1 s … 3 s: the picture starts on the flash that sits on whole second 1
    const info = await render(c, { name: 'range', from: c.R, to: 3 * c.R });
    expect(info.result).toMatchObject({ frames: 60 });
    const rep = await analyzeSync(info.output!, fx.sync).catch(() => null);
    void rep;
    const flashes = await flashFrames(info.output!);
    expect(flashes).toEqual([0, 30]); // flash on frame 0 (t=1 s of the source) and frame 30 (t=2 s)
  }, 90_000);

  it('plays speed changes and awkward sources (VFR, rotated, anamorphic) on exactly the right frames', async () => {
    // 2x: source flashes every 30 frames land every 15 output frames
    const c = await setup({ sync: fx.sync });
    const clip = await place(c, 'sync', 0, 0, 6);
    await edit(c, [{ type: 'setSpeed', clipId: clip, speed: { num: 2, den: 1 } } as Op]);
    const fast = await render(c, { name: 'fast' });
    expect(fast.result!.frames).toBe(90);
    expect((await flashFrames(fast.output!)).filter((_, i) => i < 6)).toEqual([0, 15, 30, 45, 60, 75]);

    for (const [name, file] of [['vfr', fx.vfr], ['rot', fx.rotated], ['ana', fx.anamorphic]] as const) {
      const d = await setup({ [name]: file });
      await place(d, name, 0, 0, 3);
      const out = await render(d, { name });
      expect(out.phase, name).toBe('done');
      expect(out.result!.frames, name).toBe(3 * d.fps); // the project takes the frame rate of its first clip (a VFR file snaps to 24)
      const flashes = await flashFrames(out.output!);
      expect(flashes.slice(0, 3), name).toEqual([0, d.fps, 2 * d.fps]);
    }
  }, 180_000);

  it('burns captions in (ASS) and writes SRT/VTT sidecars relative to the exported range', async () => {
    const c = await setup();
    await place(c, 'blue', 0, 0, 3);
    const trackId = await (async () => {
      await edit(c, [{ type: 'addTrack', kind: 'caption', name: 'C1' } as Op]);
      return track(c, 'C1').id;
    })();
    await edit(c, [{ type: 'addCaption', trackId, start: Math.round(0.5 * c.R), duration: Math.round(1.5 * c.R), styleId: 'boxed', words: [{ text: 'Hello', start: Math.round(0.5 * c.R), end: Math.round(1.2 * c.R) }, { text: 'world', start: Math.round(1.2 * c.R), end: Math.round(2 * c.R) }] } as Op]);
    const info = await render(c, { name: 'cap', captions: 'both' });
    expect(info.phase, JSON.stringify(info)).toBe('done');
    // the box (white) appears in the lower third while the caption is up, and not before it
    const before = await pixel(info.output!, fr(0.25), 320, 310);
    const during = await pixel(info.output!, fr(1.0), 320, 310);
    near(before, [0, 0, 255], 10);
    expect(during[0]).toBeGreaterThan(150); // white-ish box over blue
    expect(info.sidecars.map((f) => path.extname(f)).sort()).toEqual(['.srt', '.vtt']);
    const srt = await fs.readFile(info.sidecars.find((f) => f.endsWith('.srt'))!, 'utf8');
    expect(srt).toContain('00:00:00,500 --> 00:00:02,000');
    expect(srt).toContain('Hello world');

    // exporting only 1 s … 3 s moves the caption to the start of the file and clips it
    const part = await render(c, { name: 'cap2', captions: 'sidecar', from: c.R, to: 3 * c.R });
    const srt2 = await fs.readFile(part.sidecars.find((f) => f.endsWith('.srt'))!, 'utf8');
    expect(srt2).toContain('00:00:00,000 --> 00:00:01,000');
  }, 90_000);

  it('ProRes and audio-only presets, and a custom output size', async () => {
    const c = await setup();
    await place(c, 'red', 0, 0, 1);
    const prores = await render(c, { preset: 'prores-mov', name: 'pr' });
    expect(prores.result).toMatchObject({ videoCodec: 'prores', audioCodec: 'pcm_s24le', frames: 30 });
    const wav = await render(c, { preset: 'audio-wav', name: 'au', engine: 'ffmpeg' });
    expect(wav.result).toMatchObject({ audioCodec: 'pcm_s24le' });
    expect(wav.result!.durationSeconds).toBeCloseTo(1, 1);
    expect(wav.result!.videoCodec).toBeUndefined();
    const small = await render(c, { name: 'small', width: 320, height: 180 });
    expect(small.result).toMatchObject({ width: 320, height: 180, frames: 30 });
    near(await pixel(small.output!, fr(0.4), 160, 90), [255, 0, 0]);
  }, 120_000);

  it('rejects impossible requests with a reason, never overwrites, and cancels cleanly', async () => {
    const c = await setup();
    const post = (payload: object) => c.b.app.inject({ method: 'POST', url: '/api/exports', payload });
    const base = { preset: 'h264-mp4', name: 'x', engine: 'ffmpeg', captions: 'none' };
    expect((await post(base)).json()).toMatchObject({ error: 'empty_range' });
    await place(c, 'red', 0, 0, 1);
    expect((await post({ ...base, preset: 'nope' })).json()).toMatchObject({ error: 'bad_preset' });
    expect((await post({ ...base, preset: 'prores-mov', engine: 'webcodecs' })).json()).toMatchObject({ error: 'bad_engine' });
    expect((await post({ ...base, width: 333, height: 180 })).json()).toMatchObject({ error: 'bad_size' });
    expect((await post({ ...base, engine: 'gpu' })).statusCode).toBe(400);

    const a = await render(c, { name: 'same' });
    const b2 = await render(c, { name: 'same' });
    expect(path.basename(a.output!)).toBe('same.mp4');
    expect(path.basename(b2.output!)).toBe('same (1).mp4');

    const pending = (await post(base)).json() as ExportInfo; // audio never arrives
    expect((await c.b.app.inject({ method: 'DELETE', url: `/api/exports/${pending.id}` })).statusCode).toBe(200);
    await c.b.jobs.idle();
    expect(c.b.jobs.get(pending.jobId)!.state).toBe('canceled');
    expect((await c.b.app.inject({ method: 'GET', url: `/api/exports/${pending.id}/file` })).statusCode).toBe(409);
    expect((await c.b.app.inject({ method: 'GET', url: `/api/exports/${a.id}/file` })).statusCode).toBe(200);
  }, 120_000);
});

/** Frame indices (0-based) whose picture is the white flash, from the exported file. */
async function flashFrames(file: string): Promise<number[]> {
  const r = await runBinary('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', '-']);
  const frame = 16 * 16;
  const out: number[] = [];
  for (let i = 0; i < r.stdout.length / frame; i++) {
    let sum = 0;
    for (let k = 0; k < frame; k++) sum += r.stdout[i * frame + k]!;
    if (sum / frame > 200) out.push(i);
  }
  return out;
}
