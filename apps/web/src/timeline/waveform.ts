import type { Clip } from '@cutroom/core';
import type { WaveformData, SilenceData } from '../store/analysis';
import { type View, ticksToX, xToTicks } from './geometry';

/** Peak [min, max] (−1…1) of the stored waveform over source samples [from, to). Uses the coarsest level that still resolves the span. */
export function peaksOver(wf: WaveformData, fromSample: number, toSample: number): [number, number] | null {
  const span = Math.max(1, toSample - fromSample);
  // pick the coarsest level whose bin is no wider than the span
  let level = 0;
  while (level + 1 < wf.levels.length && wf.samplesPerBin * 2 ** (level + 1) <= span) level++;
  const binSize = wf.samplesPerBin * 2 ** level;
  const data = wf.levels[level]!;
  const bins = data.length / 2;
  const b0 = Math.max(0, Math.floor(fromSample / binSize));
  const b1 = Math.min(bins - 1, Math.max(b0, Math.floor((toSample - 1) / binSize)));
  if (b0 >= bins || toSample <= 0) return null;
  let lo = 32767;
  let hi = -32768;
  for (let b = b0; b <= b1; b++) {
    if (data[b * 2]! < lo) lo = data[b * 2]!;
    if (data[b * 2 + 1]! > hi) hi = data[b * 2 + 1]!;
  }
  return [lo / 32767, hi / 32767];
}

export interface ClipBox {
  x0: number;
  x1: number;
  y: number;
  h: number;
}

/** Draw a clip's waveform: one column per pixel, mapped through the clip's trim and speed. */
export function drawWaveform(ctx: CanvasRenderingContext2D, wf: WaveformData, clip: Clip, rate: number, view: View, box: ClipBox, color: string, gain = 1): void {
  const lo = Math.max(0, Math.floor(box.x0));
  const hi = Math.min(view.width, Math.ceil(box.x1));
  const mid = box.y + box.h / 2;
  const amp = (box.h / 2) * 0.92;
  const speed = clip.speed.num / clip.speed.den;
  const sampleOf = (x: number): number => {
    const t = Math.min(clip.start + clip.duration, Math.max(clip.start, xToTicks(x, rate, view)));
    return ((clip.sourceIn + (t - clip.start) * speed) / rate) * wf.sampleRate;
  };
  ctx.fillStyle = color;
  for (let x = lo; x < hi; x++) {
    const p = peaksOver(wf, sampleOf(x), sampleOf(x + 1));
    if (!p) continue;
    const top = mid - Math.min(1, p[1] * gain) * amp;
    const bottom = mid - Math.max(-1, p[0] * gain) * amp;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

/** Shade the clip's silent stretches (source sample ranges) so cuts can be placed by eye. */
export function drawSilences(ctx: CanvasRenderingContext2D, s: SilenceData, clip: Clip, rate: number, view: View, box: ClipBox, color: string): void {
  const speed = clip.speed.num / clip.speed.den;
  const srcStart = clip.sourceIn;
  const srcEnd = clip.sourceIn + clip.duration * speed;
  ctx.fillStyle = color;
  for (const r of s.ranges) {
    const a = (r.start / s.sampleRate) * rate;
    const b = (r.end / s.sampleRate) * rate;
    if (b <= srcStart) continue;
    if (a >= srcEnd) break;
    const t0 = clip.start + (Math.max(a, srcStart) - srcStart) / speed;
    const t1 = clip.start + (Math.min(b, srcEnd) - srcStart) / speed;
    const x0 = ticksToX(t0, rate, view);
    const x1 = ticksToX(t1, rate, view);
    if (x1 < 0 || x0 > view.width) continue;
    ctx.fillRect(x0, box.y, Math.max(1, x1 - x0), box.h);
  }
}
