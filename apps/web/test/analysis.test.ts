import { describe, expect, it } from 'vitest';
import { buildClip, createSequence, reducePeaks } from '@cutroom/core';
import { filterSegments, formatStamp, timelineTimeForSource } from '../src/lib/transcript';
import type { WaveformData } from '../src/store/analysis';
import { drawSilences, drawWaveform, peaksOver } from '../src/timeline/waveform';

const wave = (bins: number, f: (bin: number) => [number, number], spb = 256): WaveformData => {
  const l0 = new Int16Array(bins * 2);
  for (let b = 0; b < bins; b++) {
    const [lo, hi] = f(b);
    l0[b * 2] = Math.round(lo * 32767);
    l0[b * 2 + 1] = Math.round(hi * 32767);
  }
  const levels: Int16Array[] = [l0];
  while (levels.at(-1)!.length > 8) levels.push(reducePeaks(levels.at(-1)!));
  return { samplesPerBin: spb, sampleRate: 48_000, levels };
};

function rec() {
  const rects: [number, number, number, number][] = [];
  const ctx = { fillRect: (...a: number[]) => rects.push(a as [number, number, number, number]), set fillStyle(_v: string) {} } as unknown as CanvasRenderingContext2D;
  return { ctx, rects };
}

describe('peaksOver', () => {
  it('returns the stored bin when zoomed in and the envelope of many bins when zoomed out', () => {
    const w = wave(64, (b) => (b === 10 ? [-0.9, 0.8] : [-0.1, 0.1]));
    expect(peaksOver(w, 10 * 256, 11 * 256)).toEqual([-0.9, 0.8].map((v) => Math.round(v * 32767) / 32767));
    const zoomedOut = peaksOver(w, 0, 64 * 256)!;
    expect(zoomedOut[0]).toBeCloseTo(-0.9, 3);
    expect(zoomedOut[1]).toBeCloseTo(0.8, 3);
  });
  it('is null past the end of the file', () => {
    expect(peaksOver(wave(4, () => [0, 0]), 10_000, 10_100)).toBeNull();
  });
});

describe('drawWaveform', () => {
  const seq = createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } });
  const rate = seq.timebase.rate;
  const view = { pps: 100, scrollX: 0, scrollY: 0, width: 600, height: 200 };
  const clip = (over = {}) => buildClip('c', { mediaId: 'm', trackId: 't', start: rate, duration: 2 * rate, sourceIn: 0, ...over });
  // 1 s of loud then 1 s of quiet then 1 s of loud, at 48 kHz / 256 per bin
  const w = wave(Math.ceil((3 * 48_000) / 256), (b) => { const s = (b * 256) / 48_000; return s >= 1 && s < 2 ? [-0.05, 0.05] : [-0.8, 0.8]; });

  it('covers exactly the clip and reflects its content', () => {
    const { ctx, rects } = rec();
    drawWaveform(ctx, w, clip(), rate, view, { x0: 100, x1: 300, y: 10, h: 40 }, '#fff');
    expect(rects.length).toBe(200);
    expect(Math.min(...rects.map((r) => r[0]))).toBe(100);
    expect(Math.max(...rects.map((r) => r[0]))).toBe(299);
    const tall = rects[10]![3]; // source 0.1 s: loud
    const quiet = rects[150]![3]; // source 1.5 s: quiet
    expect(tall).toBeGreaterThan(quiet * 5);
  });

  it('maps through trim: a clip that starts 1 s into the media begins in the quiet part', () => {
    const { ctx, rects } = rec();
    drawWaveform(ctx, w, clip({ sourceIn: rate }), rate, view, { x0: 100, x1: 300, y: 10, h: 40 }, '#fff');
    expect(rects[10]![3]).toBeLessThan(rects[150]![3] / 5);
  });

  it('applies speed: at 2× the same pixels show twice the media', () => {
    const { ctx, rects } = rec();
    drawWaveform(ctx, w, clip({ duration: rate, speed: { num: 2, den: 1 } }), rate, view, { x0: 100, x1: 200, y: 10, h: 40 }, '#fff');
    expect(rects[10]![3]).toBeGreaterThan(rects[60]![3] * 5); // x=110 ↔ source 0.2 s (loud), x=160 ↔ source 1.2 s (quiet)
  });

  it('only paints visible columns', () => {
    const { ctx, rects } = rec();
    drawWaveform(ctx, w, clip(), rate, { ...view, width: 150 }, { x0: 100, x1: 300, y: 10, h: 40 }, '#fff');
    expect(rects.length).toBe(50);
  });
});

describe('drawSilences', () => {
  it('shades source silences where they land on the timeline', () => {
    const seq = createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } });
    const rate = seq.timebase.rate;
    const { ctx, rects } = rec();
    const c = buildClip('c', { mediaId: 'm', trackId: 't', start: 2 * rate, duration: 3 * rate, sourceIn: rate });
    drawSilences(ctx, { sampleRate: 48_000, ranges: [{ start: 48_000 * 2, end: 48_000 * 3 }, { start: 48_000 * 10, end: 48_000 * 11 }] }, c, rate, { pps: 100, scrollX: 0, scrollY: 0, width: 800, height: 100 }, { x0: 200, x1: 500, y: 0, h: 30 }, '#000');
    expect(rects).toEqual([[300, 0, 100, 30]]); // source 2–3 s is timeline 3–4 s
  });
});

describe('transcript helpers', () => {
  const seq = createSequence({ width: 1920, height: 1080, fps: { num: 30, den: 1 } });
  const rate = seq.timebase.rate;
  const a = seq.tracks.find((t) => t.name === 'A1')!;
  a.items.x = buildClip('x', { mediaId: 'm', trackId: a.id, start: 10 * rate, duration: 5 * rate, sourceIn: 20 * rate });
  a.items.y = buildClip('y', { mediaId: 'm', trackId: a.id, start: 30 * rate, duration: 2 * rate, sourceIn: 0, speed: { num: 2, den: 1 } });

  it('finds where media time plays on the timeline, through trim and speed', () => {
    expect(timelineTimeForSource(seq, 'm', 22 * rate)).toBe(12 * rate);
    expect(timelineTimeForSource(seq, 'm', 2 * rate)).toBe(31 * rate); // 2× speed: 2 s of media = 1 s of timeline
    expect(timelineTimeForSource(seq, 'm', 5 * rate)).toBeNull();
    expect(timelineTimeForSource(seq, 'other', 22 * rate)).toBeNull();
    expect(timelineTimeForSource(seq, 'm', 25 * rate)).toBeNull(); // clip x ends at source 25 s (exclusive)
  });

  it('formats stamps and filters segments by every term', () => {
    expect(formatStamp(0)).toBe('0:00.0');
    expect(formatStamp(83_400)).toBe('1:23.4');
    const segs = [{ text: 'Hello brave world.' }, { text: 'Goodbye world.' }];
    expect(filterSegments(segs, 'WORLD')).toHaveLength(2);
    expect(filterSegments(segs, 'brave world')).toEqual([segs[0]]);
    expect(filterSegments(segs, '')).toHaveLength(2);
    expect(filterSegments(segs, 'nope')).toEqual([]);
  });
});
