import { itemEnd, isContinuous, trackClips } from './query';
import { handles } from './normalize';
import { msToTicks, sampleTicks } from './units';
import { type Clip, type EditEnv, type Ticks, type Timebase, type Track, isClip } from './types';

export type AudioJoinKind =
  /** Same media, same mapping: nothing to do. */
  | 'continuous'
  /** Equal-power overlap crossfade centred on the cut (needs handle media on both sides). */
  | 'crossfade'
  /** User-placed transition between the clips. */
  | 'transition'
  /** No handle to overlap: fade the outgoing clip down… */
  | 'fade-out'
  /** …and the incoming clip up, so there is never a hard step in the waveform. */
  | 'fade-in';

export interface AudioJoin {
  kind: AudioJoinKind;
  /** Cut position on the timeline. */
  time: Ticks;
  /** Total length of the fade/overlap, centred on `time` for crossfades. */
  duration: Ticks;
  clipId: string;
  otherClipId?: string;
}

/**
 * Every audio edge of a track and how it is smoothed. Derived (never stored) so that playback, export and QA
 * agree on exactly the same fades: crossfade where both clips have handle media, otherwise a de-click fade.
 */
export function audioJoins(track: Track, tb: Timebase, env: Pick<EditEnv, 'getMedia'>): AudioJoin[] {
  const clips = trackClips(track);
  const ms = track.crossfadeMs;
  const sample = sampleTicks(tb);
  const target = ms > 0 ? msToTicks(ms, tb) : 0;
  const out: AudioJoin[] = [];
  const edgeFade = (c: Clip): Ticks => Math.min(target, Math.floor(c.duration / 2 / sample) * sample);

  for (let i = 0; i < clips.length; i++) {
    const a = clips[i]!;
    const b = clips[i + 1];
    const adjacent = b !== undefined && itemEnd(a) === b.start;

    if (i === 0 || itemEnd(clips[i - 1]!) !== a.start) {
      out.push({ kind: 'fade-in', time: a.start, duration: edgeFade(a), clipId: a.id });
    }
    if (!adjacent) {
      out.push({ kind: 'fade-out', time: itemEnd(a), duration: edgeFade(a), clipId: a.id });
      continue;
    }
    const cut = itemEnd(a);
    if (isContinuous(a, b)) {
      out.push({ kind: 'continuous', time: cut, duration: 0, clipId: a.id, otherClipId: b.id });
      continue;
    }
    const stored = track.transitions.find((t) => t.betweenClipIds[0] === a.id && t.betweenClipIds[1] === b.id);
    if (stored) {
      out.push({ kind: 'transition', time: cut, duration: stored.duration, clipId: a.id, otherClipId: b.id });
      continue;
    }
    const ha = handles({ env }, a).tail;
    const hb = handles({ env }, b).head;
    const room = Math.floor((2 * Math.min(ha, hb)) / (2 * sample)) * 2 * sample;
    const d = Math.min(Math.floor(target / (2 * sample)) * 2 * sample, room, Math.min(a.duration, b.duration) * 2);
    if (target > 0 && d >= 2 * sample) out.push({ kind: 'crossfade', time: cut, duration: d, clipId: a.id, otherClipId: b.id });
    else {
      out.push({ kind: 'fade-out', time: cut, duration: edgeFade(a), clipId: a.id, otherClipId: b.id });
      out.push({ kind: 'fade-in', time: cut, duration: edgeFade(b), clipId: b.id, otherClipId: a.id });
    }
  }
  return out;
}
