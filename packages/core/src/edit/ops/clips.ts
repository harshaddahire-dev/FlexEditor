import { EditError } from '../errors';
import { type Ctx, getClip, getTrack, requireUnlocked, snap, touch } from '../ctx';
import { scaleKeyframeTimes } from '../keyframes';
import { itemEnd, nextAdjacent, sourceSpan, trackItems } from '../query';
import { buildClip } from '../sequence';
import { type Clip, type TrackItem, type Ticks, isClip } from '../types';
import type { NewClip, OpOf } from '../schema';
import {
  carve,
  groupUnit,
  insertItem,
  members,
  removeItem,
  setItemEdges,
  shiftItem,
  shiftMany,
  splitItemAt,
} from './shared';

/* ------------------------------------------------------------------ creating clips */

interface Planned {
  clip: Clip;
  label: string | undefined;
}

/**
 * Turn NewClip requests into clips placed exactly at `at`. Clips sharing a `link` label get the same length
 * (frame grid when any of them is on a video track) and one link group, so they start and end together.
 */
function plan(ctx: Ctx, specs: readonly NewClip[], at: Ticks): { planned: Planned[]; at: Ticks } {
  const byLabel = new Map<string, NewClip[]>();
  for (const s of specs) if (s.link) byLabel.set(s.link, [...(byLabel.get(s.link) ?? []), s]);

  const kinds = specs.map((s) => getTrack(ctx, s.trackId).kind);
  const anyFrame = kinds.some((k) => k !== 'audio');
  const planAt = snap(at, anyFrame ? ctx.frame : ctx.sample);
  const groupIds = new Map<string, string>();
  const planned: Planned[] = [];

  for (const s of specs) {
    const track = getTrack(ctx, s.trackId);
    requireUnlocked(track);
    if (track.kind === 'caption') throw new EditError('kind_mismatch', 'Clips cannot be placed on a caption track.', { trackId: track.id });
    if (!ctx.env.getMedia(s.mediaId)) throw new EditError('not_found', `Unknown media "${s.mediaId}".`, { mediaId: s.mediaId });
    const speed = s.speed ?? { num: 1, den: 1 };
    const sourceLen = s.sourceOut - s.sourceIn;
    if (sourceLen <= 0) throw new EditError('invalid', 'sourceOut must be after sourceIn.', { mediaId: s.mediaId });

    const peers = s.link ? byLabel.get(s.link)! : [s];
    const peerUnit = peers.some((p) => getTrack(ctx, p.trackId).kind !== 'audio') ? ctx.frame : ctx.sample;
    const duration = Math.max(peerUnit, snap(Math.round((sourceLen * speed.den) / speed.num), peerUnit));

    let groupId: string | undefined;
    if (s.link && peers.length > 1) {
      groupId = groupIds.get(s.link);
      if (!groupId) groupIds.set(s.link, (groupId = ctx.id('g')));
    }
    const origin = (s.createdBy ?? 'user') as Clip['createdBy'];
    planned.push({
      label: s.link,
      clip: buildClip(ctx.id('c'), {
        mediaId: s.mediaId,
        trackId: track.id,
        start: planAt,
        duration,
        sourceIn: s.sourceIn,
        speed,
        name: s.name,
        linkGroupId: groupId,
        createdBy: origin,
        accepted: origin === 'user',
      }),
    });
  }
  return { planned, at: planAt };
}

export function insert(ctx: Ctx, op: OpOf<'insert'>): void {
  const targets = new Set(op.clips.map((c) => c.trackId));
  const rippled = ctx.seq.tracks.filter((t) => (op.ripple === 'all' ? !t.locked || targets.has(t.id) : targets.has(t.id)));
  // one grid for the whole ripple: frames if any rippled track is video-like, so video never lands between frames
  const unit = rippled.some((t) => t.kind !== 'audio') ? ctx.frame : ctx.sample;
  const at = snap(op.at, unit);
  const { planned } = plan(ctx, op.clips, at);
  const D = Math.ceil(Math.max(...planned.map((p) => p.clip.duration)) / unit) * unit;

  // make room: split what straddles the insertion point, then push everything at/after it
  for (const track of rippled) {
    requireUnlocked(track);
    for (const item of trackItems(track)) {
      if (item.start < at && itemEnd(item) > at) splitItemAt(ctx, track, item, at, true);
    }
  }
  shiftMany(ctx, rippled.flatMap((track) => trackItems(track).filter((item) => item.start >= at).map((item) => [item, D] as const)));
  for (const m of ctx.seq.markers) if (m.time >= at) m.time += D;
  for (const p of planned) insertItem(ctx, getTrack(ctx, p.clip.trackId), p.clip);
}

export function overwrite(ctx: Ctx, op: OpOf<'overwrite'>): void {
  const { planned } = plan(ctx, op.clips, op.at);
  for (const p of planned) {
    const track = getTrack(ctx, p.clip.trackId);
    carve(ctx, track, p.clip.start, itemEnd(p.clip));
  }
  for (const p of planned) insertItem(ctx, getTrack(ctx, p.clip.trackId), p.clip);
}

/* --------------------------------------------------------------------- cutting */

export function split(ctx: Ctx, op: OpOf<'split'>): void {
  const primary = getClip(ctx, op.clipId);
  const group = members(ctx, [op.clipId], op.linked);
  const t = snap(op.at, groupUnit(ctx, group));
  if (!(primary.start < t && t < itemEnd(primary))) {
    throw new EditError('out_of_bounds', `Split point is not inside clip ${primary.id}.`, { clipId: primary.id, at: t, start: primary.start, end: itemEnd(primary) });
  }
  for (const m of group) {
    if (!(m.start < t && t < itemEnd(m))) continue; // a linked clip that does not span the cut stays whole
    const track = getTrack(ctx, m.trackId);
    requireUnlocked(track);
    splitItemAt(ctx, track, m, t, group.length > 1);
  }
}

export function trim(ctx: Ctx, op: OpOf<'trim'>): void {
  const group = members(ctx, [op.clipId], op.linked);
  const primary = group[0]!;
  const delta = snap(op.to - (op.edge === 'start' ? primary.start : itemEnd(primary)), groupUnit(ctx, group));
  for (const m of group) {
    requireUnlocked(getTrack(ctx, m.trackId));
    if (op.edge === 'start') setItemEdges(ctx, m, m.start + delta, itemEnd(m));
    else setItemEdges(ctx, m, m.start, itemEnd(m) + delta);
  }
}

/** Items that start at/after `from` on `trackId` (except `skip`), each paired with `delta`. */
function laterItems(ctx: Ctx, trackId: string, from: Ticks, delta: Ticks, skip: ReadonlySet<string>): (readonly [TrackItem, number])[] {
  const track = getTrack(ctx, trackId);
  requireUnlocked(track);
  return trackItems(track).filter((item) => !skip.has(item.id) && item.start >= from).map((item) => [item, delta] as const);
}

export function rippleTrim(ctx: Ctx, op: OpOf<'rippleTrim'>): void {
  const group = members(ctx, [op.clipId], op.linked);
  const primary = group[0]!;
  const delta = snap(op.to - (op.edge === 'start' ? primary.start : itemEnd(primary)), groupUnit(ctx, group));
  if (delta === 0) return;
  const ids = new Set(group.map((g) => g.id));
  const anchor = itemEnd(primary);
  // how much later material moves: the clip grows/shrinks by `delta` at its tail, or loses `delta` at its head
  const change = op.edge === 'end' ? delta : -delta;
  const shifts: (readonly [TrackItem, number])[] = [];

  for (const m of group) {
    requireUnlocked(getTrack(ctx, m.trackId));
    const oldStart = m.start;
    const oldEnd = itemEnd(m);
    shifts.push(...laterItems(ctx, m.trackId, oldEnd, change, ids));
    if (op.edge === 'end') {
      setItemEdges(ctx, m, oldStart, oldEnd + delta);
    } else {
      setItemEdges(ctx, m, oldStart + delta, oldEnd);
      m.start = oldStart; // the content now begins where the clip used to begin
    }
  }

  const memberTracks = new Set(group.map((g) => g.trackId));
  const extra = op.rippleTracks === 'all' ? ctx.seq.tracks.filter((tr) => !tr.locked).map((tr) => tr.id) : (op.rippleTracks ?? []);
  for (const trackId of extra) if (!memberTracks.has(trackId)) shifts.push(...laterItems(ctx, trackId, anchor, change, ids));
  // one call: items reached through several tracks or link partners must only move once
  shiftMany(ctx, shifts);
}

export function rollTrim(ctx: Ctx, op: OpOf<'rollTrim'>): void {
  const left = getClip(ctx, op.leftClipId);
  const right = getClip(ctx, op.rightClipId);
  if (left.trackId !== right.trackId || itemEnd(left) !== right.start) {
    throw new EditError('not_adjacent', 'Roll trim needs two clips that touch on the same track.', { left: left.id, right: right.id });
  }
  const leftGroup = members(ctx, [left.id], op.linked);
  const rightIds = new Set(members(ctx, [right.id], op.linked).map((c) => c.id));
  const delta = snap(op.to - itemEnd(left), groupUnit(ctx, leftGroup));
  for (const l of leftGroup) {
    const track = getTrack(ctx, l.trackId);
    requireUnlocked(track);
    const r = nextAdjacent(track, l);
    if (!r || !isClip(r) || !rightIds.has(r.id)) continue;
    const cut = itemEnd(l) + delta;
    setItemEdges(ctx, l, l.start, cut);
    setItemEdges(ctx, r, cut, itemEnd(r));
  }
}

export function slip(ctx: Ctx, op: OpOf<'slip'>): void {
  const group = members(ctx, [op.clipId], op.linked);
  const d = snap(op.delta, groupUnit(ctx, group));
  for (const m of group) {
    requireUnlocked(getTrack(ctx, m.trackId));
    m.sourceIn += d;
    touch(ctx, m.trackId);
  }
}

export function slide(ctx: Ctx, op: OpOf<'slide'>): void {
  const group = members(ctx, [op.clipId], op.linked);
  const d = snap(op.delta, groupUnit(ctx, group));
  if (d === 0) return;
  for (const m of group) {
    const track = getTrack(ctx, m.trackId);
    requireUnlocked(track);
    const sorted = trackItems(track);
    const prev = sorted.find((i) => itemEnd(i) === m.start && i.id !== m.id);
    const next = sorted.find((i) => i.start === itemEnd(m) && i.id !== m.id);
    if (!prev || !next) throw new EditError('not_adjacent', `Slide needs a clip on each side of ${m.id}.`, { clipId: m.id });
    setItemEdges(ctx, prev, prev.start, itemEnd(prev) + d);
    setItemEdges(ctx, next, next.start + d, itemEnd(next));
    shiftItem(ctx, m, d);
  }
}

/* ----------------------------------------------------------------- moving / deleting */

export function move(ctx: Ctx, op: OpOf<'move'>): void {
  const group = members(ctx, op.clipIds, op.linked);
  const primary = getClip(ctx, op.clipIds[0]!);
  if (op.to === undefined && op.delta === undefined) throw new EditError('invalid', 'move needs either "delta" or "to".');
  const unit = groupUnit(ctx, group);
  const delta = snap(op.to !== undefined ? op.to - primary.start : (op.delta ?? 0), unit);

  const explicit = new Set(op.clipIds);
  let dest: ReturnType<typeof getTrack> | undefined;
  if (op.toTrackId) {
    dest = getTrack(ctx, op.toTrackId);
    requireUnlocked(dest);
    for (const id of explicit) {
      const src = getTrack(ctx, getClip(ctx, id).trackId);
      if (src.kind !== dest.kind) throw new EditError('kind_mismatch', `Cannot move a ${src.kind} clip onto ${dest.kind} track ${dest.name}.`, { clipId: id });
    }
  }
  const ids = new Set(group.map((g) => g.id));
  for (const m of group) requireUnlocked(getTrack(ctx, m.trackId));

  // lift, shift, then drop at the destination
  const lifted = group.map((m) => ({ m, from: getTrack(ctx, m.trackId) }));
  for (const { m, from } of lifted) removeItem(ctx, from.id, m.id);
  for (const { m } of lifted) shiftItem(ctx, m, delta);
  for (const { m, from } of lifted) {
    const target = dest && explicit.has(m.id) ? dest : from;
    if (op.mode === 'overwrite') carve(ctx, target, m.start, itemEnd(m), ids);
    insertItem(ctx, target, m);
  }
}

export function deleteItems(ctx: Ctx, op: OpOf<'delete'>): void {
  const byId = new Map<string, TrackItem>();
  for (const t of ctx.seq.tracks) for (const i of Object.values(t.items)) byId.set(i.id, i);
  const clipIds: string[] = [];
  const all: TrackItem[] = [];
  for (const id of op.itemIds) {
    const found = byId.get(id);
    if (!found) throw new EditError('not_found', `No item "${id}".`, { itemId: id });
    if (isClip(found)) clipIds.push(id);
    else all.push(found);
  }
  const seen = new Set<string>();
  for (const m of [...members(ctx, clipIds, op.linked), ...all]) if (!seen.has(m.id)) (seen.add(m.id), all.push(m));
  for (const item of new Set(all)) {
    requireUnlocked(getTrack(ctx, item.trackId));
    removeItem(ctx, item.trackId, item.id);
  }
}

export function rippleDelete(ctx: Ctx, op: OpOf<'rippleDelete'>): void {
  const group = members(ctx, op.clipIds, op.linked);
  const byTrack = new Map<string, Clip[]>();
  for (const m of group) byTrack.set(m.trackId, [...(byTrack.get(m.trackId) ?? []), m]);
  const shifts: (readonly [TrackItem, number])[] = [];
  for (const [trackId, removed] of byTrack) {
    const track = getTrack(ctx, trackId);
    requireUnlocked(track);
    const spans = removed.map((c) => ({ start: c.start, end: itemEnd(c) }));
    const ids = new Set(removed.map((c) => c.id));
    for (const item of trackItems(track)) {
      if (ids.has(item.id)) continue;
      const gone = spans.filter((s) => s.end <= item.start).reduce((n, s) => n + (s.end - s.start), 0);
      if (gone) shifts.push([item, -gone]);
    }
  }
  for (const m of group) removeItem(ctx, m.trackId, m.id);
  shiftMany(ctx, shifts);
}

/**
 * Cut a time range out of the timeline. With `ripple` the gap is closed on every selected track by the same amount,
 * so linked A/V and everything beneath stays in sync. The range is snapped on one grid (frames when any selected
 * track is video) and, by default, *inward* — never removing a tick outside what was asked for.
 */
export function removeRange(ctx: Ctx, op: OpOf<'removeRange'>): void {
  const tracks = op.trackIds ? op.trackIds.map((id) => getTrack(ctx, id)) : ctx.seq.tracks.filter((t) => !t.locked);
  for (const t of tracks) requireUnlocked(t);
  if (op.end <= op.start) throw new EditError('invalid', 'removeRange: end must be after start.', { start: op.start, end: op.end });
  const unit = tracks.some((t) => t.kind !== 'audio') ? ctx.frame : ctx.sample;
  const mode = op.snap === 'inward' ? ['ceil', 'floor'] : op.snap === 'outward' ? ['floor', 'ceil'] : ['round', 'round'];
  const s = snap(op.start, unit, mode[0] as 'ceil' | 'floor' | 'round');
  const e = snap(op.end, unit, mode[1] as 'ceil' | 'floor' | 'round');
  if (e <= s) throw new EditError('invalid', 'The range collapses to nothing once snapped to the edit grid.', { start: s, end: e });
  const len = e - s;

  for (const track of tracks) carve(ctx, track, s, e, undefined, true);
  if (op.ripple) shiftMany(ctx, tracks.flatMap((track) => trackItems(track).filter((item) => item.start >= e).map((item) => [item, -len] as const)));
  ctx.seq.markers = ctx.seq.markers
    .filter((m) => !(m.time >= s && m.time < e))
    .map((m) => (op.ripple && m.time >= e ? { ...m, time: m.time - len } : m));
}

/* -------------------------------------------------------------------- properties */

export function setSpeed(ctx: Ctx, op: OpOf<'setSpeed'>): void {
  const group = members(ctx, [op.clipId], op.linked);
  const primary = group[0]!;
  const ids = new Set(group.map((g) => g.id));
  const unit = groupUnit(ctx, group);
  const speed = reduce(op.speed);
  const sNew = speed.num / speed.den;
  // Pivot: the media time at the primary's first tick stays put on the timeline. Every member is re-placed from
  // that one fixed point, so clips with different in-points (J/L cuts) keep a mutually consistent mapping.
  const pivotOffset = primary.start - primary.sourceIn / sNew;
  const shifts: (readonly [TrackItem, number])[] = [];

  for (const m of group) {
    const track = getTrack(ctx, m.trackId);
    requireUnlocked(track);
    const oldDuration = m.duration;
    const oldEnd = itemEnd(m);
    const sourceLen = sourceSpan(oldDuration, m.speed); // the same stretch of source media as before
    const exactStart = pivotOffset + m.sourceIn / sNew;
    const start = snap(Math.round(exactStart), unit);
    const duration = Math.max(unit, snap(Math.round(sourceLen / sNew), unit));
    for (const prop of Object.keys(m.keyframes)) m.keyframes[prop] = scaleKeyframeTimes(m.keyframes[prop]!, duration, oldDuration);
    // fold the rounding of `start` into sourceIn so the mapping stays exact
    m.sourceIn += Math.round((start - exactStart) * sNew);
    m.start = start;
    m.speed = speed;
    m.duration = duration;
    m.audio.fadeIn = Math.min(m.audio.fadeIn, duration);
    m.audio.fadeOut = Math.min(m.audio.fadeOut, duration - m.audio.fadeIn);
    if (op.ripple) shifts.push(...laterItems(ctx, m.trackId, oldEnd, start + duration - oldEnd, ids));
    touch(ctx, m.trackId);
  }
  shiftMany(ctx, shifts);
}

function reduce(r: { num: number; den: number }): { num: number; den: number } {
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(r.num, r.den);
  return { num: r.num / d, den: r.den / d };
}

export function setClipProps(ctx: Ctx, op: OpOf<'setClipProps'>): void {
  for (const m of members(ctx, [op.clipId], op.linked)) {
    requireUnlocked(getTrack(ctx, m.trackId));
    const p = op.patch;
    if (p.name !== undefined) m.name = p.name;
    if (p.enabled !== undefined) m.enabled = p.enabled;
    if (p.transform) {
      const t = p.transform;
      if (t.position) Object.assign(m.transform.position, t.position);
      if (t.scale) Object.assign(m.transform.scale, t.scale);
      if (t.anchor) Object.assign(m.transform.anchor, t.anchor);
      if (t.crop) Object.assign(m.transform.crop, t.crop);
      if (t.rotation !== undefined) m.transform.rotation = t.rotation;
      if (t.opacity !== undefined) m.transform.opacity = t.opacity;
    }
    if (p.audio) {
      Object.assign(m.audio, p.audio);
      if (m.audio.fadeIn + m.audio.fadeOut > m.duration) {
        throw new EditError('invalid', `Fades on ${m.id} (${m.audio.fadeIn}+${m.audio.fadeOut}) are longer than the clip (${m.duration}).`, { clipId: m.id });
      }
    }
    touch(ctx, m.trackId);
  }
}

export function link(ctx: Ctx, op: OpOf<'link'>): void {
  const clips = op.clipIds.map((id) => getClip(ctx, id));
  const g = ctx.id('g');
  for (const c of clips) {
    c.linkGroupId = g;
    touch(ctx, c.trackId);
  }
}

export function unlink(ctx: Ctx, op: OpOf<'unlink'>): void {
  for (const id of op.clipIds) {
    const c = getClip(ctx, id);
    delete c.linkGroupId;
    touch(ctx, c.trackId);
  }
}

export function accept(ctx: Ctx, op: OpOf<'accept'>): void {
  for (const id of op.itemIds) {
    const found = ctx.seq.tracks.map((t) => t.items[id]).find(Boolean);
    if (!found) throw new EditError('not_found', `No item "${id}".`, { itemId: id });
    found.accepted = true;
  }
}

