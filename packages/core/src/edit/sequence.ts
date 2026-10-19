import type { Rational } from '../time';
import { makeTimebase } from './units';
import type { Clip, ClipAudio, Sequence, Track, TrackKind, Transform } from './types';

export const defaultTransform = (): Transform => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
  crop: { left: 0, right: 0, top: 0, bottom: 0 },
});

export const defaultClipAudio = (): ClipAudio => ({ gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0 });

export const DEFAULT_CROSSFADE_MS = 8;

export function makeTrack(id: string, kind: TrackKind, name: string): Track {
  return {
    id,
    kind,
    name,
    locked: false,
    muted: false,
    solo: false,
    height: kind === 'audio' ? 48 : 32,
    crossfadeMs: kind === 'audio' ? DEFAULT_CROSSFADE_MS : 0,
    items: {},
    transitions: [],
  };
}

export interface CreateSequenceOptions {
  id?: string;
  name?: string;
  width: number;
  height: number;
  fps: Rational;
  sampleRate?: number;
  /** `default` creates V1 V2 A1 A2; `none` creates an empty sequence. */
  tracks?: 'default' | 'none';
}

export function createSequence(o: CreateSequenceOptions): Sequence {
  const seq: Sequence = {
    id: o.id ?? 's1',
    name: o.name ?? 'Sequence 1',
    timebase: makeTimebase(o.fps, o.sampleRate),
    width: o.width,
    height: o.height,
    tracks: [],
    markers: [],
    nextId: 1,
  };
  if ((o.tracks ?? 'default') === 'default') {
    for (const [kind, name] of [['video', 'V1'], ['video', 'V2'], ['audio', 'A1'], ['audio', 'A2']] as const) {
      seq.tracks.push(makeTrack(`t${seq.nextId++}`, kind, name));
    }
  }
  return seq;
}

export type ClipSeed = Pick<Clip, 'mediaId' | 'trackId' | 'start' | 'duration' | 'sourceIn'> & Partial<Omit<Clip, 'kind'>>;

/** Fill in defaults for a new clip. */
export function buildClip(id: string, seed: ClipSeed): Clip {
  return {
    kind: 'clip',
    id,
    name: seed.name,
    mediaId: seed.mediaId,
    trackId: seed.trackId,
    start: seed.start,
    duration: seed.duration,
    sourceIn: seed.sourceIn,
    speed: seed.speed ?? { num: 1, den: 1 },
    enabled: seed.enabled ?? true,
    transform: seed.transform ?? defaultTransform(),
    effects: seed.effects ?? [],
    keyframes: seed.keyframes ?? {},
    audio: seed.audio ?? defaultClipAudio(),
    linkGroupId: seed.linkGroupId,
    createdBy: seed.createdBy ?? 'user',
    accepted: seed.accepted ?? (seed.createdBy ?? 'user') === 'user',
  };
}
