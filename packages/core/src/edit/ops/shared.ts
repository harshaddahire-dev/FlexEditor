import { EditError } from '../errors';
import { type Ctx, getClip, getTrack, linkIndex, requireUnlocked, touch } from '../ctx';
import { windowKeyframes } from '../keyframes';
import { itemEnd, speedValue, trackItems } from '../query';
import { type Clip, type Track, type TrackItem, type Ticks, isClip } from '../types';

/** Clips an op applies to: the clip, plus its link group when `linked`. Primary first, no duplicates. */
export function members(ctx: Ctx, clipIds: readonly string[], linked: boolean): Clip[] {
  const out: Clip[] = [];
  const seen = new Set<string>();
  const groups = linked ? linkIndex(ctx) : undefined;
  for (const id of clipIds) {
    const c = getClip(ctx, id);
    const group = (c.linkGroupId && groups?.get(c.linkGroupId)) || [c];
    for (const m of [c, ...group.filter((x) => x.id !== c.id)]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
  }
  return out;
}

/**
 * Common grid for a set of clips that must move together: frames if any of them lives on a frame-grid track
 * (so video never lands between frames), otherwise samples.
 */
export function groupUnit(ctx: Ctx, clips: readonly Clip[]): number {
  let unit = ctx.sample;
  for (const c of clips) if (getTrack(ctx, c.trackId).kind !== 'audio') unit = ctx.frame;
  return unit;
}

const srcDelta = (ticks: number, c: Pick<Clip, 'speed'>): number => Math.round(ticks * speedValue(c));

/**
 * Re-cut an item so it covers [newStart, newEnd) while keeping its timeline→source mapping unchanged: the same
 * media time still plays at the same timeline time, only the visible window changes. Positions are applied
 * exactly — callers snap the *requested* time (or delta) to the right grid first — which is what keeps linked
 * clips bit-for-bit in sync. Keyframes, fades and caption words follow the window.
 */
export function setItemEdges(ctx: Ctx, item: TrackItem, newStart: Ticks, newEnd: Ticks): void {
  if (!Number.isInteger(newStart) || !Number.isInteger(newEnd)) throw new EditError('invalid', `Item ${item.id} edges must be whole ticks.`, { itemId: item.id, newStart, newEnd });
  if (newEnd <= newStart) throw new EditError('invalid', `Item ${item.id} would have no length.`, { itemId: item.id, start: newStart, end: newEnd });
  touch(ctx, item.trackId);
  const oldStart = item.start;

  if (isClip(item)) {
    const from = newStart - oldStart;
    const to = newEnd - oldStart;
    for (const prop of Object.keys(item.keyframes)) {
      const kfs = windowKeyframes(item.keyframes[prop]!, from, to);
      if (kfs.length) item.keyframes[prop] = kfs;
      else delete item.keyframes[prop];
    }
    item.sourceIn += srcDelta(newStart - oldStart, item);
    item.start = newStart;
    item.duration = newEnd - newStart;
    item.audio.fadeIn = Math.min(item.audio.fadeIn, item.duration);
    item.audio.fadeOut = Math.min(item.audio.fadeOut, item.duration - item.audio.fadeIn);
  } else {
    // captions: keep words whose midpoint survives, clamped to the new window
    item.words = item.words
      .filter((w) => (w.start + w.end) / 2 >= newStart && (w.start + w.end) / 2 < newEnd)
      .map((w) => ({ ...w, start: Math.max(w.start, newStart), end: Math.min(w.end, newEnd) }));
    item.start = newStart;
    item.duration = newEnd - newStart;
  }
}

/** Move an item along the timeline by exactly `delta` ticks (its media moves with it). */
export function shiftItem(ctx: Ctx, item: TrackItem, delta: Ticks): void {
  if (delta === 0) return;
  touch(ctx, item.trackId);
  if (!isClip(item)) {
    for (const w of item.words) {
      w.start += delta;
      w.end += delta;
    }
  }
  item.start += delta;
}

/**
 * Shift many items at once, closed under link groups: a clip's linked partners move by the same amount even when
 * they sit on tracks the operation did not select, so ripples can never leave linked A/V out of step. Two different
 * amounts for clips of one group would break sync, so that is rejected instead.
 */
export function shiftMany(ctx: Ctx, entries: ReadonlyArray<readonly [TrackItem, number]>): void {
  const delta = new Map<string, number>();
  const item = new Map<string, TrackItem>();
  const queue: string[] = [];
  const put = (it: TrackItem, d: number, via?: string): void => {
    const known = delta.get(it.id);
    if (known === undefined) {
      delta.set(it.id, d);
      item.set(it.id, it);
      queue.push(it.id);
    } else if (known !== d) {
      throw new EditError('invalid', `Shifting ${via ?? it.id} and its linked clip ${it.id} by different amounts would break their sync.`, { a: via, b: it.id, deltas: [known, d] });
    }
  };
  for (const [it, d] of entries) put(it, d);
  const groups = linkIndex(ctx);
  while (queue.length) {
    const id = queue.pop()!;
    const it = item.get(id)!;
    if (isClip(it) && it.linkGroupId) for (const m of groups.get(it.linkGroupId) ?? []) put(m, delta.get(id)!, id);
  }
  for (const [id, d] of delta) {
    const it = item.get(id)!;
    requireUnlocked(getTrack(ctx, it.trackId));
    shiftItem(ctx, it, d);
  }
}

/** Deep copy of an item under a new id (draft-safe). */
export function cloneItem<T extends TrackItem>(item: T, id: string): T {
  const copy = JSON.parse(JSON.stringify(item)) as T;
  copy.id = id;
  return copy;
}

export function insertItem(ctx: Ctx, track: Track, item: TrackItem): void {
  track.items[item.id] = item;
  item.trackId = track.id;
  touch(ctx, track.id);
}

export function removeItem(ctx: Ctx, trackId: string, itemId: string): void {
  const track = getTrack(ctx, trackId);
  delete track.items[itemId];
  touch(ctx, trackId);
}

/** Link-group id for the right-hand pieces created while cutting group `old` (shared across tracks in one op). */
export function remapGroup(ctx: Ctx, old: string | undefined): string | undefined {
  if (!old) return undefined;
  let g = ctx.groupRemap.get(old);
  if (!g) {
    g = ctx.id('g');
    ctx.groupRemap.set(old, g);
  }
  return g;
}

/** Split `item` at `at` (strictly inside). The left part keeps the id; returns the new right part, inserted after it. */
export function splitItemAt(ctx: Ctx, track: Track, item: TrackItem, at: Ticks, regroup: boolean): TrackItem {
  const oldEnd = itemEnd(item);
  const right = cloneItem(item, ctx.id(isClip(item) ? 'c' : 'p'));
  if (isClip(item) && isClip(right)) {
    if (regroup) right.linkGroupId = remapGroup(ctx, item.linkGroupId);
    // the internal cut carries no fade
    const { fadeIn, fadeOut } = item.audio;
    setItemEdges(ctx, item, item.start, at);
    setItemEdges(ctx, right, at, oldEnd);
    item.audio.fadeIn = Math.min(fadeIn, item.duration);
    item.audio.fadeOut = 0;
    right.audio.fadeIn = 0;
    right.audio.fadeOut = Math.min(fadeOut, right.duration);
  } else {
    setItemEdges(ctx, item, item.start, at);
    setItemEdges(ctx, right, at, oldEnd);
  }
  // a transition that ended at the old out-point now belongs to the right part
  for (const tr of track.transitions) if (tr.betweenClipIds[0] === item.id) tr.betweenClipIds[0] = right.id;
  track.items[right.id] = right;
  touch(ctx, track.id);
  return right;
}

/**
 * Empty [start, end) on one track: items inside are removed, items crossing an edge are trimmed, and an item
 * crossing both edges is split in two. Items in `except` are left alone.
 */
export function carve(ctx: Ctx, track: Track, start: Ticks, end: Ticks, except?: ReadonlySet<string>, regroup = false): void {
  requireUnlocked(track);
  for (const item of trackItems(track)) {
    if (except?.has(item.id)) continue;
    const s = item.start;
    const e = itemEnd(item);
    if (e <= start || s >= end) continue;
    if (s >= start && e <= end) removeItem(ctx, track.id, item.id);
    else if (s < start && e > end) {
      const right = splitItemAt(ctx, track, item, start, regroup);
      setItemEdges(ctx, right, end, itemEnd(right));
    } else if (s < start) setItemEdges(ctx, item, s, start);
    else setItemEdges(ctx, item, end, e);
  }
  touch(ctx, track.id);
}

