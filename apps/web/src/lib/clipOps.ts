import { type Clip, type EditEnv, type Op, type Sequence, type Track, type Transition, defaultParams, findItem, isClip, itemEnd, maxTransitionDuration, trackItems, transitionDef } from '@cutroom/core';

export class OpsError extends Error {}

const videoClips = (seq: Sequence, ids: Iterable<string>): { clip: Clip; track: Track }[] => {
  const out: { clip: Clip; track: Track }[] = [];
  for (const id of ids) {
    const f = findItem(seq, id);
    if (f && isClip(f.item) && f.track.kind === 'video') out.push({ clip: f.item, track: f.track });
  }
  return out;
};

/** The cut a transition applies to: the end of the selected clip, else its start (when nothing follows it). */
export function transitionTarget(seq: Sequence, selection: Iterable<string>): { a: Clip; b: Clip; track: Track } | null {
  for (const { clip, track } of videoClips(seq, selection)) {
    const items = trackItems(track).filter(isClip);
    const next = items.find((c) => c.start === itemEnd(clip));
    if (next) return { a: clip, b: next, track };
    const prev = items.find((c) => itemEnd(c) === clip.start);
    if (prev) return { a: prev, b: clip, track };
  }
  return null;
}

/** Ops that put (or switch) a transition on the selected cut, as long as the media handles allow — shortened to fit if not. */
export function transitionOps(seq: Sequence, env: EditEnv, type: string, selection: Iterable<string>): { ops: Op[]; duration: number } {
  const def = transitionDef(type);
  if (!def) throw new OpsError(`Unknown transition "${type}".`);
  const target = transitionTarget(seq, selection);
  if (!target) throw new OpsError('Select a video clip that touches another clip, then choose a transition.');
  const { a, b, track } = target;
  const frame = (seq.timebase.rate * seq.timebase.fps.den) / seq.timebase.fps.num;
  const wanted = Math.round((def.duration * seq.timebase.rate) / frame) * frame;
  const existing: Transition | undefined = track.transitions.find((t) => t.betweenClipIds[0] === a.id && t.betweenClipIds[1] === b.id);
  const alignment = existing?.alignment ?? 'center';
  const max = Math.floor(maxTransitionDuration({ env }, a, b, alignment) / frame) * frame;
  const duration = Math.min(wanted, max);
  if (duration < frame * 2) throw new OpsError('These clips have no spare footage at the cut to blend — trim them shorter first so there are handles.');
  if (existing) return { ops: [{ type: 'setTransition', id: existing.id, patch: { transitionType: type, duration } }], duration };
  return { ops: [{ type: 'addTransition', betweenClipIds: [a.id, b.id], transitionType: type, duration, alignment, params: {} }], duration };
}

export function effectOps(seq: Sequence, type: string, selection: Iterable<string>): Op[] {
  const targets = videoClips(seq, selection);
  if (!targets.length) throw new OpsError('Select a video clip on the timeline to apply an effect.');
  return targets.map(({ clip }) => ({ type: 'applyEffect' as const, clipId: clip.id, effect: { type, params: defaultParams(type), enabled: true } }));
}
