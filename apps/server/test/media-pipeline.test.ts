import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rational, toNumber } from '@cutroom/core';
import { checkFfmpeg } from '../src/ffmpeg';
import { probeFile } from '../src/probe';
import { generateAudioProxy, generatePoster, generateProxy, planAudioProxy, planProxy } from '../src/proxy';
import { runText } from '../src/proc';
import { analyzeSync, fixtures, generateSyncAsset, type Fixtures } from './helpers/media';
import type { ProxyCodec } from '@cutroom/core';

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

async function makeProxy(src: string, name: string, codec: ProxyCodec = 'h264') {
  const media = await probeFile(src);
  const plan = planProxy(media.video!, status, codec);
  const out = path.join(work, `${name}.mp4`);
  const progress: number[] = [];
  const dur = toNumber(media.duration);
  await generateProxy(src, out, plan, dur, { ffmpegPath: 'ffmpeg', onProgress: (p) => progress.push(p) });
  let wav: string | undefined;
  if (media.audio) {
    wav = path.join(work, `${name}.wav`);
    await generateAudioProxy(src, wav, planAudioProxy(media.audio, media.video), dur, { ffmpegPath: 'ffmpeg' });
  }
  return { media, plan, out, wav, progress };
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

describe.each<ProxyCodec>(['h264', 'vp9'])('edit proxies (%s)', (codec) => {
  const hasEncoder = () => status.encoders[codec === 'vp9' ? 'libvpx-vp9' : 'libx264'];

  it('CFR source: same fps, square pixels, BT.709 limited; video-only; audio in a separate PCM WAV', async () => {
    if (!hasEncoder()) return;
    const { out, wav, progress, plan } = await makeProxy(fx.sync, `cfr-${codec}`, codec);
    const p = await probeFile(out);
    expect(p.fps).toEqual(rational(30));
    expect(p.video).toMatchObject({ width: 640, height: 360, vfr: false, colorRange: 'limited', colorSpace: 'bt709', pixFmt: 'yuv420p', codec: codec === 'vp9' ? 'vp9' : 'h264' });
    expect(p.audio).toBeUndefined(); // the video proxy has no audio track
    expect(plan.gop).toBe(15);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1]!)).toBe(true);
    await expect(fs.stat(out.replace(/\.mp4$/, '.partial.mp4'))).rejects.toThrow(); // temp file cleaned up

    const w = await probeFile(wav!);
    expect(w).toMatchObject({ type: 'audio', audioChannels: 1 });
    expect(w.audio).toMatchObject({ codec: 'pcm_s16le', sampleRate: 48000 });
    expect(toNumber(w.duration)).toBeGreaterThanOrEqual(6);
    expect(toNumber(w.duration)).toBeLessThan(6.03); // an AAC source decodes with up to one frame of encoder padding
  });

  it('VFR source is conformed to a perfectly constant frame rate with the same duration', async () => {
    if (!hasEncoder()) return;
    const { media, out } = await makeProxy(fx.vfr, `vfr-${codec}`, codec);
    const r = await analyzeSync(out, fx.vfr); // frames from the proxy; audio only needed to satisfy the analyser
    const deltas = r.frameTimes.slice(1).map((t, i) => t - r.frameTimes[i]!);
    const nominal = 1 / 24;
    for (const d of deltas) expect(Math.abs(d - nominal)).toBeLessThan(1e-4);
    expect(Math.abs(r.frameTimes.at(-1)! + nominal - toNumber(media.duration))).toBeLessThan(nominal + 1e-3);
  });

  it('A/V stays in sync (0 frames) through the VFR → CFR conform: video proxy + audio proxy', async () => {
    if (!hasEncoder()) return;
    const before = await analyzeSync(fx.vfr);
    expect(before.flashTimes).toHaveLength(6);
    const { out, wav } = await makeProxy(fx.vfr, `vfr-sync-${codec}`, codec);
    const after = await analyzeSync(out, wav);
    expect(after.flashTimes).toHaveLength(6);
    expect(after.beepTimes).toHaveLength(6);
    expect(after.maxOffsetFrames).toBe(0);
    after.flashTimes.forEach((t, k) => expect(Math.abs(t - k)).toBeLessThanOrEqual(1 / 24 + 1e-3));
    // eslint-disable-next-line no-console
    console.log(`[${codec}] VFR→CFR A/V offset: max ${after.maxAbsOffsetMs.toFixed(2)} ms (source: ${before.maxAbsOffsetMs.toFixed(2)} ms)`);
  });

  it('CFR proxy pair keeps A/V sync to within a few milliseconds', async () => {
    if (!hasEncoder()) return;
    const { out, wav } = await makeProxy(fx.sync, `cfr-sync-${codec}`, codec);
    const r = await analyzeSync(out, wav);
    expect(r.maxOffsetFrames).toBe(0);
    expect(r.maxAbsOffsetMs).toBeLessThan(2); // PCM has no codec priming: the audio proxy is sample-exact
  });

  it('a late-starting audio stream keeps its offset in the WAV (same origin as the video)', async () => {
    if (!hasEncoder()) return;
    const src = await generateSyncAsset(path.join(work, 'late-audio.mp4'), { seconds: 4, audioDelay: 0.5 });
    const source = await analyzeSync(src);
    expect(source.maxAbsOffsetMs).toBeGreaterThan(450); // beep k sits 500 ms after flash k
    const { out, wav } = await makeProxy(src, `late-${codec}`, codec);
    const proxy = await analyzeSync(out, wav);
    expect(Math.abs(proxy.offsetsMs[0]! - source.offsetsMs[0]!)).toBeLessThan(3);
    expect(Math.abs(proxy.offsetsMs[0]! - 500)).toBeLessThan(3);
  });

  it('a late-starting VIDEO stream keeps its offset too (the mirror case)', async () => {
    if (!hasEncoder()) return;
    const src = await generateSyncAsset(path.join(work, 'late-video.mp4'), { seconds: 4, videoDelay: 0.5 });
    const source = await analyzeSync(src);
    expect(Math.abs(source.offsetsMs[0]! + 500)).toBeLessThan(3); // beep k is 500 ms BEFORE flash k
    const { out, wav } = await makeProxy(src, `latevid-${codec}`, codec);
    const proxy = await analyzeSync(out, wav);
    expect(Math.abs(proxy.offsetsMs[0]! + 500), `proxy offset ${proxy.offsetsMs[0]} ms`).toBeLessThan(3);
  });

  it('rotated source is physically rotated, anamorphic source gets square pixels', async () => {
    if (!hasEncoder()) return;
    const rot = await makeProxy(fx.rotated, `rot-${codec}`, codec);
    expect((await probeFile(rot.out)).video).toMatchObject({ width: 360, height: 640, rotation: 0 });
    const ana = await makeProxy(fx.anamorphic, `ana-${codec}`, codec);
    const ap = await probeFile(ana.out);
    expect(ap.video).toMatchObject({ width: 640, height: 360 });
    expect(toNumber(ap.video!.sar)).toBe(1);
  });

  it('HDR source is tone-mapped to an 8-bit BT.709 proxy', async () => {
    if (!hasEncoder() || !status.filters.zscale) return;
    const { out, plan } = await makeProxy(fx.hdr, `hdr-${codec}`, codec);
    expect(plan.warnings).toEqual([]);
    expect((await probeFile(out)).video).toMatchObject({ hdr: false, bitDepth: 8, colorSpace: 'bt709', colorTransfer: 'bt709' });
  });
});

describe('proxy job control', () => {
  it('cancellation kills ffmpeg and leaves no partial file', async () => {
    const media = await probeFile(fx.sync);
    const plan = planProxy(media.video!, status);
    const out = path.join(work, 'cancel.mp4');
    const ac = new AbortController();
    ac.abort();
    await expect(generateProxy(fx.sync, out, plan, 6, { ffmpegPath: 'ffmpeg', signal: ac.signal })).rejects.toThrow(/abort/);
    await expect(fs.stat(out)).rejects.toThrow();
    await expect(fs.stat(out.replace(/\.mp4$/, '.partial.mp4'))).rejects.toThrow();
  });

  it('failure surfaces ffmpeg stderr', async () => {
    const media = await probeFile(fx.sync);
    const plan = planProxy(media.video!, status);
    const bad = path.join(work, 'garbage.mp4');
    await fs.writeFile(bad, 'nope');
    await expect(generateProxy(bad, path.join(work, 'x.mp4'), plan, 6, { ffmpegPath: 'ffmpeg' })).rejects.toThrow(/ffmpeg proxy failed/);
    await expect(generateAudioProxy(bad, path.join(work, 'x.wav'), { channels: 2, offsetSec: 0 }, 6, { ffmpegPath: 'ffmpeg' })).rejects.toThrow(/audio proxy failed/);
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
