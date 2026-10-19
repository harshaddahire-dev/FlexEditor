import { EditError } from '../errors';
import { type Ctx, getClip, getTrack, requireUnlocked, snap, touch } from '../ctx';
import { sortKeyframes } from '../keyframes';
import { findItem, itemCount, itemEnd } from '../query';
import { makeTrack } from '../sequence';
import type { CaptionItem, Keyframe, Transition } from '../types';
import type { OpOf } from '../schema';
import { maxTransitionDuration } from '../normalize';

/* ------------------------------------------------------------------- keyframes */

function normalizeKeyframe(k: OpOf<'addKeyframe'>['keyframe']): Keyframe {
  const out: Keyframe = { time: k.time, value: k.value, interpolation: k.interpolation };
  if (k.easeIn !== undefined) out.easeIn = k.easeIn;
  if (k.easeOut !== undefined) out.easeOut = k.easeOut;
  if (k.bezier) out.bezier = k.bezier;
  return out;
}

function assertKeyframeTimes(clipId: string, duration: number, kfs: readonly { time: number }[]): void {
  for (const k of kfs) {
    if (k.time < 0 || k.time > duration) {
      throw new EditError('out_of_bounds', `Keyframe at ${k.time} is outside clip ${clipId} (0…${duration}).`, { clipId, time: k.time, duration });
    }
  }
}

export function addKeyframe(ctx: Ctx, op: OpOf<'addKeyframe'>): void {
  const c = getClip(ctx, op.clipId);
  requireUnlocked(getTrack(ctx, c.trackId));
  assertKeyframeTimes(c.id, c.duration, [op.keyframe]);
  const list = (c.keyframes[op.prop] ??= []);
  const i = list.findIndex((k) => k.time === op.keyframe.time);
  if (i >= 0) list[i] = normalizeKeyframe(op.keyframe);
  else list.push(normalizeKeyframe(op.keyframe));
  c.keyframes[op.prop] = sortKeyframes(list);
  touch(ctx, c.trackId);
}

export function removeKeyframe(ctx: Ctx, op: OpOf<'removeKeyframe'>): void {
  const c = getClip(ctx, op.clipId);
  requireUnlocked(getTrack(ctx, c.trackId));
  const list = c.keyframes[op.prop];
  const i = list?.findIndex((k) => k.time === op.time) ?? -1;
  if (!list || i < 0) throw new EditError('not_found', `No ${op.prop} keyframe at ${op.time} on ${c.id}.`, { clipId: c.id });
  list.splice(i, 1);
  if (!list.length) delete c.keyframes[op.prop];
  touch(ctx, c.trackId);
}

export function setKeyframes(ctx: Ctx, op: OpOf<'setKeyframes'>): void {
  const c = getClip(ctx, op.clipId);
  requireUnlocked(getTrack(ctx, c.trackId));
  assertKeyframeTimes(c.id, c.duration, op.keyframes);
  const times = new Set<number>();
  for (const k of op.keyframes) {
    if (times.has(k.time)) throw new EditError('invalid', `Duplicate keyframe time ${k.time}.`, { clipId: c.id });
    times.add(k.time);
  }
  if (op.keyframes.length) c.keyframes[op.prop] = sortKeyframes(op.keyframes.map(normalizeKeyframe));
  else delete c.keyframes[op.prop];
  touch(ctx, c.trackId);
}

/* ----------------------------------------------------------------- transitions */

export function addTransition(ctx: Ctx, op: OpOf<'addTransition'>): void {
  const [aId, bId] = op.betweenClipIds;
  const a = getClip(ctx, aId);
  const b = getClip(ctx, bId);
  const track = getTrack(ctx, a.trackId);
  requireUnlocked(track);
  if (a.trackId !== b.trackId || itemEnd(a) !== b.start) throw new EditError('not_adjacent', 'A transition needs two clips that touch on the same track.', { a: aId, b: bId });
  if (track.transitions.some((t) => t.betweenClipIds[0] === aId && t.betweenClipIds[1] === bId)) {
    throw new EditError('invalid', `There is already a transition between ${aId} and ${bId}.`, { a: aId, b: bId });
  }
  const unit = track.kind === 'audio' ? ctx.sample : ctx.frame;
  const duration = snap(op.duration, unit);
  const max = maxTransitionDuration(ctx, a, b, op.alignment);
  if (duration > max) {
    throw new EditError('no_handle', `Not enough media handle for a ${duration}-tick ${op.alignment}-aligned transition; at most ${Math.floor(max / unit) * unit} is available.`, { a: aId, b: bId, requested: duration, max });
  }
  if (duration < unit) throw new EditError('invalid', 'Transition is too short.', { duration });
  const tr: Transition = { id: ctx.id('x'), type: op.transitionType, duration, alignment: op.alignment, params: op.params, betweenClipIds: [aId, bId] };
  track.transitions.push(tr);
  touch(ctx, track.id);
}

function findTransition(ctx: Ctx, id: string) {
  for (const track of ctx.seq.tracks) {
    const tr = track.transitions.find((t) => t.id === id);
    if (tr) return { track, tr };
  }
  throw new EditError('not_found', `No transition "${id}".`, { id });
}

export function setTransition(ctx: Ctx, op: OpOf<'setTransition'>): void {
  const { track, tr } = findTransition(ctx, op.id);
  requireUnlocked(track);
  const p = op.patch;
  if (p.transitionType !== undefined) tr.type = p.transitionType;
  if (p.alignment !== undefined) tr.alignment = p.alignment;
  if (p.params !== undefined) tr.params = p.params;
  if (p.duration !== undefined) {
    const a = getClip(ctx, tr.betweenClipIds[0]);
    const b = getClip(ctx, tr.betweenClipIds[1]);
    const unit = track.kind === 'audio' ? ctx.sample : ctx.frame;
    tr.duration = snap(p.duration, unit);
    const max = maxTransitionDuration(ctx, a, b, tr.alignment);
    if (tr.duration > max) throw new EditError('no_handle', `Not enough media handle: at most ${Math.floor(max / unit) * unit} ticks.`, { id: tr.id, max });
  } else if (p.alignment !== undefined) {
    const a = getClip(ctx, tr.betweenClipIds[0]);
    const b = getClip(ctx, tr.betweenClipIds[1]);
    if (tr.duration > maxTransitionDuration(ctx, a, b, tr.alignment)) {
      throw new EditError('no_handle', `Not enough media handle for ${tr.alignment} alignment at this duration.`, { id: tr.id });
    }
  }
  touch(ctx, track.id);
}

export function removeTransition(ctx: Ctx, op: OpOf<'removeTransition'>): void {
  const { track, tr } = findTransition(ctx, op.id);
  requireUnlocked(track);
  track.transitions = track.transitions.filter((t) => t.id !== tr.id);
  touch(ctx, track.id);
}

/* --------------------------------------------------------------------- effects */

export function applyEffect(ctx: Ctx, op: OpOf<'applyEffect'>): void {
  const c = getClip(ctx, op.clipId);
  requireUnlocked(getTrack(ctx, c.trackId));
  c.effects.push({ id: ctx.id('e'), type: op.effect.type, enabled: op.effect.enabled, params: op.effect.params });
  touch(ctx, c.trackId);
}

function effectOf(ctx: Ctx, clipId: string, effectId: string) {
  const c = getClip(ctx, clipId);
  requireUnlocked(getTrack(ctx, c.trackId));
  const i = c.effects.findIndex((e) => e.id === effectId);
  if (i < 0) throw new EditError('not_found', `No effect "${effectId}" on ${clipId}.`, { clipId, effectId });
  return { c, i };
}

export function setEffect(ctx: Ctx, op: OpOf<'setEffect'>): void {
  const { c, i } = effectOf(ctx, op.clipId, op.effectId);
  const e = c.effects[i]!;
  if (op.params) Object.assign(e.params, op.params);
  if (op.enabled !== undefined) e.enabled = op.enabled;
  touch(ctx, c.trackId);
}

export function removeEffect(ctx: Ctx, op: OpOf<'removeEffect'>): void {
  const { c, i } = effectOf(ctx, op.clipId, op.effectId);
  c.effects.splice(i, 1);
  // animation of that effect's parameters goes with it
  for (const prop of Object.keys(c.keyframes)) if (prop.startsWith(`effect:${op.effectId}.`)) delete c.keyframes[prop];
  touch(ctx, c.trackId);
}

export function reorderEffect(ctx: Ctx, op: OpOf<'reorderEffect'>): void {
  const { c, i } = effectOf(ctx, op.clipId, op.effectId);
  const [e] = c.effects.splice(i, 1);
  c.effects.splice(Math.min(op.toIndex, c.effects.length), 0, e!);
  touch(ctx, c.trackId);
}

/* -------------------------------------------------------------------- captions */

function captionTrack(ctx: Ctx, trackId: string) {
  const track = getTrack(ctx, trackId);
  requireUnlocked(track);
  if (track.kind !== 'caption') throw new EditError('kind_mismatch', `${track.name} is not a caption track.`, { trackId });
  return track;
}

function newCaption(ctx: Ctx, trackId: string, o: { start: number; duration: number; words: CaptionItem['words']; styleId: string; position?: { x: number; y: number }; createdBy?: string }): CaptionItem {
  const origin = (o.createdBy ?? 'user') as CaptionItem['createdBy'];
  const unit = ctx.frame;
  const start = snap(o.start, unit);
  const end = snap(o.start + o.duration, unit);
  return {
    kind: 'caption',
    id: ctx.id('p'),
    trackId,
    start,
    duration: Math.max(unit, end - start),
    words: o.words.map((w) => ({ ...w })),
    styleId: o.styleId,
    ...(o.position ? { position: o.position } : {}),
    createdBy: origin,
    accepted: origin === 'user',
  };
}

export function addCaption(ctx: Ctx, op: OpOf<'addCaption'>): void {
  const track = captionTrack(ctx, op.trackId);
  const cap = newCaption(ctx, track.id, op);
  track.items[cap.id] = cap;
  touch(ctx, track.id);
}

export function updateCaption(ctx: Ctx, op: OpOf<'updateCaption'>): void {
  const loc = findItem(ctx.seq, op.id);
  if (!loc || loc.item.kind !== 'caption') throw new EditError('not_found', `No caption "${op.id}".`, { id: op.id });
  requireUnlocked(loc.track);
  const c = loc.item;
  const p = op.patch;
  if (p.start !== undefined) c.start = snap(p.start, ctx.frame);
  if (p.duration !== undefined) c.duration = Math.max(ctx.frame, snap(p.duration, ctx.frame));
  if (p.words !== undefined) c.words = p.words.map((w) => ({ ...w }));
  if (p.styleId !== undefined) c.styleId = p.styleId;
  if (p.position !== undefined) c.position = p.position;
  touch(ctx, loc.track.id);
}

/** Replace every caption on a track in one step (used by caption generation). */
export function setCaptions(ctx: Ctx, op: OpOf<'setCaptions'>): void {
  const track = captionTrack(ctx, op.trackId);
  track.items = {};
  for (const i of op.items) {
    const cap = newCaption(ctx, track.id, { ...i, createdBy: op.createdBy });
    track.items[cap.id] = cap;
  }
  touch(ctx, track.id);
}

/* ---------------------------------------------------------- tracks / markers / sequence */

export function addTrack(ctx: Ctx, op: OpOf<'addTrack'>): void {
  const count = ctx.seq.tracks.filter((t) => t.kind === op.kind).length;
  const prefix = { video: 'V', audio: 'A', caption: 'C', graphics: 'G' }[op.kind];
  const track = makeTrack(ctx.id('t'), op.kind, op.name ?? `${prefix}${count + 1}`);
  const at = Math.min(op.index ?? ctx.seq.tracks.length, ctx.seq.tracks.length);
  ctx.seq.tracks.splice(at, 0, track);
}

export function removeTrack(ctx: Ctx, op: OpOf<'removeTrack'>): void {
  const track = getTrack(ctx, op.trackId);
  const held = itemCount(track);
  if (held && !op.force) throw new EditError('invalid', `${track.name} still holds ${held} item(s); pass force to delete them.`, { trackId: track.id });
  ctx.seq.tracks = ctx.seq.tracks.filter((t) => t.id !== track.id);
  ctx.touched.delete(track.id);
}

export function setTrackProps(ctx: Ctx, op: OpOf<'setTrackProps'>): void {
  const track = getTrack(ctx, op.trackId);
  Object.assign(track, op.patch);
}

export function moveTrack(ctx: Ctx, op: OpOf<'moveTrack'>): void {
  const i = ctx.seq.tracks.findIndex((t) => t.id === op.trackId);
  if (i < 0) throw new EditError('not_found', `No track "${op.trackId}".`, { trackId: op.trackId });
  const [t] = ctx.seq.tracks.splice(i, 1);
  ctx.seq.tracks.splice(Math.min(op.toIndex, ctx.seq.tracks.length), 0, t!);
}

export function addMarker(ctx: Ctx, op: OpOf<'addMarker'>): void {
  ctx.seq.markers.push({ id: ctx.id('k'), time: op.time, label: op.label, ...(op.note !== undefined ? { note: op.note } : {}), ...(op.color !== undefined ? { color: op.color } : {}) });
}

export function setMarker(ctx: Ctx, op: OpOf<'setMarker'>): void {
  const m = ctx.seq.markers.find((x) => x.id === op.id);
  if (!m) throw new EditError('not_found', `No marker "${op.id}".`, { id: op.id });
  Object.assign(m, op.patch);
}

export function removeMarker(ctx: Ctx, op: OpOf<'removeMarker'>): void {
  const i = ctx.seq.markers.findIndex((x) => x.id === op.id);
  if (i < 0) throw new EditError('not_found', `No marker "${op.id}".`, { id: op.id });
  ctx.seq.markers.splice(i, 1);
}

export function setSequenceProps(ctx: Ctx, op: OpOf<'setSequenceProps'>): void {
  Object.assign(ctx.seq, op.patch);
}
