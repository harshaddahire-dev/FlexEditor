import type { Rational } from '@cutroom/core';
import { toNumber } from '@cutroom/core';
import { runText } from '../proc';

export interface FilmstripMeta {
  /** Seconds between thumbnails. */
  interval: number;
  thumbW: number;
  thumbH: number;
  cols: number;
  rows: number;
  count: number;
}

const COLS = 20;
const THUMB_H = 90;
const MAX_TILES = 240;

export function planFilmstrip(duration: Rational, width: number, height: number): FilmstripMeta {
  const seconds = Math.max(toNumber(duration), 0.001);
  const interval = Math.max(1, seconds / MAX_TILES);
  const count = Math.max(1, Math.ceil(seconds / interval));
  const thumbW = Math.max(2, Math.round((THUMB_H * width) / height / 2) * 2);
  return { interval, thumbW, thumbH: THUMB_H, cols: Math.min(COLS, count), rows: Math.ceil(count / COLS), count };
}

/** A single sprite sheet of evenly spaced thumbnails, drawn on timeline clips. */
export async function generateFilmstrip(ffmpeg: string, proxy: string, out: string, plan: FilmstripMeta, signal?: AbortSignal): Promise<void> {
  const vf = `fps=1/${plan.interval},scale=${plan.thumbW}:${plan.thumbH},tile=${plan.cols}x${plan.rows}:padding=0:margin=0`;
  const r = await runText(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-i', proxy, '-an', '-vf', vf, '-frames:v', '1', '-q:v', '5', out], { signal });
  if (r.code !== 0) throw new Error(`filmstrip failed: ${r.stderr.trim().split('\n').pop() ?? ''}`);
}
