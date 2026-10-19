import { audioJoins } from './audio';
import { itemEnd, trackClips } from './query';
import type { Clip, EditEnv, Keyframe, Sequence, Ticks } from './types';

/**
 * A multiplicative gain envelope over a span of the timeline. `in` rises 0→1 across `[from, to]` (0 before, 1 after);
 * `out` falls 1→0 (1 before, 0 after). Equal-power ramps use sin/cos so two ramps that cross sum to constant power.
 */
export interface GainRamp {
  from: Ticks;
  to: Ticks;
  shape: 'in' | 'out';
  curve: 'equal-power' | 'linear';
}

/** One clip's audible contribution. Crossfades extend a voice past its clip edges into its handle media. */
export interface Voice {
  clipId: string;
  mediaId: string;
  trackId: string;
  /** Audible timeline span [start, end) — wider than the clip where a crossfade reaches into its handles. */
  start: Ticks;
  end: Ticks;
  /** Media time (ticks) at `start`. May be fractional only for non-unit speeds. */
  sourceStart: Ticks;
  speed: { num: number; den: number };
  /** Linear gain from the clip's `gainDb`. */
  gain: number;
  /** -1 … +1 balance. */
  pan: number;
  ramps: GainRamp[];
  /** `audio.gainDb` keyframes, relative to the clip's own start. */
  gainKeys: Keyframe[];
  /** Timeline position of the clip's own start (the keyframe origin). */
  clipStart: Ticks;
}

export const dbToGain = (db: number): number => 10 ** (db / 20);

/** Gain multiplier of a ramp at timeline time `t` (ticks, may be fractional). */
export function rampGain(r: GainRamp, t: number): number {
  const span = r.to - r.from;
  const p = span <= 0 ? (t >= r.to ? 1 : 0) : Math.min(1, Math.max(0, (t - r.from) / span));
  const x = r.shape === 'in' ? p : 1 - p;
  return r.curve === 'equal-power' ? Math.sin((x * Math.PI) / 2) : x;
}

/**
 * Everything audible in a sequence, as voices. This is the single source of truth for "what plays": the live
 * Web Audio graph, the offline export render and QA checks all consume it, so they cannot disagree about fades.
 * Mute/solo are resolved here (solo anywhere ⇒ only soloed tracks are heard).
 */
export function planAudio(seq: Sequence, env: Pick<EditEnv, 'getMedia'>): Voice[] {
  const tb = seq.timebase;
  const anySolo = seq.tracks.some((t) => t.kind === 'audio' && t.solo);
  const voices: Voice[] = [];

  for (const track of seq.tracks) {
    if (track.kind !== 'audio') continue;
    if (anySolo ? !track.solo : track.muted) continue;
    const byClip = new Map<string, Voice>();
    for (const c of trackClips(track)) {
      if (!c.enabled) continue;
      const v = voiceOf(c);
      const fi = c.audio.fadeIn;
      const fo = c.audio.fadeOut;
      if (fi > 0) v.ramps.push({ from: c.start, to: c.start + fi, shape: 'in', curve: 'linear' });
      if (fo > 0) v.ramps.push({ from: itemEnd(c) - fo, to: itemEnd(c), shape: 'out', curve: 'linear' });
      byClip.set(c.id, v);
      voices.push(v);
    }

    for (const j of audioJoins(track, tb, env)) {
      const a = byClip.get(j.clipId);
      const b = j.otherClipId ? byClip.get(j.otherClipId) : undefined;
      switch (j.kind) {
        case 'continuous':
          break;
        case 'fade-in':
          if (a && j.duration > 0) a.ramps.push({ from: j.time, to: j.time + j.duration, shape: 'in', curve: 'equal-power' });
          break;
        case 'fade-out':
          if (a && j.duration > 0) a.ramps.push({ from: j.time - j.duration, to: j.time, shape: 'out', curve: 'equal-power' });
          break;
        case 'crossfade':
        case 'transition': {
          if (!a || !b || j.duration <= 0) break;
          const half = j.duration / 2;
          const lo = j.time - half;
          const hi = j.time + half;
          // the outgoing clip keeps playing its tail handle; the incoming one starts early from its head handle
          a.end = Math.max(a.end, hi);
          b.sourceStart -= (b.start - lo) * (b.speed.num / b.speed.den);
          b.start = Math.min(b.start, lo);
          a.ramps.push({ from: lo, to: hi, shape: 'out', curve: 'equal-power' });
          b.ramps.push({ from: lo, to: hi, shape: 'in', curve: 'equal-power' });
          break;
        }
      }
    }
  }
  return voices;
}

function voiceOf(c: Clip): Voice {
  return {
    clipId: c.id,
    mediaId: c.mediaId,
    trackId: c.trackId,
    start: c.start,
    end: itemEnd(c),
    sourceStart: c.sourceIn,
    speed: c.speed,
    gain: dbToGain(c.audio.gainDb),
    pan: c.audio.pan,
    ramps: [],
    gainKeys: c.keyframes['audio.gainDb'] ?? [],
    clipStart: c.start,
  };
}
