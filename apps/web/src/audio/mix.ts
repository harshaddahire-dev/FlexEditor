import { type Timebase, type Voice, evaluateKeyframes, rampGain, dbToGain } from '@cutroom/core';

/** Slice length in samples: 0.5 s at 48 kHz. Slices sit on absolute multiples so every render path cuts identically. */
export type F32 = Float32Array<ArrayBuffer>;

export const SLICE_SAMPLES = 24_000;

export interface Slice {
  /** Timeline sample index of the first frame. */
  sample: number;
  frames: number;
}

const ticksPerSample = (tb: Timebase): number => tb.rate / tb.sampleRate;

/** Timeline samples a voice is audible for: sample i is included when start ≤ i·S < end. */
export function voiceSampleSpan(v: Voice, tb: Timebase): [number, number] {
  const S = ticksPerSample(tb);
  return [Math.ceil(v.start / S), Math.ceil(v.end / S)];
}

/** The slices of `v` that fall inside `[from, to)` (timeline samples), cut on absolute slice boundaries. */
export function slicesOf(v: Voice, tb: Timebase, from: number, to: number): Slice[] {
  const [vs, ve] = voiceSampleSpan(v, tb);
  const lo = Math.max(vs, from);
  const hi = Math.min(ve, to);
  const out: Slice[] = [];
  for (let s = lo; s < hi; ) {
    const end = Math.min(hi, (Math.floor(s / SLICE_SAMPLES) + 1) * SLICE_SAMPLES);
    out.push({ sample: s, frames: end - s });
    s = end;
  }
  return out;
}

/** Media frame (fractional unless speed is 1) played at timeline sample `i`. */
function sourcePos(v: Voice, tb: Timebase, mediaRate: number, i: number): number {
  const S = ticksPerSample(tb);
  const srcTicks = v.sourceStart + (i * S - v.start) * (v.speed.num / v.speed.den);
  return (srcTicks / S) * (mediaRate / tb.sampleRate);
}

/** Integer media-frame range `[from, to)` needed to bake a slice (with a margin for interpolation). */
export function sourceRange(v: Voice, tb: Timebase, mediaRate: number, s: Slice): [number, number] {
  const a = sourcePos(v, tb, mediaRate, s.sample);
  const b = sourcePos(v, tb, mediaRate, s.sample + s.frames - 1);
  return [Math.floor(Math.min(a, b)) - 1, Math.ceil(Math.max(a, b)) + 2];
}

const BALANCE = Math.PI / 2;

/**
 * Render one slice of a voice to stereo at the timeline sample rate: source samples (nearest sample at speed 1 —
 * no interpolation, so cuts stay sample-exact; linear interpolation otherwise), then clip gain, gain keyframes,
 * fades/crossfade ramps and balance. A pure function of the voice and the absolute sample index, which is what makes
 * the live graph and the offline export render identical.
 */
export function bakeSlice(v: Voice, tb: Timebase, mediaRate: number, src: Float32Array[], srcFrom: number, s: Slice): [F32, F32] {
  const S = ticksPerSample(tb);
  const L: F32 = new Float32Array(s.frames);
  const R: F32 = new Float32Array(s.frames);
  const left = src[0]!;
  const right = src[1] ?? left;
  const unit = v.speed.num === v.speed.den && mediaRate === tb.sampleRate;
  const shift = unit ? Math.round((v.sourceStart - v.start) / S) : 0;
  const gL = v.pan > 0 ? Math.cos(v.pan * BALANCE) : 1;
  const gR = v.pan < 0 ? Math.cos(-v.pan * BALANCE) : 1;
  const keyed = v.gainKeys.length > 0;
  const ramps = v.ramps;
  let keyGain = 1;
  const n = src[0]!.length;

  for (let j = 0; j < s.frames; j++) {
    const i = s.sample + j;
    const tick = i * S;
    let a: number;
    let b: number;
    if (unit) {
      const k = i + shift - srcFrom;
      a = k >= 0 && k < n ? left[k]! : 0;
      b = k >= 0 && k < n ? right[k]! : 0;
    } else {
      const pos = sourcePos(v, tb, mediaRate, i) - srcFrom;
      const k = Math.floor(pos);
      const f = pos - k;
      const at = (arr: Float32Array, idx: number) => (idx >= 0 && idx < n ? arr[idx]! : 0);
      a = at(left, k) * (1 - f) + at(left, k + 1) * f;
      b = at(right, k) * (1 - f) + at(right, k + 1) * f;
    }
    let g = v.gain;
    if (keyed && (j & 31) === 0) keyGain = dbToGain(evaluateKeyframes(v.gainKeys, tick - v.clipStart, 0));
    if (keyed) g *= keyGain;
    for (let r = 0; r < ramps.length; r++) {
      const ramp = ramps[r]!;
      if (tick <= ramp.from) g *= ramp.shape === 'in' ? 0 : 1;
      else if (tick >= ramp.to) g *= ramp.shape === 'in' ? 1 : 0;
      else g *= rampGain(ramp, tick);
    }
    L[j] = a * g * gL;
    R[j] = b * g * gR;
  }
  return [L, R];
}
