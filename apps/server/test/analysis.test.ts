import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Media, ProjectResponse } from '@cutroom/core';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { parseWhisperJson, findWhisper } from '../src/analysis/whisper';
import { runText } from '../src/proc';
import { fixtures, type Fixtures } from './helpers/media';

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
async function makeApp(opts: Parameters<typeof buildApp>[1] = {}) {
  const dataDir = await tmp('data');
  const built = await buildApp(loadConfig({ dataDir }), { saveDelayMs: 50, ...opts });
  cleanup.push(() => built.app.close());
  return { ...built, dataDir };
}
async function open(b: BuiltApp, dir: string): Promise<ProjectResponse> {
  const res = await b.app.inject({ method: 'POST', url: '/api/project/open', payload: { path: dir } });
  expect(res.statusCode).toBe(200);
  return res.json();
}
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ff = async (args: string[]) => {
  const r = await runText(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-v', 'error', ...args]);
  if (r.code !== 0) throw new Error(r.stderr);
};
const media = (b: BuiltApp, name: string): Media => b.manager.current!.media.find((m) => m.name === name)!;
const json = async <T>(b: BuiltApp, id: string, name: string): Promise<T> => (await b.app.inject({ method: 'GET', url: `/api/media/${id}/analysis/${name}` })).json();

describe('media intelligence on the sync asset', () => {
  it('computes waveform, silences, loudness, beats, filmstrip and scenes, and serves them', async () => {
    const b = await makeApp();
    const dir = await tmp('proj');
    await fs.copyFile(fx.sync, path.join(dir, 'clip.mp4'));
    await open(b, dir);
    await b.jobs.idle();
    await b.jobs.idle(); // the analysis jobs are queued when the proxy lands
    const m = media(b, 'clip.mp4');
    for (const k of ['waveform', 'silences', 'loudness', 'beats', 'filmstrip', 'scenes'] as const) expect(m.status[k], k).toBe('done');
    expect(m.status.transcript).toBe('unavailable'); // no whisper in the test environment
    expect((m.analysis.transcript as { reason: string }).reason).toMatch(/whisper/);

    // --- waveform: six 50 ms beeps in six seconds
    const wf = await json<{ samplesPerBin: number; sampleRate: number; bins: number }>(b, m.id, 'waveform');
    expect(wf).toMatchObject({ samplesPerBin: 256, sampleRate: 48_000 });
    const bin = await b.app.inject({ method: 'GET', url: `/api/media/${m.id}/analysis/waveform.bin` });
    const peaks = new Int16Array(bin.rawPayload.buffer.slice(bin.rawPayload.byteOffset, bin.rawPayload.byteOffset + bin.rawPayload.byteLength));
    expect(peaks.length).toBe(wf.bins * 2);
    const binAt = (sec: number) => Math.floor((sec * 48_000) / 256);
    for (let k = 0; k < 6; k++) {
      expect(peaks[binAt(k + 0.025) * 2 + 1]!, `beep ${k}`).toBeGreaterThan(0.4 * 32767);
      expect(peaks[binAt(k + 0.5) * 2 + 1]!, `gap ${k}`).toBeLessThan(0.02 * 32767);
    }

    // --- silences: every gap between beeps, to within a window
    const sil = await json<{ sampleRate: number; ranges: { start: number; end: number }[] }>(b, m.id, 'silences');
    expect(sil.ranges.length).toBeGreaterThanOrEqual(5);
    for (const r of sil.ranges.slice(0, 5)) {
      const start = r.start / 48_000;
      const k = Math.floor(start);
      expect(start - k).toBeGreaterThan(0.04);
      expect(start - k).toBeLessThan(0.1);
      expect(r.end / 48_000 - (k + 1)).toBeLessThan(0.02);
    }

    // --- loudness agrees with ffmpeg's EBU R128 meter on the same audio
    const loud = await json<{ integrated: number; truePeak: number; range: number }>(b, m.id, 'loudness');
    const wav = path.join(dir, m.audioProxyPath!);
    const ref = await runText(ffmpeg, ['-hide_banner', '-nostdin', '-i', wav, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    const refI = Number(/I:\s+(-?[\d.]+) LUFS/.exec(ref.stderr.split('Summary:')[1] ?? '')![1]);
    const refTp = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(ref.stderr.split('Summary:')[1] ?? '')![1]);
    expect(Math.abs(loud.integrated - refI), `ours ${loud.integrated} vs ffmpeg ${refI}`).toBeLessThan(0.15);
    expect(Math.abs(loud.truePeak - refTp), `ours ${loud.truePeak} vs ffmpeg ${refTp}`).toBeLessThan(0.6);

    // --- filmstrip: a sprite sheet of the declared geometry
    const fs0 = await json<{ interval: number; thumbW: number; thumbH: number; cols: number; rows: number; count: number }>(b, m.id, 'filmstrip');
    expect(fs0.count).toBe(6);
    const sprite = await b.app.inject({ method: 'GET', url: `/api/media/${m.id}/analysis/filmstrip.jpg` });
    expect(sprite.headers['content-type']).toBe('image/jpeg');
    const probe = await runText(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir, '.cutroom', 'cache', m.id, 'filmstrip.jpg')]);
    expect(probe.stdout.trim()).toBe(`${fs0.cols * fs0.thumbW},${fs0.rows * fs0.thumbH}`);

    // --- scenes: every black → white flash onset is a cut
    const scenes = await json<{ cuts: { frame: number }[] }>(b, m.id, 'scenes');
    const frames = scenes.cuts.map((c) => c.frame);
    for (const f of [30, 60, 90, 120, 150]) expect(frames, `flash at frame ${f}`).toContain(f);
  }, 120_000);

  it('detects shot boundaries to the frame', async () => {
    const b = await makeApp();
    const dir = await tmp('proj');
    // red 2 s → blue 2 s → green 2 s → red 1 s, 30 fps
    const seg = (c: string, d: number) => `color=c=${c}:s=320x180:r=30:d=${d}`;
    await ff(['-f', 'lavfi', '-i', seg('red', 2), '-f', 'lavfi', '-i', seg('blue', 2), '-f', 'lavfi', '-i', seg('green', 2), '-f', 'lavfi', '-i', seg('red', 1), '-filter_complex', '[0][1][2][3]concat=n=4:v=1:a=0,format=yuv420p', '-c:v', 'libx264', '-g', '30', path.join(dir, 'shots.mp4')]);
    await open(b, dir);
    await b.jobs.idle();
    await b.jobs.idle();
    const m = media(b, 'shots.mp4');
    expect(m.status.scenes).toBe('done');
    expect(m.status.waveform).toBe('skipped'); // no audio stream
    const scenes = await json<{ cuts: { frame: number; time: number }[] }>(b, m.id, 'scenes');
    expect(scenes.cuts.map((c) => c.frame)).toEqual([60, 120, 180]);
    expect(scenes.cuts[0]!.time).toBe(2);
  }, 120_000);

  it('does not redo finished work on reopen, and rebuilds a stage whose cache file vanished', async () => {
    const b = await makeApp();
    const dir = await tmp('proj');
    await fs.copyFile(fx.tone, path.join(dir, 'tone.wav'));
    await open(b, dir);
    await b.jobs.idle();
    await b.jobs.idle();
    const m = media(b, 'tone.wav');
    expect(m.status.waveform).toBe('done');
    expect(m.status.filmstrip).toBe('skipped'); // audio-only
    expect(m.status.scenes).toBe('skipped');
    await b.app.inject({ method: 'POST', url: '/api/project/close' });

    const before = b.jobs.list().length;
    await open(b, dir);
    await b.jobs.idle();
    expect(b.jobs.list().length).toBe(before); // nothing re-queued

    await b.app.inject({ method: 'POST', url: '/api/project/close' });
    await fs.rm(path.join(dir, '.cutroom', 'cache', m.id, 'waveform.bin'));
    await open(b, dir);
    await b.jobs.idle();
    await b.jobs.idle();
    expect(media(b, 'tone.wav').status.waveform).toBe('done');
    expect((await b.app.inject({ method: 'GET', url: `/api/media/${m.id}/analysis/waveform.bin` })).statusCode).toBe(200);
  }, 120_000);

  it('finds the tempo and beats of a click track', async () => {
    const b = await makeApp();
    const dir = await tmp('proj');
    await ff(['-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t+0.13,0.5),0.02),0.8*sin(2*PI*1500*t),0)':s=48000:d=20", path.join(dir, 'clicks.wav')]);
    await open(b, dir);
    await b.jobs.idle();
    await b.jobs.idle();
    const m = media(b, 'clicks.wav');
    const beats = await json<{ bpm: number; beats: number[] }>(b, m.id, 'beats');
    expect(Math.abs(beats.bpm - 120)).toBeLessThan(1.5);
    expect(beats.beats.length).toBeGreaterThan(36);
    expect((m.analysis.beats as { bpm: number }).bpm).toBe(beats.bpm);
  }, 120_000);

  it('rejects unknown analysis names and reports not-ready ones', async () => {
    const b = await makeApp();
    const dir = await tmp('proj');
    await fs.copyFile(fx.tone, path.join(dir, 'tone.wav'));
    await open(b, dir);
    await b.jobs.idle();
    const m = media(b, 'tone.wav');
    expect((await b.app.inject({ method: 'GET', url: `/api/media/${m.id}/analysis/../../project.json` })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await b.app.inject({ method: 'GET', url: `/api/media/${m.id}/analysis/nonsense` })).statusCode).toBe(400);
    expect((await b.app.inject({ method: 'GET', url: `/api/media/${m.id}/analysis/transcript` })).statusCode).toBe(404);
  });
});

describe('transcription (whisper.cpp adapter)', () => {
  it('parses whisper.cpp word segments: strips annotations, glues punctuation, groups sentences', () => {
    const seg = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
    const t = parseWhisperJson(
      {
        result: { language: 'en' },
        transcription: [seg(' [BLANK_AUDIO]', 0, 400), seg(' Hello', 500, 800), seg(',', 800, 820), seg(' world', 900, 1300), seg('.', 1300, 1320), seg(' (music)', 1400, 1600), seg(' Second', 3500, 3800), seg(' bit', 3800, 4000)],
      },
      '/m/ggml-base.en.bin',
    );
    expect(t.language).toBe('en');
    expect(t.model).toBe('ggml-base.en.bin');
    expect(t.words.map((w) => [w.text, w.startMs, w.endMs])).toEqual([['Hello,', 500, 820], ['world.', 900, 1320], ['Second', 3500, 3800], ['bit', 3800, 4000]]);
    expect(t.segments.map((s) => s.text)).toEqual(['Hello, world.', 'Second bit']);
    expect(t.segments[1]).toMatchObject({ startMs: 3500, endMs: 4000, wordStart: 2, wordEnd: 4 });
  });

  it('discovers whisper.cpp from the environment and the models folder', async () => {
    const dir = await tmp('whisper');
    const bin = path.join(dir, 'whisper-cli');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    await fs.mkdir(path.join(dir, 'models'));
    await fs.writeFile(path.join(dir, 'models', 'ggml-tiny.bin'), 'x');
    await fs.writeFile(path.join(dir, 'models', 'ggml-base.en.bin'), 'x');
    expect(await findWhisper(dir, { PATH: '/nonexistent' })).toBeNull();
    expect(await findWhisper(dir, { PATH: dir })).toEqual({ bin, model: path.join(dir, 'models', 'ggml-base.en.bin') });
    expect(await findWhisper(dir, { WHISPER_CPP_BIN: bin, WHISPER_MODEL: path.join(dir, 'models', 'ggml-tiny.bin'), PATH: '' })).toEqual({ bin, model: path.join(dir, 'models', 'ggml-tiny.bin') });
  });

  it('transcribes through a whisper.cpp-compatible binary and stores word timings', async () => {
    const dir = await tmp('fakewhisper');
    const script = path.join(dir, 'whisper-cli');
    // behaves like whisper.cpp: reads -of <base> and writes <base>.json with one word per segment
    await fs.writeFile(
      script,
      `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv;
const base = a[a.indexOf('-of') + 1];
if (!fs.existsSync(a[a.indexOf('-f') + 1])) process.exit(2);
fs.writeFileSync(base + '.json', JSON.stringify({ result: { language: 'en' }, transcription: [
  { text: ' The', offsets: { from: 100, to: 300 } }, { text: ' beep', offsets: { from: 300, to: 700 } }, { text: '.', offsets: { from: 700, to: 710 } } ] }));
`,
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(dir, 'ggml-fake.bin'), 'x');
    const b = await makeApp({ whisper: async () => ({ bin: script, model: path.join(dir, 'ggml-fake.bin') }) });
    const proj = await tmp('proj');
    await fs.copyFile(fx.sync, path.join(proj, 'clip.mp4'));
    await open(b, proj);
    await b.jobs.idle();
    await b.jobs.idle();
    const m = media(b, 'clip.mp4');
    expect(m.status.transcript).toBe('done');
    expect(m.analysis.transcript).toMatchObject({ language: 'en', words: 2, segments: 1, text: 'The beep.' });
    const t = await json<{ words: { text: string; startMs: number; endMs: number }[] }>(b, m.id, 'transcript');
    expect(t.words).toEqual([{ text: 'The', startMs: 100, endMs: 300 }, { text: 'beep.', startMs: 300, endMs: 710 }]);
    const health = (await b.app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(health.whisper).toEqual({ available: true, model: 'ggml-fake.bin' });
  }, 120_000);

  it('health explains how to enable transcription when whisper.cpp is missing', async () => {
    const b = await makeApp({ whisper: async () => null });
    const health = (await b.app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(health.whisper.available).toBe(false);
    expect(health.whisper.hint).toMatch(/WHISPER_CPP_BIN/);
  });
});
