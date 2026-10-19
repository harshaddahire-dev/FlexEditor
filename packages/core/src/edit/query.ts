import { isDraft } from 'immer';
import { frameTicks, sampleTicks } from './units';
import { type CaptionItem, type Clip, type Sequence, type TrackItem, type Track, type TrackKind, type Timebase, type Ticks, isClip } from './types';

export const itemEnd = (i: Pick<TrackItem, 'start' | 'duration'>): Ticks => i.start + i.duration;

const byTime = (a: TrackItem, b: TrackItem): number => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortedCache = new WeakMap<object, TrackItem[]>();

/**
 * A track's items in timeline order. Memoised per immutable state (a frozen `items` map), so UI renders and
 * repeated queries are free; recomputed for drafts, which change under our feet.
 */
export function trackItems(track: Pick<Track, 'items'>): TrackItem[] {
  const map = track.items;
  const cacheable = !isDraft(map);
  if (cacheable) {
    const hit = sortedCache.get(map);
    if (hit) return hit;
  }
  const list = Object.values(map).sort(byTime);
  if (cacheable) sortedCache.set(map, list);
  return list;
}

export const trackClips = (track: Pick<Track, 'items'>): Clip[] => trackItems(track).filter(isClip);
export const itemCount = (track: Pick<Track, 'items'>): number => Object.keys(track.items).length;

export function findTrack(seq: Sequence, id: string): Track | undefined {
  return seq.tracks.find((t) => t.id === id);
}

export interface ItemLoc {
  track: Track;
  item: TrackItem;
}

export function findItem(seq: Sequence, id: string): ItemLoc | undefined {
  for (const track of seq.tracks) {
    const item = track.items[id];
    if (item) return { track, item };
  }
  return undefined;
}

export function findClip(seq: Sequence, id: string): { track: Track; clip: Clip } | undefined {
  const loc = findItem(seq, id);
  return loc && isClip(loc.item) ? { track: loc.track, clip: loc.item } : undefined;
}

export function allClips(seq: Sequence): Clip[] {
  const out: Clip[] = [];
  for (const t of seq.tracks) for (const i of Object.values(t.items)) if (isClip(i)) out.push(i);
  return out;
}

export function allCaptions(seq: Sequence): CaptionItem[] {
  const out: CaptionItem[] = [];
  for (const t of seq.tracks) for (const i of Object.values(t.items)) if (i.kind === 'caption') out.push(i);
  return out;
}

/** The clip plus every clip sharing its link group (in track order). */
export function linkGroup(seq: Sequence, clip: Clip): Clip[] {
  if (!clip.linkGroupId) return [clip];
  return allClips(seq).filter((c) => c.linkGroupId === clip.linkGroupId);
}

/** Edit grid of a track kind: audio edits are sample-accurate, everything else is frame-accurate. */
export function gridUnit(tb: Timebase, kind: TrackKind): number {
  return kind === 'audio' ? sampleTicks(tb) : frameTicks(tb);
}

export const speedValue = (c: Pick<Clip, 'speed'>): number => c.speed.num / c.speed.den;

/** Source ticks consumed by `duration` timeline ticks at `speed` (whole ticks). */
export function sourceSpan(duration: Ticks, speed: { num: number; den: number }): Ticks {
  return Math.round((duration * speed.num) / speed.den);
}

export const clipSourceOut = (c: Clip): Ticks => c.sourceIn + sourceSpan(c.duration, c.speed);

/** Media tick that plays at timeline tick `t`. */
export const sourceAt = (c: Clip, t: Ticks): Ticks => c.sourceIn + sourceSpan(t - c.start, c.speed);

/**
 * Where media time 0 would sit on the timeline. Two clips of the same media are in sync when this matches;
 * returned as a float of ticks (exact when both speeds are 1).
 */
export function mapOffset(c: Clip): number {
  return c.start - (c.sourceIn * c.speed.den) / c.speed.num;
}

/** Signed difference of mapping offsets in ticks (0 = in sync). */
export function syncDelta(a: Clip, b: Clip): number {
  return mapOffset(a) - mapOffset(b);
}

/** True when `b` continues `a` seamlessly: same media, butt-jointed and no discontinuity in the source mapping. */
export function isContinuous(a: Clip, b: Clip): boolean {
  if (a.mediaId !== b.mediaId || itemEnd(a) !== b.start) return false;
  if (a.speed.num !== b.speed.num || a.speed.den !== b.speed.den) return false;
  return Math.abs(syncDelta(a, b)) < 1;
}

/** Items of `track` strictly overlapping [start, end) other than those in `except`. */
export function overlapping(track: Track, start: Ticks, end: Ticks, except?: ReadonlySet<string>): TrackItem[] {
  return trackItems(track).filter((i) => !except?.has(i.id) && i.start < end && itemEnd(i) > start);
}

export function previousAdjacent(track: Track, item: TrackItem): TrackItem | undefined {
  return trackItems(track).find((i) => i.id !== item.id && itemEnd(i) === item.start);
}

export function nextAdjacent(track: Track, item: TrackItem): TrackItem | undefined {
  return trackItems(track).find((i) => i.id !== item.id && i.start === itemEnd(item));
}

export function sequenceDuration(seq: Sequence): Ticks {
  let end = 0;
  for (const t of seq.tracks) for (const i of Object.values(t.items)) end = Math.max(end, itemEnd(i));
  return end;
}
