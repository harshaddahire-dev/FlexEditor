import { type Op, Editor, type EditEnv, type MediaRef, type Sequence, applyOp, createSequence, findClip, trackClips, frameTicks, sampleTicks, validateSequence, type Issue, allClips, type Clip, type Track } from '../../src';
import { rational, type Rational } from '../../src/time';

export const NTSC = rational(30000, 1001);

export interface Rig {
  seq: Sequence;
  env: EditEnv;
  ed: Editor;
  /** ticks per frame / sample / second */
  F: number;
  S: number;
  R: number;
  /** n frames in ticks */
  f(n: number): number;
  /** seconds in ticks */
  s(sec: number): number;
  ids: { V1: string; V2: string; A1: string; A2: string };
}

export const MEDIA_SECONDS = { av: 60, v: 30, a: 120 } as const;

/** Sequence with V1 V2 A1 A2 (t1..t4) and media: av (60 s A+V), v (30 s video), a (120 s audio), still (image). */
export function rig(fps: Rational = rational(30), opts: { tracks?: 'default' | 'none' } = {}): Rig {
  const seq = createSequence({ width: 1920, height: 1080, fps, tracks: opts.tracks });
  const tb = seq.timebase;
  const media: Record<string, MediaRef> = {
    av: { id: 'av', kind: 'video', duration: MEDIA_SECONDS.av * tb.rate, hasVideo: true, hasAudio: true },
    v: { id: 'v', kind: 'video', duration: MEDIA_SECONDS.v * tb.rate, hasVideo: true, hasAudio: false },
    a: { id: 'a', kind: 'audio', duration: MEDIA_SECONDS.a * tb.rate, hasVideo: false, hasAudio: true },
    still: { id: 'still', kind: 'image', duration: null, hasVideo: true, hasAudio: false },
  };
  const env: EditEnv = { getMedia: (id) => media[id] };
  const ed = new Editor(seq, env);
  return {
    seq,
    env,
    ed,
    F: frameTicks(tb),
    S: sampleTicks(tb),
    R: tb.rate,
    f: (n) => n * frameTicks(tb),
    s: (sec) => sec * tb.rate,
    ids: { V1: 't1', V2: 't2', A1: 't3', A2: 't4' },
  };
}

/** Apply and return the new state; the Editor keeps the history. */
export function run(r: Rig, op: Op): Sequence {
  r.ed.apply(op);
  return r.ed.state;
}

export const clipsOn = (seq: Sequence, trackId: string): Clip[] => trackClips(seq.tracks.find((t) => t.id === trackId)!);
export const track = (seq: Sequence, trackId: string): Track => seq.tracks.find((t) => t.id === trackId)!;
export const clip = (seq: Sequence, id: string): Clip => findClip(seq, id)!.clip;

/** [start, duration, sourceIn] in frames, for readable assertions. */
export function frames(r: Rig, c: Clip): [number, number, number] {
  return [c.start / r.F, c.duration / r.F, c.sourceIn / r.F];
}

export function problems(r: Rig, seq: Sequence = r.ed.state, opts?: Parameters<typeof validateSequence>[2]): Issue[] {
  return validateSequence(seq, r.env, opts);
}

/** Insert media `av` (A+V, linked) at frame `at`, seconds [inSec, outSec) of the media. Returns the new clip ids. */
export function insertAV(r: Rig, atFrame: number, inSec = 0, outSec = 10, media = 'av'): { v: string; a: string } {
  const before = new Set(allClips(r.ed.state).map((c) => c.id));
  r.ed.apply({
    type: 'insert',
    at: r.f(atFrame),
    clips: [
      { trackId: r.ids.V1, mediaId: media, sourceIn: r.s(inSec), sourceOut: r.s(outSec), link: 'x' },
      { trackId: r.ids.A1, mediaId: media, sourceIn: r.s(inSec), sourceOut: r.s(outSec), link: 'x' },
    ],
  });
  const fresh = allClips(r.ed.state).filter((c) => !before.has(c.id) && c.mediaId === media);
  return { v: fresh.find((c) => c.trackId === r.ids.V1)!.id, a: fresh.find((c) => c.trackId === r.ids.A1)!.id };
}

export { allClips, applyOp };
