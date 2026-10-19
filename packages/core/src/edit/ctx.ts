import { EditError } from './errors';
import { findClip, findItem, findTrack, gridUnit } from './query';
import { type Clip, type EditEnv, type Sequence, type Track, type TrackItem, isClip } from './types';
import { frameTicks, roundTo, sampleTicks } from './units';
import type { Timebase } from './types';

/** Mutable working context for one operation (the sequence here is an Immer draft). */
export interface Ctx {
  seq: Sequence;
  env: EditEnv;
  tb: Timebase;
  frame: number;
  sample: number;
  /** Tracks whose invariants must be re-checked and re-sorted after the operation. */
  touched: Set<string>;
  /** Old link-group id → new id, so both halves of a cut group stay internally linked. */
  groupRemap: Map<string, string>;
  id(prefix: 'c' | 'p' | 't' | 'x' | 'e' | 'k' | 'g'): string;
}

export function makeCtx(seq: Sequence, env: EditEnv): Ctx {
  return {
    seq,
    env,
    tb: seq.timebase,
    frame: frameTicks(seq.timebase),
    sample: sampleTicks(seq.timebase),
    touched: new Set(),
    groupRemap: new Map(),
    id: (prefix) => `${prefix}${seq.nextId++}`,
  };
}

export const touch = (ctx: Ctx, trackId: string): void => void ctx.touched.add(trackId);

/**
 * Link groups as `groupId → clips`, built in ONE pass over the sequence. Looking a group up by scanning every clip
 * is O(n) per lookup (and each read goes through an Immer draft), which made ripple operations quadratic; callers
 * build this once per phase instead. Rebuild after changing group membership.
 */
export function linkIndex(ctx: Ctx): Map<string, Clip[]> {
  const index = new Map<string, Clip[]>();
  for (const t of ctx.seq.tracks) {
    for (const i of Object.values(t.items)) {
      if (!isClip(i) || !i.linkGroupId) continue;
      const list = index.get(i.linkGroupId);
      if (list) list.push(i);
      else index.set(i.linkGroupId, [i]);
    }
  }
  return index;
}

export function getTrack(ctx: Ctx, id: string): Track {
  const t = findTrack(ctx.seq, id);
  if (!t) throw new EditError('not_found', `No track "${id}".`, { trackId: id });
  return t;
}

export function getClip(ctx: Ctx, id: string): Clip {
  const c = findClip(ctx.seq, id);
  if (!c) throw new EditError('not_found', `No clip "${id}".`, { clipId: id });
  return c.clip;
}

export function getItem(ctx: Ctx, id: string): TrackItem {
  const i = findItem(ctx.seq, id);
  if (!i) throw new EditError('not_found', `No item "${id}".`, { itemId: id });
  return i.item;
}

export function requireUnlocked(track: Track): void {
  if (track.locked) throw new EditError('locked', `Track ${track.name} is locked.`, { trackId: track.id });
}

export const unitOf = (ctx: Ctx, track: Track): number => gridUnit(ctx.tb, track.kind);

export function snap(t: number, unit: number, mode: 'round' | 'floor' | 'ceil' = 'round'): number {
  return roundTo(t, unit, mode);
}

export function assertInt(n: unknown, what: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new EditError('invalid', `${what} must be an integer number of ticks.`, { value: n });
}
