import { current } from 'immer';
import { EditError } from './errors';
import type { Ctx } from './ctx';
import { itemEnd, sourceSpan, trackItems } from './query';
import { type Clip, type Sequence, type Track, type TrackItem, type Transition, isClip } from './types';

/** Handle media (ticks) available past each end of a clip, in timeline ticks. */
export function handles(ctx: Pick<Ctx, 'env'>, c: Clip): { head: number; tail: number } {
  const media = ctx.env.getMedia(c.mediaId);
  const speed = c.speed.num / c.speed.den;
  const head = Math.max(0, Math.floor(c.sourceIn / speed));
  if (!media || media.duration === null) return { head, tail: Number.POSITIVE_INFINITY };
  const tail = Math.max(0, Math.floor((media.duration - (c.sourceIn + sourceSpan(c.duration, c.speed))) / speed));
  return { head, tail };
}

/** Largest duration a transition can have between two adjacent clips, given their handles. */
export function maxTransitionDuration(ctx: Pick<Ctx, 'env'>, a: Clip, b: Clip, alignment: Transition['alignment']): number {
  const ha = handles(ctx, a);
  const hb = handles(ctx, b);
  const lenCap = Math.min(a.duration, b.duration) * 2; // a transition cannot outlast the shorter clip's half
  switch (alignment) {
    case 'center':
      return Math.min(2 * Math.min(ha.tail, hb.head), lenCap);
    case 'start':
      return Math.min(ha.tail, b.duration, a.duration);
    case 'end':
      return Math.min(hb.head, a.duration, b.duration);
  }
}

function assertClipGeometry(ctx: Ctx, track: Track, c: Clip): void {
  const where = { clipId: c.id, trackId: track.id };
  for (const [k, v] of [['start', c.start], ['duration', c.duration], ['sourceIn', c.sourceIn]] as const) {
    if (!Number.isInteger(v)) throw new EditError('invalid', `Clip ${c.id} ${k} is not a whole number of ticks.`, where);
  }
  if (c.start < 0) throw new EditError('out_of_bounds', `Clip ${c.id} would start before the timeline origin.`, where);
  if (c.duration <= 0) throw new EditError('invalid', `Clip ${c.id} would have no length.`, where);
  // Video-like clips live on whole frames. Audio only needs whole ticks (≤ 1/5 sample at 29.97 fps): audio
  // edits are sample-accurate when made on their own, and follow linked video exactly rather than re-rounding.
  if (track.kind !== 'audio' && (c.start % ctx.frame !== 0 || c.duration % ctx.frame !== 0)) {
    throw new EditError('grid', `Clip ${c.id} is not aligned to the frame grid.`, { ...where, start: c.start, duration: c.duration, unit: ctx.frame });
  }
  if (c.speed.num <= 0 || c.speed.den <= 0) throw new EditError('invalid', `Clip ${c.id} has an invalid speed.`, where);
  const media = ctx.env.getMedia(c.mediaId);
  if (!media) throw new EditError('not_found', `Clip ${c.id} references unknown media "${c.mediaId}".`, where);
  if (c.sourceIn < 0) throw new EditError('out_of_bounds', `Clip ${c.id} would start before the beginning of its media.`, where);
  if (media.duration !== null && c.sourceIn + sourceSpan(c.duration, c.speed) > media.duration) {
    throw new EditError('out_of_bounds', `Clip ${c.id} would run past the end of its media.`, where);
  }
}

/**
 * Post-operation safety net, run on every track an operation touched: enforce geometry (whole ticks, grid, media
 * bounds), forbid overlaps, clamp or drop transitions that lost their handles, and tidy links. Violations throw —
 * the draft is discarded and the sequence is unchanged.
 *
 * Reads come from a plain snapshot of the draft (`current`), which avoids creating an Immer proxy per clip; writes
 * go back to the draft by id, and only when something really needs fixing, so patches stay minimal.
 */
export function normalize(ctx: Ctx): void {
  const snap = current(ctx.seq) as Sequence;
  const draftTracks = new Map(ctx.seq.tracks.map((t) => [t.id, t]));

  for (const trackId of ctx.touched) {
    const track = snap.tracks.find((t) => t.id === trackId);
    const draftTrack = draftTracks.get(trackId);
    if (!track || !draftTrack) continue; // deleted track
    const items = trackItems(track);
    let prev: TrackItem | undefined;
    for (const item of items) {
      if (item.trackId !== track.id) draftTrack.items[item.id]!.trackId = track.id;
      if (isClip(item)) {
        if (track.kind === 'caption') throw new EditError('kind_mismatch', `Clips cannot live on caption track ${track.name}.`, { trackId: track.id });
        assertClipGeometry(ctx, track, item);
        const media = ctx.env.getMedia(item.mediaId)!;
        if (track.kind === 'video' && !media.hasVideo && media.kind !== 'image') throw new EditError('kind_mismatch', `${track.name} cannot hold audio-only media ${media.id}.`, { clipId: item.id });
        if (track.kind === 'audio' && !media.hasAudio) throw new EditError('kind_mismatch', `${track.name} cannot hold media without audio (${media.id}).`, { clipId: item.id });
      } else {
        if (track.kind !== 'caption') throw new EditError('kind_mismatch', `Captions can only live on caption tracks.`, { trackId: track.id });
        if (!Number.isInteger(item.start) || !Number.isInteger(item.duration) || item.duration <= 0 || item.start < 0) throw new EditError('invalid', `Caption ${item.id} has invalid timing.`, { itemId: item.id });
        if (item.start % ctx.frame !== 0 || item.duration % ctx.frame !== 0) throw new EditError('grid', `Caption ${item.id} is not frame-aligned.`, { itemId: item.id });
      }
      if (prev && itemEnd(prev) > item.start) {
        throw new EditError('overlap', `${item.id} overlaps ${prev.id} on ${track.name}.`, { trackId: track.id, a: prev.id, b: item.id });
      }
      prev = item;
    }
    normalizeTransitions(ctx, track, draftTrack);
  }
  pruneLinkGroups(snap, draftTracks);
  if (snap.markers.some((m, i) => i > 0 && (snap.markers[i - 1]!.time > m.time || (snap.markers[i - 1]!.time === m.time && snap.markers[i - 1]!.id > m.id)))) {
    ctx.seq.markers.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
  }
}

function normalizeTransitions(ctx: Ctx, track: Track, draft: Track): void {
  if (track.transitions.length === 0) return;
  const unit = track.kind === 'audio' ? ctx.sample : ctx.frame;
  const drop = new Set<string>();
  const clamp = new Map<string, number>();
  for (const tr of track.transitions) {
    const a = track.items[tr.betweenClipIds[0]];
    const b = track.items[tr.betweenClipIds[1]];
    if (!a || !b || !isClip(a) || !isClip(b) || itemEnd(a) !== b.start) {
      drop.add(tr.id); // clips gone, moved apart or reordered
      continue;
    }
    const cap = Math.floor(maxTransitionDuration(ctx, a, b, tr.alignment) / unit) * unit;
    const duration = Math.min(tr.duration, cap);
    if (duration < unit) drop.add(tr.id);
    else if (duration !== tr.duration) clamp.set(tr.id, duration);
  }
  if (!drop.size && !clamp.size) return;
  draft.transitions = draft.transitions.filter((t) => !drop.has(t.id));
  for (const t of draft.transitions) {
    const d = clamp.get(t.id);
    if (d !== undefined) t.duration = d;
  }
}

/** Drop link-group ids that no longer join two clips. */
function pruneLinkGroups(snap: Sequence, draftTracks: Map<string, Track>): void {
  const count = new Map<string, number>();
  for (const t of snap.tracks) for (const i of Object.values(t.items)) if (isClip(i) && i.linkGroupId) count.set(i.linkGroupId, (count.get(i.linkGroupId) ?? 0) + 1);
  for (const t of snap.tracks) {
    for (const i of Object.values(t.items)) {
      if (isClip(i) && i.linkGroupId && (count.get(i.linkGroupId) ?? 0) < 2) delete (draftTracks.get(t.id)!.items[i.id] as Clip).linkGroupId;
    }
  }
}
