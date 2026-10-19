import { describe, expect, it } from 'vitest';
import { type Voice, parseWavHeader, makeTimebase, planAudio, createSequence, buildClip } from '@cutroom/core';
import { detectOnsets, peakDb } from '../src/audio/analyze';
import { SLICE_SAMPLES, bakeSlice, slicesOf, sourceRange } from '../src/audio/mix';
import { mixToBlocks } from '../src/audio/scheduler';

const tb = makeTimebase({ num: 30, den: 1 }); // rate 48000: one tick per sample
const ntsc = makeTimebase({ num: 30000, den: 1001 }); // rate 240000: 5 ticks per sample

const voice = (over: Partial<Voice> = {}): Voice => ({ clipId: 'c', mediaId: 'm', trackId: 't', start: 0, end: 96_000, sourceStart: 0, speed: { num: 1, den: 1 }, gain: 1, pan: 0, ramps: [], gainKeys: [], clipStart: 0, ...over });
const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => (i + 1) / 1_000_000); // unique value per sample

function wav(frames: number, channels = 2, extra = 0): ArrayBuffer {
  const dataBytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + extra + 8 + dataBytes);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, 48000, true); v.setUint32(28, 48000 * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  let o = 36;
  if (extra) { tag(o, 'LIST'); v.setUint32(o + 4, extra, true); o += 8 + extra; }
  tag(o, 'data'); v.setUint32(o + 4, dataBytes, true);
  return buf;
}

describe('parseWavHeader', () => {
  it('reads format and data location, skipping extra chunks', () => {
    expect(parseWavHeader(wav(1000, 2))).toEqual({ channels: 2, sampleRate: 48000, dataOffset: 44, frames: 1000 });
    expect(parseWavHeader(wav(10, 1, 26))).toMatchObject({ channels: 1, frames: 10, dataOffset: 44 + 8 + 26 });
  });
  it('rejects anything that is not 16-bit PCM', () => {
    const b = wav(4);
    new DataView(b).setUint16(34, 24, true);
    expect(() => parseWavHeader(b)).toThrow(/16-bit/);
    expect(() => parseWavHeader(new ArrayBuffer(8))).toThrow(/Not a WAV/);
  });
});

describe('slicing', () => {
  it('cuts on absolute boundaries and covers the voice exactly once', () => {
    const v = voice({ start: 1000, end: 60_000 });
    const s = slicesOf(v, tb, 0, 1e9);
    expect(s[0]).toEqual({ sample: 1000, frames: SLICE_SAMPLES - 1000 });
    expect(s.every((x) => (x.sample + x.frames) % SLICE_SAMPLES === 0 || x.sample + x.frames === 60_000)).toBe(true);
    expect(s.reduce((n, x) => n + x.frames, 0)).toBe(59_000);
    // a window in the middle sees the same slice boundaries as the full run
    const w = slicesOf(v, tb, 30_000, 50_000);
    expect(w[0]).toEqual({ sample: 30_000, frames: 18_000 });
  });
  it('a sample belongs to the voice when start ≤ sample·S < end (S = 5 ticks at 29.97)', () => {
    const v = voice({ start: 7, end: 22 });
    const s = slicesOf(v, ntsc, 0, 1e9);
    expect(s).toEqual([{ sample: 2, frames: 3 }]); // ticks 10, 15, 20
  });
});

describe('bakeSlice', () => {
  it('at speed 1 copies source samples with a constant integer shift — no interpolation', () => {
    const src = ramp(50_000);
    const v = voice({ start: 4800, end: 52_000, sourceStart: 4800 + 100 });
    const s = { sample: 5000, frames: 1000 };
    const [a, b] = sourceRange(v, tb, 48_000, s);
    const [L, R] = bakeSlice(v, tb, 48_000, [src.subarray(a, b)], a, s);
    for (let j = 0; j < 1000; j++) {
      expect(L[j]).toBe(src[5000 + 100 + j]); // exactly the shifted source sample
      expect(R[j]).toBe(L[j]); // mono duplicates
    }
  });

  it('applies gain, balance and equal-power ramps', () => {
    const ones = new Float32Array(10_000).fill(1);
    const v = voice({ start: 0, end: 10_000, gain: 0.5, pan: 1, ramps: [{ from: 1000, to: 2000, shape: 'in', curve: 'equal-power' }] });
    const [L, R] = bakeSlice(v, tb, 48_000, [ones, ones], 0, { sample: 0, frames: 4000 });
    expect(L[500]).toBe(0); // before the ramp: silent
    expect(L[1500]).toBeCloseTo(0.5 * Math.cos(Math.PI / 2) * Math.sin(Math.PI / 4), 6); // hard right ⇒ left muted
    expect(R[1500]).toBeCloseTo(0.5 * Math.sin(Math.PI / 4), 6);
    expect(R[3000]).toBeCloseTo(0.5, 6);
  });

  it('an equal-power crossfade keeps constant power across the cut', () => {
    const out = (from: number, to: number, shape: 'in' | 'out') => ({ from, to, shape, curve: 'equal-power' as const });
    const a = voice({ start: 0, end: 10_192, ramps: [out(9_808, 10_192, 'out')] });
    const b = voice({ start: 9_808, end: 20_000, sourceStart: 9_808, ramps: [out(9_808, 10_192, 'in')] });
    const sl = { sample: 9_808, frames: 384 };
    const mix = (x: Voice) => bakeSlice(x, tb, 48_000, [new Float32Array(30_000).fill(1)], 0, sl)[0];
    for (let j = 0; j < 384; j++) expect(mix(a)[j]! ** 2 + mix(b)[j]! ** 2).toBeCloseTo(1, 5);
  });

  it('time-stretches by linear interpolation at other speeds', () => {
    const src = Float32Array.from({ length: 4000 }, (_, i) => i);
    const v = voice({ start: 0, end: 1000, speed: { num: 2, den: 1 } });
    const s = { sample: 0, frames: 100 };
    const [a, b] = sourceRange(v, tb, 48_000, s);
    const [L] = bakeSlice(v, tb, 48_000, [src.subarray(Math.max(0, a), b)], Math.max(0, a), s);
    expect(L[10]).toBeCloseTo(20, 6);
    const half = voice({ start: 0, end: 1000, speed: { num: 1, den: 2 } });
    const [L2] = bakeSlice(half, tb, 48_000, [src], 0, s);
    expect(L2[3]).toBeCloseTo(1.5, 6);
  });
});

describe('mixToBlocks', () => {
  it('sums overlapping slices into aligned blocks inside the window', () => {
    const mk = (sample: number, frames: number, val: number) => ({ sample, frames, data: [new Float32Array(frames).fill(val), new Float32Array(frames).fill(val)] as [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] });
    const blocks = mixToBlocks([mk(100, 30_000, 1), mk(20_000, 10_000, 2)], 100, 30_100);
    expect(blocks.map((b) => [b.sample, b.frames])).toEqual([[100, SLICE_SAMPLES - 100], [SLICE_SAMPLES, 6_100]]);
    expect(blocks[0]!.data[0][0]).toBe(1);
    expect(blocks[0]!.data[0][20_000 - 100]).toBe(3);
    expect(blocks[1]!.data[1][0]).toBe(3);
  });
});

describe('detectOnsets', () => {
  it('finds each burst once, after a quiet gap', () => {
    const x = new Float32Array(10_000);
    for (const at of [1000, 5000, 5050]) for (let i = 0; i < 40; i++) x[at + i] = 0.5 * Math.sin(i);
    x[1000] = 0.5;
    x[5000] = 0.5;
    expect(detectOnsets(x, 0.1, 500)).toEqual([1000, 5000]);
  });
  it('peakDb', () => {
    expect(peakDb(Float32Array.from([0, -0.5, 0.25]))).toBeCloseTo(-6.0206, 3);
    expect(peakDb(new Float32Array(4))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('planAudio feeds the mixer end to end', () => {
  it('a split clip bakes to the same samples as the unsplit clip (continuous join)', () => {
    const seq = createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } });
    const track = seq.tracks.find((t) => t.name === 'A1')!;
    const mk = (id: string, start: number, duration: number, sourceIn: number) => ({ ...buildClip(id, { mediaId: 'm', trackId: track.id, start, duration, sourceIn }) });
    track.items.a = mk('a', 0, 48_000, 0);
    const whole = planAudio(seq, { getMedia: () => ({ id: 'm', kind: 'audio', duration: 480_000, hasVideo: false, hasAudio: true }) });
    track.items.a = mk('a', 0, 24_000, 0);
    track.items.b = mk('b', 24_000, 24_000, 24_000);
    const split = planAudio(seq, { getMedia: () => ({ id: 'm', kind: 'audio', duration: 480_000, hasVideo: false, hasAudio: true }) });
    const src = ramp(60_000);
    const bake = (voices: Voice[]) => {
      const out = new Float32Array(48_000);
      for (const v of voices) for (const s of slicesOf(v, seq.timebase, 0, 48_000)) {
        const [a, b] = sourceRange(v, seq.timebase, 48_000, s);
        const lo = Math.max(0, a);
        const [L] = bakeSlice(v, seq.timebase, 48_000, [src.subarray(lo, b)], lo, s);
        for (let j = 0; j < s.frames; j++) out[s.sample + j]! += L[j]!;
      }
      return out;
    };
    expect(bake(split)).toEqual(bake(whole));
  });
});
