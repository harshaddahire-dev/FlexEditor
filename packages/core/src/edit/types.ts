import type { Rational } from '../time';

/**
 * Timeline model (OpenTimelineIO-inspired). All times are integer **ticks** of the sequence timebase,
 * where `rate = lcm(fps.num, sampleRate)` ticks per second — so every video frame and every audio sample
 * is an exact whole number of ticks and linked A/V can be compared with integer arithmetic.
 */
export type Ticks = number;

export type TrackKind = 'video' | 'audio' | 'caption' | 'graphics';
export type Origin = 'user' | `agent:${string}`;

export interface Timebase {
  /** Ticks per second. */
  rate: number;
  fps: Rational;
  sampleRate: number;
}

export interface Transform {
  /** Offset from centre, in sequence pixels. */
  position: { x: number; y: number };
  scale: { x: number; y: number };
  /** Degrees, clockwise. */
  rotation: number;
  /** Normalised pivot inside the clip frame (0.5, 0.5 = centre). */
  anchor: { x: number; y: number };
  opacity: number;
  /** Fractions of the frame trimmed from each side. */
  crop: { left: number; right: number; top: number; bottom: number };
}

export interface ClipAudio {
  gainDb: number;
  /** -1 (left) … +1 (right). */
  pan: number;
  /** Ticks. */
  fadeIn: Ticks;
  fadeOut: Ticks;
}

export type ParamValue = number | string | boolean;

export interface EffectInstance {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, ParamValue>;
}

export type Interpolation = 'linear' | 'bezier' | 'hold';

export interface Keyframe {
  /** Ticks from the clip's start. */
  time: Ticks;
  value: number;
  /** How the value travels from this keyframe to the next. */
  interpolation: Interpolation;
  /** Handle influences (0..1) used when `bezier` is not given. */
  easeIn?: number;
  easeOut?: number;
  /** Explicit cubic-bezier timing curve [x1, y1, x2, y2] for the outgoing segment. */
  bezier?: [number, number, number, number];
}

export interface Clip {
  kind: 'clip';
  id: string;
  mediaId: string;
  trackId: string;
  name?: string;
  /** Timeline position of the first tick. */
  start: Ticks;
  /** Length on the timeline. */
  duration: Ticks;
  /** Media time of the first tick. */
  sourceIn: Ticks;
  /** Source ticks consumed per timeline tick (1 = normal speed). */
  speed: Rational;
  enabled: boolean;
  transform: Transform;
  effects: EffectInstance[];
  /** Keyed by property path, e.g. `position.x`, `opacity`, `audio.gainDb`, `effect:e3.amount`. */
  keyframes: Record<string, Keyframe[]>;
  audio: ClipAudio;
  /** Clips sharing a group move/trim/delete together and must stay in sync. */
  linkGroupId?: string;
  createdBy: Origin;
  /** False for agent-created clips until the user accepts or edits them. */
  accepted: boolean;
}

export interface CaptionWord {
  text: string;
  /** Absolute timeline ticks. */
  start: Ticks;
  end: Ticks;
}

export interface CaptionItem {
  kind: 'caption';
  id: string;
  trackId: string;
  start: Ticks;
  duration: Ticks;
  words: CaptionWord[];
  styleId: string;
  position?: { x: number; y: number };
  createdBy: Origin;
  accepted: boolean;
}

export type TrackItem = Clip | CaptionItem;

export type TransitionAlignment = 'center' | 'start' | 'end';

export interface Transition {
  id: string;
  type: string;
  duration: Ticks;
  alignment: TransitionAlignment;
  params: Record<string, ParamValue>;
  betweenClipIds: [string, string];
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  locked: boolean;
  muted: boolean;
  solo: boolean;
  height: number;
  /** Milliseconds of equal-power crossfade/de-click applied at audio cuts (0 disables). */
  crossfadeMs: number;
  /**
   * Keyed by id, not a sorted array: an edit then touches only the items it changes, so patches stay tiny.
   * With an array, inserting or sorting shifts every later index and Immer emits a full-object patch for each —
   * 500 KB for one split on a 1,200-clip timeline. Use `trackItems()` for time order.
   */
  items: Record<string, TrackItem>;
  transitions: Transition[];
}

export interface Marker {
  id: string;
  time: Ticks;
  label: string;
  note?: string;
  color?: string;
}

export interface Sequence {
  id: string;
  name: string;
  timebase: Timebase;
  width: number;
  height: number;
  tracks: Track[];
  markers: Marker[];
  /** Deterministic id counter so operations are pure and replayable. */
  nextId: number;
}

/** What the engine needs to know about a media file (read-only; not part of undoable state). */
export interface MediaRef {
  id: string;
  kind: 'video' | 'audio' | 'image';
  /** Length in ticks; null = unbounded (stills, generators). */
  duration: Ticks | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface EditEnv {
  getMedia(id: string): MediaRef | undefined;
}

export const isClip = (i: TrackItem): i is Clip => i.kind === 'clip';
export const isCaption = (i: TrackItem): i is CaptionItem => i.kind === 'caption';
