import { type Clip, type Sequence, type Track, type TrackItem, framesToTimecode, frameTicks, isClip, itemEnd, trackItems } from '@cutroom/core';

/**
 * Pure timeline maths: time ↔ pixel, track layout, ruler ticks, hit testing, snapping. No DOM, no canvas — so it is
 * unit-tested, and the renderer and the pointer handlers cannot disagree about where things are.
 */

export const HEADER_W = 148;
export const RULER_H = 26;
export const EDGE_PX = 7;
export const MIN_PPS = 0.5;
export const MAX_PPS = 20_000;

export interface View {
  /** Pixels per second of timeline. */
  pps: number;
  /** Pixels scrolled horizontally / vertically (content coordinates). */
  scrollX: number;
  scrollY: number;
  /** Visible size of the clip area, CSS pixels (excludes the track header column and the ruler). */
  width: number;
  height: number;
}

export interface TrackRow {
  track: Track;
  /** Content-space top (below the ruler). */
  y: number;
  h: number;
}

/** Display order, top to bottom: captions, graphics, video (V2 above V1), then audio (A1 first). */
export function displayOrder(seq: Sequence): Track[] {
  const of = (k: Track['kind']) => seq.tracks.filter((t) => t.kind === k);
  return [...of('caption').reverse(), ...of('graphics').reverse(), ...of('video').reverse(), ...of('audio')];
}

export function trackRows(seq: Sequence): TrackRow[] {
  let y = 0;
  return displayOrder(seq).map((track) => {
    const row = { track, y, h: track.height };
    y += track.height + 1; // 1px separator
    return row;
  });
}

export const contentHeight = (rows: readonly TrackRow[]): number => (rows.length ? rows[rows.length - 1]!.y + rows[rows.length - 1]!.h : 0);

export const ticksToX = (t: number, rate: number, v: View): number => (t / rate) * v.pps - v.scrollX;
export const xToTicks = (x: number, rate: number, v: View): number => ((x + v.scrollX) / v.pps) * rate;

export function clampView(v: View, durationTicks: number, rate: number, contentH: number): View {
  const totalPx = (durationTicks / rate) * v.pps + v.width * 0.5; // leave room to place clips past the end
  const maxX = Math.max(0, totalPx - v.width);
  const maxY = Math.max(0, contentH - v.height);
  return { ...v, scrollX: Math.min(maxX, Math.max(0, v.scrollX)), scrollY: Math.min(maxY, Math.max(0, v.scrollY)) };
}

/** Zoom keeping the time under `focusX` fixed. */
export function zoomAt(v: View, focusX: number, factor: number): View {
  const pps = Math.min(MAX_PPS, Math.max(MIN_PPS, v.pps * factor));
  const timeAtFocus = (focusX + v.scrollX) / v.pps;
  return { ...v, pps, scrollX: Math.max(0, timeAtFocus * pps - focusX) };
}

/** A view that shows the whole sequence (with a little margin). */
export function fitView(seq: Sequence, durationTicks: number, v: View): View {
  const seconds = Math.max(1, durationTicks / seq.timebase.rate);
  const pps = Math.min(MAX_PPS, Math.max(MIN_PPS, (v.width * 0.94) / seconds));
  return { ...v, pps, scrollX: 0 };
}

/* ------------------------------------------------------------------------ ruler */

const STEPS_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export interface RulerTick {
  x: number;
  ticks: number;
  label?: string;
}

/** Major (labelled) and minor tick positions for the visible range, adapting to zoom (frames → hours). */
export function rulerTicks(seq: Sequence, v: View, minMajorPx = 96): { major: RulerTick[]; minor: RulerTick[] } {
  const { rate, fps } = seq.timebase;
  const frame = frameTicks(seq.timebase);
  const fpsN = fps.num / fps.den;
  const framePx = (frame / rate) * v.pps;
  // candidate steps in ticks: whole frames while frames are wide enough, then seconds and up
  const candidates: number[] = [];
  for (const f of [1, 2, 5, 10]) if (f < fpsN) candidates.push(f * frame);
  for (const s of STEPS_SECONDS) candidates.push(s * rate);
  const step = candidates.find((c) => (c / rate) * v.pps >= minMajorPx) ?? candidates[candidates.length - 1]!;
  const subdivisions = step / frame <= 10 && step >= frame * 2 ? Math.round(step / frame) : 5;
  const minorStep = step / subdivisions;

  const t0 = Math.max(0, Math.floor(xToTicks(0, rate, v) / step) * step);
  const t1 = xToTicks(v.width, rate, v);
  const major: RulerTick[] = [];
  const minor: RulerTick[] = [];
  for (let t = t0; t <= t1 + step; t += step) {
    const x = ticksToX(t, rate, v);
    major.push({ x, ticks: t, label: framesToTimecode(Math.round(t / frame), fps) });
    if (minorStep * (v.pps / rate) >= 4 && (minorStep >= frame || framePx >= 4)) {
      for (let k = 1; k < subdivisions; k++) minor.push({ x: ticksToX(t + k * minorStep, rate, v), ticks: t + k * minorStep });
    }
  }
  return { major, minor };
}

/* ------------------------------------------------------------------- hit testing */

export type Hit =
  | { kind: 'ruler'; ticks: number }
  | { kind: 'clip'; item: TrackItem; track: Track; part: 'body' | 'start' | 'end'; ticks: number }
  | { kind: 'lane'; track: Track; ticks: number }
  | { kind: 'marker'; markerId: string }
  | { kind: 'none' };

/** Index of the first item whose end is after `t` (items are sorted and non-overlapping). */
function firstEndingAfter(items: readonly TrackItem[], t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (itemEnd(items[mid]!) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Items overlapping [t0, t1] — binary search, so a 5,000-clip track costs O(log n + visible). */
export function visibleItems(track: Track, t0: number, t1: number): TrackItem[] {
  const items = trackItems(track);
  const out: TrackItem[] = [];
  for (let i = firstEndingAfter(items, t0); i < items.length && items[i]!.start < t1; i++) out.push(items[i]!);
  return out;
}

/** What is under the pointer at (x, y)? `x` is relative to the clip area (right of the header), `y` to the area below the ruler. */
export function hitTest(seq: Sequence, v: View, x: number, y: number, rows = trackRows(seq)): Hit {
  const { rate } = seq.timebase;
  const ticks = xToTicks(x, rate, v);
  if (y < 0) {
    for (const m of seq.markers) if (Math.abs(ticksToX(m.time, rate, v) - x) <= 6) return { kind: 'marker', markerId: m.id };
    return { kind: 'ruler', ticks };
  }
  const cy = y + v.scrollY;
  const row = rows.find((r) => cy >= r.y && cy < r.y + r.h);
  if (!row) return { kind: 'none' };
  const hit = visibleItems(row.track, ticks - 1, ticks + 1).find((i) => i.start <= ticks && ticks < itemEnd(i));
  // grab handles: pick an edge when the pointer is within EDGE_PX of one, even from just outside the clip
  const near = visibleItems(row.track, ticks - (EDGE_PX / v.pps) * rate - 1, ticks + (EDGE_PX / v.pps) * rate + 1);
  let edge: Hit | undefined;
  let best = EDGE_PX + 1;
  for (const i of near) {
    const w = (i.duration / rate) * v.pps;
    for (const part of ['start', 'end'] as const) {
      const ex = ticksToX(part === 'start' ? i.start : itemEnd(i), rate, v);
      // at a butt cut two edges coincide: the one belonging to the clip the pointer is over wins the tie
      const d = Math.abs(ex - x) - (i.start <= ticks && ticks < itemEnd(i) ? 0.001 : 0);
      // very short clips: only the nearer half of the clip is an edge so the body stays grabbable
      const insideOk = w >= EDGE_PX * 3 || (part === 'start' ? x <= ticksToX(i.start, rate, v) + w / 2 : x >= ticksToX(itemEnd(i), rate, v) - w / 2);
      if (d < best && insideOk) {
        best = d;
        edge = { kind: 'clip', item: i, track: row.track, part, ticks };
      }
    }
  }
  if (edge) return edge;
  if (hit) return { kind: 'clip', item: hit, track: row.track, part: 'body', ticks };
  return { kind: 'lane', track: row.track, ticks };
}

/* ----------------------------------------------------------------------- snapping */

/** Every position a drag may snap to: clip edges on all tracks, markers, the playhead, 0. */
export function snapPoints(seq: Sequence, playhead: number, extra: readonly number[] = [], exclude?: ReadonlySet<string>): number[] {
  const pts = new Set<number>([0, playhead, ...extra]);
  for (const t of seq.tracks) {
    for (const i of Object.values(t.items)) {
      if (exclude?.has(i.id)) continue;
      pts.add(i.start);
      pts.add(itemEnd(i));
    }
  }
  for (const m of seq.markers) pts.add(m.time);
  return [...pts].sort((a, b) => a - b);
}

/** Nearest snap point within `thresholdPx`, or the input unchanged. `points` must be sorted. */
export function snapTicks(t: number, points: readonly number[], rate: number, pps: number, thresholdPx = 8): { ticks: number; snappedTo: number | null } {
  const thr = (thresholdPx / pps) * rate;
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  for (const i of [lo - 1, lo]) {
    const p = points[i];
    if (p !== undefined && Math.abs(p - t) <= thr && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
  }
  return best === null ? { ticks: t, snappedTo: null } : { ticks: best, snappedTo: best };
}

/** Round to the frame grid (video) — used when a drag has no snap target. */
export const snapToFrame = (t: number, seq: Sequence): number => {
  const f = frameTicks(seq.timebase);
  return Math.round(t / f) * f + 0;
};

export const clipAt = (seq: Sequence, trackId: string, ticks: number): Clip | undefined => {
  const track = seq.tracks.find((t) => t.id === trackId);
  return track ? trackItems(track).filter(isClip).find((c) => c.start <= ticks && ticks < itemEnd(c)) : undefined;
};
