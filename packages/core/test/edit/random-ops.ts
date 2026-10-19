import { type Clip, type Op, type Sequence, type Track, allClips, itemEnd, sequenceDuration, isClip } from '../../src';
import type { Rig } from './helpers';

/** Small deterministic PRNG so a failing seed replays exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Generated {
  op: Op;
  /** The op deliberately breaks A/V link sync (unlinked slip/trim…), so desync warnings are legitimate afterwards. */
  desyncs: boolean;
}

const WEIGHTS: [string, number][] = [
  ['insert', 14], ['overwrite', 6], ['split', 10], ['trim', 8], ['rippleTrim', 5], ['rollTrim', 4], ['slip', 3], ['slide', 3],
  ['move', 8], ['delete', 4], ['rippleDelete', 4], ['removeRange', 8], ['setSpeed', 3], ['setClipProps', 3], ['keyframe', 4],
  ['transition', 4], ['effect', 3], ['caption', 3], ['marker', 2], ['track', 1], ['link', 2], ['accept', 1],
];

/** One random, usually-plausible operation for the current state. */
export function randomOp(rng: () => number, r: Rig, seq: Sequence): Generated {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const clips = allClips(seq);
  const total = Math.max(60, Math.ceil(sequenceDuration(seq) / r.F));
  const clipOrNone = (): Clip | undefined => (clips.length ? pick(clips) : undefined);

  /** A timeline time: mostly on frames, often at an existing edge, sometimes between frames/samples. */
  const time = (c?: Clip): number => {
    const m = rng();
    if (c && m < 0.35) {
      const edge = rng() < 0.5 ? c.start : itemEnd(c);
      return edge + int(-8, 8) * r.F;
    }
    if (m < 0.8) return int(0, total + 40) * r.F;
    if (m < 0.92) return int(0, (total + 40) * r.F);
    return int(0, (total + 40) * r.S * 20) * r.S;
  };
  const dframes = () => int(-40, 40) * r.F;

  let total_w = 0;
  for (const [, w] of WEIGHTS) total_w += w;
  let roll = rng() * total_w;
  let kind = 'insert';
  for (const [k, w] of WEIGHTS) {
    if ((roll -= w) <= 0) {
      kind = k;
      break;
    }
  }
  const c = clipOrNone();
  const vTracks = seq.tracks.filter((t) => t.kind === 'video');
  const aTracks = seq.tracks.filter((t) => t.kind === 'audio');
  const capTracks = seq.tracks.filter((t) => t.kind === 'caption');
  const linked = rng() < 0.9;
  const out = (op: Op, desyncs = false): Generated => ({ op, desyncs });

  switch (kind) {
    case 'insert':
    case 'overwrite': {
      const form = rng();
      const len = r.f(int(9, 240));
      const srcIn = r.f(int(0, 1200));
      const clipsSpec =
        form < 0.5
          ? [
              { trackId: pick(vTracks).id, mediaId: 'av', sourceIn: srcIn, sourceOut: srcIn + len, link: 'x' },
              { trackId: pick(aTracks).id, mediaId: 'av', sourceIn: srcIn, sourceOut: srcIn + len, link: 'x' },
            ]
          : form < 0.7
            ? [{ trackId: pick(vTracks).id, mediaId: 'v', sourceIn: srcIn % r.f(600), sourceOut: (srcIn % r.f(600)) + len }]
            : form < 0.92
              ? [{ trackId: pick(aTracks).id, mediaId: 'a', sourceIn: srcIn, sourceOut: srcIn + len }]
              : [{ trackId: pick(vTracks).id, mediaId: 'still', sourceIn: 0, sourceOut: len }];
      return out({ type: kind, at: time(c), clips: clipsSpec } as Op);
    }
    case 'split':
      return c ? out({ type: 'split', clipId: c.id, at: rng() < 0.7 ? c.start + int(1, Math.max(1, Math.floor(c.duration / r.F) - 1)) * r.F : time(c), linked }) : randomOp(rng, r, seq);
    case 'trim':
      return c ? out({ type: 'trim', clipId: c.id, edge: pick(['start', 'end'] as const), to: time(c), linked }, !linked) : randomOp(rng, r, seq);
    case 'rippleTrim':
      return c ? out({ type: 'rippleTrim', clipId: c.id, edge: pick(['start', 'end'] as const), to: time(c), linked, ...(rng() < 0.2 ? { rippleTracks: 'all' as const } : {}) }, !linked) : randomOp(rng, r, seq);
    case 'rollTrim': {
      const pairs = clips.flatMap((a) => clips.filter((b) => b.trackId === a.trackId && b.start === itemEnd(a)).map((b) => [a, b] as const));
      const pr = pairs.length ? pick(pairs) : undefined;
      return pr ? out({ type: 'rollTrim', leftClipId: pr[0].id, rightClipId: pr[1].id, to: itemEnd(pr[0]) + dframes(), linked }, !linked) : randomOp(rng, r, seq);
    }
    case 'slip':
      return c ? out({ type: 'slip', clipId: c.id, delta: dframes(), linked }, !linked) : randomOp(rng, r, seq);
    case 'slide':
      return c ? out({ type: 'slide', clipId: c.id, delta: int(-10, 10) * r.F, linked }, !linked) : randomOp(rng, r, seq);
    case 'move': {
      if (!c) return randomOp(rng, r, seq);
      const same = seq.tracks.filter((t) => t.kind === seq.tracks.find((x) => x.id === c.trackId)!.kind);
      return out({ type: 'move', clipIds: [c.id], to: Math.max(0, time(c)), linked, mode: rng() < 0.3 ? 'overwrite' : 'strict', ...(rng() < 0.25 ? { toTrackId: pick(same).id } : {}) }, !linked);
    }
    case 'delete':
      return c ? out({ type: 'delete', itemIds: [c.id], linked }) : randomOp(rng, r, seq);
    case 'rippleDelete':
      return c ? out({ type: 'rippleDelete', clipIds: [c.id], linked }) : randomOp(rng, r, seq);
    case 'removeRange': {
      const s = time(c);
      const len = int(1, 60) * r.F + (rng() < 0.3 ? int(0, r.F) : 0);
      return out({ type: 'removeRange', start: s, end: s + len, ripple: rng() < 0.85, snap: pick(['inward', 'nearest', 'outward'] as const) });
    }
    case 'setSpeed':
      return c ? out({ type: 'setSpeed', clipId: c.id, speed: pick([{ num: 2, den: 1 }, { num: 1, den: 2 }, { num: 3, den: 2 }, { num: 1, den: 1 }]), linked, ripple: rng() < 0.4 }) : randomOp(rng, r, seq);
    case 'setClipProps':
      return c ? out({ type: 'setClipProps', clipId: c.id, patch: { opacity: undefined, transform: { opacity: rng(), scale: { x: 0.5 + rng(), y: 0.5 + rng() } }, audio: { gainDb: -20 + rng() * 20 }, enabled: rng() < 0.9 } as never }) : randomOp(rng, r, seq);
    case 'keyframe': {
      if (!c) return randomOp(rng, r, seq);
      if (rng() < 0.2 && Object.keys(c.keyframes).length) {
        const prop = pick(Object.keys(c.keyframes));
        return out({ type: 'removeKeyframe', clipId: c.id, prop, time: pick(c.keyframes[prop]!).time });
      }
      return out({
        type: 'addKeyframe',
        clipId: c.id,
        prop: pick(['opacity', 'scale.x', 'position.x', 'rotation', 'audio.gainDb']),
        keyframe: { time: int(0, Math.floor(c.duration / r.F)) * r.F, value: rng() * 2, interpolation: pick(['linear', 'hold', 'bezier'] as const), easeIn: rng(), easeOut: rng() },
      });
    }
    case 'transition': {
      const t: Track | undefined = seq.tracks.filter((x) => x.transitions.length).length && rng() < 0.3 ? pick(seq.tracks.filter((x) => x.transitions.length)) : undefined;
      if (t) return out({ type: 'removeTransition', id: pick(t.transitions).id });
      const pairs = clips.flatMap((a) => clips.filter((b) => b.trackId === a.trackId && b.start === itemEnd(a)).map((b) => [a, b] as const));
      const pr = pairs.length ? pick(pairs) : undefined;
      return pr ? out({ type: 'addTransition', betweenClipIds: [pr[0].id, pr[1].id], transitionType: pick(['dissolve', 'wipe', 'crossfade']), duration: int(1, 40) * r.F, alignment: pick(['center', 'start', 'end'] as const) }) : randomOp(rng, r, seq);
    }
    case 'effect': {
      if (!c) return randomOp(rng, r, seq);
      if (c.effects.length && rng() < 0.4) return out({ type: 'removeEffect', clipId: c.id, effectId: pick(c.effects).id });
      return out({ type: 'applyEffect', clipId: c.id, effect: { type: pick(['exposure', 'blur', 'vignette']), params: { amount: rng() } } });
    }
    case 'caption': {
      if (!capTracks.length) return out({ type: 'addTrack', kind: 'caption' });
      const s = int(0, total) * r.F;
      return out({ type: 'addCaption', trackId: pick(capTracks).id, start: s, duration: int(5, 60) * r.F, words: [{ text: 'hello', start: s, end: s + r.F * 4 }], styleId: 'default' });
    }
    case 'marker':
      return out({ type: 'addMarker', time: int(0, total) * r.F, label: `m${int(0, 99)}` });
    case 'track':
      return out({ type: 'addTrack', kind: pick(['video', 'audio'] as const) });
    case 'link': {
      if (clips.length < 2) return randomOp(rng, r, seq);
      const a = pick(clips);
      const b = pick(clips);
      return a.id === b.id ? out({ type: 'unlink', clipIds: [a.id] }) : out({ type: 'link', clipIds: [a.id, b.id] }, true);
    }
    default:
      return c ? out({ type: 'accept', itemIds: [c.id] }) : randomOp(rng, r, seq);
  }
}

export { isClip };
