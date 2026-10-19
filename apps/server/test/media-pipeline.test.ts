import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rational, toNumber } from '@cutroom/core';
import { checkFfmpeg } from '../src/ffmpeg';
import { probeFile } from '../src/probe';
import { generatePoster, generateProxy, planProxy } from '../src/proxy';
import { runText } from '../src/proc';
import { analyzeSync, fixtures, type Fixtures } from './helpers/media';

let fx: Fixtures;
let work: string;
let status: Awaited<ReturnType<typeof checkFfmpeg>>;

beforeAll(async () => {
  fx = await fixtures();
  status = await checkFfmpeg();
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cutroom-pipeline-'));
});
afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

async function makeProxy(src: string, name: string) {
  const media = await probeFile(src);
  const plan = planProxy(media.video!, media.audioChannels, status);
  const out = path.join(work, `${name}.mp4`);
  const progress: number[] = [];
  await generateProxy(src, out, plan, !!media.audio, toNumber(media.duration), { ffmpegPath: 'ffmpeg', onProgress: (p) => progress.push(p) });
  return { media, plan, out, progress };
}

describe('ffmpeg environment', () => {
  it('is ready on this machine', () => {
    expect(status.ok, status.problems.join('; ')).toBe(true);
    expect(status.encoders.libx264).toBe(true);
  });

  it('reports a clear setup problem when binaries are missing', async () => {
    const s = await checkFfmpeg('/nonexistent/ffmpeg', '/nonexistent/ffprobe');
    expect(s.ok).toBe(false);
    expect(s.problems).toHaveLength(2);
    expect(s.installHints.length).toBeGreaterThan(0);
  });
});

describe('probing real files', () => {
  it('CFR sync asset', async () => {
    const m = await probeFile(fx.sync);
    expect(m.type).toBe('video');
    expect(m.fps).toEqual(rational(30));
    expect(m.video).toMatchObject({ width: 640, height: 360, rotation: 0, vfr: false, hdr: false, colorRange: 'limited' });
    expect(m.audio).toMatchObject({ sampleRate: 48000, channels: 1 });
    expect(toNumber(m.duration)).toBeCloseTo(6, 1);
    expect(m.warnings).toEqual([]);
  });

  it('detects the variable-frame-rate file', async () => {
    const m = await probeFile(fx.vfr);
    expect(m.video?.vfr).toBe(true);
    expect(m.fps).toEqual(rational(24)); // 8 of every 10 frames kept = exactly 24 fps on average
    expect(m.warnings.join()).toMatch(/Variable frame rate/);
  });

  it('applies rotation metadata to the display size', async () => {
    const m = await probeFile(fx.rotated);
    expect(m.video).toMatchObject({ codedWidth: 640, codedHeight: 360, width: 360, height: 640 });
    expect([90, 270]).toContain(m.video!.rotation);
  });

  it('folds pixel aspect ratio into the display size', async () => {
    const m = await probeFile(fx.anamorphic);
    expect(toNumber(m.video!.sar)).toBeCloseTo(4 / 3, 3);
    expect(m.video).toMatchObject({ codedWidth: 480, codedHeight: 360, width: 640, height: 360 });
  });

  it('flags HDR (PQ / BT.2020) and 10-bit', async () => {
    const m = await probeFile(fx.hdr);
    expect(m.video).toMatchObject({ hdr: true, bitDepth: 10, colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' });
    expect(m.warnings.join()).toMatch(/HDR/);
  });

  it('audio-only and still-image files', async () => {
    const a = await probeFile(fx.tone);
    expect(a).toMatchObject({ type: 'audio', audioChannels: 2 });
    expect(a.audio?.sampleRate).toBe(44100);
    expect(toNumber(a.duration)).toBeCloseTo(3, 1);
    const i = await probeFile(fx.still);
    expect(i).toMatchObject({ type: 'image', fps: undefined });
    expect(i.video).toMatchObject({ width: 400, height: 300 });
  });

  it('rejects a file that is not media', async () => {
    const bad = path.join(work, 'bad.mp4');
    await fs.writeFile(bad, 'not a video');
    await expect(probeFile(bad)).rejects.toThrow(/ffprobe failed/);
  });
});

describe('edit proxies', () => {
  it('CFR source: same fps, square pixels, BT.709 limited, audio kept, progress reported', async () => {
    const { out, progress, plan } = await makeProxy(fx.sync, 'cfr');
    const p = await probeFile(out);
    expect(p.fps).toEqual(rational(30));
    expect(p.video).toMatchObject({ width: 640, height: 360, vfr: false, colorRange: 'limited', colorSpace: 'bt709', pixFmt: 'yuv420p' });
    expect(p.audio?.sampleRate).toBe(48000);
    expect(plan.gop).toBe(15);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1]!)).toBe(true);
    await expect(fs.stat(out.replace(/\.mp4$/, '.partial.mp4'))).rejects.toThrow(); // temp file cleaned up
  });

  it('VFR source is conformed to a perfectly constant frame rate with the same duration', async () => {
    const { media, out } = await makeProxy(fx.vfr, 'vfr');
    const r = await analyzeSync(out);
    const deltas = r.frameTimes.slice(1).map((t, i) => t - r.frameTimes[i]!);
    const nominal = 1 / 24;
    // every frame lands on the 1/24 s grid
    for (const d of deltas) expect(Math.abs(d - nominal)).toBeLessThan(1e-4);
    expect(Math.abs(r.frameTimes.at(-1)! + nominal - toNumber(media.duration))).toBeLessThan(nominal + 1e-3);
  });

  it('A/V stays in sync (0 frames) through the VFR → CFR conform', async () => {
    const before = await analyzeSync(fx.vfr);
    expect(before.flashTimes).toHaveLength(6);
    const { out } = await makeProxy(fx.vfr, 'vfr-sync');
    const after = await analyzeSync(out);
    expect(after.flashTimes).toHaveLength(6);
    expect(after.beepTimes).toHaveLength(6);
    expect(after.maxOffsetFrames).toBe(0);
    // flashes stay within one proxy frame of their true second marks
    after.flashTimes.forEach((t, k) => expect(Math.abs(t - k)).toBeLessThanOrEqual(1 / 24 + 1e-3));
    // eslint-disable-next-line no-console
    console.log(`VFR→CFR A/V offset: max ${after.maxAbsOffsetMs.toFixed(2)} ms (source: ${before.maxAbsOffsetMs.toFixed(2)} ms)`);
  });

  it('CFR proxy keeps A/V sync within sub-millisecond-to-few-ms', async () => {
    const { out } = await makeProxy(fx.sync, 'cfr-sync');
    const r = await analyzeSync(out);
    expect(r.maxOffsetFrames).toBe(0);
    expect(r.maxAbsOffsetMs).toBeLessThan(10);
  });

  it('rotated source is physically rotated, anamorphic source gets square pixels', async () => {
    const rot = await makeProxy(fx.rotated, 'rot');
    const rp = await probeFile(rot.out);
    expect(rp.video).toMatchObject({ width: 360, height: 640, rotation: 0 });
    const ana = await makeProxy(fx.anamorphic, 'ana');
    const ap = await probeFile(ana.out);
    expect(ap.video).toMatchObject({ width: 640, height: 360 });
    expect(toNumber(ap.video!.sar)).toBe(1);
  });

  it('HDR source is tone-mapped to an 8-bit BT.709 proxy', async () => {
    if (!status.filters.zscale) return;
    const { out, plan } = await makeProxy(fx.hdr, 'hdr');
    expect(plan.warnings).toEqual([]);
    const p = await probeFile(out);
    expect(p.video).toMatchObject({ hdr: false, bitDepth: 8, colorSpace: 'bt709', colorTransfer: 'bt709' });
  });

  it('cancellation kills ffmpeg and leaves no partial file', async () => {
    const media = await probeFile(fx.sync);
    const plan = planProxy(media.video!, 1, status);
    const out = path.join(work, 'cancel.mp4');
    const ac = new AbortController();
    ac.abort();
    await expect(generateProxy(fx.sync, out, plan, true, 6, { ffmpegPath: 'ffmpeg', signal: ac.signal })).rejects.toThrow(/abort/);
    await expect(fs.stat(out)).rejects.toThrow();
    await expect(fs.stat(out.replace(/\.mp4$/, '.partial.mp4'))).rejects.toThrow();
  });

  it('failure surfaces ffmpeg stderr', async () => {
    const media = await probeFile(fx.sync);
    const plan = planProxy(media.video!, 1, status);
    const bad = path.join(work, 'garbage.mp4');
    await fs.writeFile(bad, 'nope');
    await expect(generateProxy(bad, path.join(work, 'x.mp4'), plan, true, 6, { ffmpegPath: 'ffmpeg' })).rejects.toThrow(/ffmpeg proxy failed/);
  });
});

describe('posters', () => {
  it('writes a JPEG at the right aspect ratio', async () => {
    const media = await probeFile(fx.rotated);
    const out = path.join(work, 'poster.jpg');
    await generatePoster(fx.rotated, out, media, { ffmpegPath: 'ffmpeg' });
    const r = await runText('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', out]);
    expect(r.stdout.trim()).toBe('mjpeg,180,320');
  });
});
