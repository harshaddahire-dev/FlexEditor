import { AUDIO_SAMPLE_RATE, type Rational, type Rounding, rational } from '../time';
import { EditError } from './errors';
import type { Ticks, Timebase } from './types';

function gcdN(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return Math.abs(a);
}

/**
 * Pick the tick rate so that frames and samples are both whole numbers of ticks:
 * `rate = lcm(fps.num, sampleRate)`. 30 fps → 48000 (frame 1600, sample 1);
 * 29.97 → 240000 (frame 8008, sample 5); 23.976 → 48000 (frame 2002, sample 1).
 */
export function makeTimebase(fps: Rational, sampleRate = AUDIO_SAMPLE_RATE): Timebase {
  const reduced = rational(fps.num, fps.den);
  const rate = (reduced.num / gcdN(reduced.num, sampleRate)) * sampleRate;
  const tb: Timebase = { rate, fps: reduced, sampleRate };
  if (!Number.isSafeInteger(rate) || !Number.isInteger(frameTicks(tb))) throw new EditError('invalid', `Unsupported frame rate ${fps.num}/${fps.den}`);
  return tb;
}

export const frameTicks = (tb: Timebase): number => (tb.rate * tb.fps.den) / tb.fps.num;
export const sampleTicks = (tb: Timebase): number => tb.rate / tb.sampleRate;

export function roundTo(value: number, unit: number, mode: Rounding = 'round'): number {
  const q = value / unit;
  let n: number;
  switch (mode) {
    case 'floor':
      n = Math.floor(q);
      break;
    case 'ceil':
      n = Math.ceil(q);
      break;
    case 'trunc':
      n = Math.trunc(q);
      break;
    default:
      // ties away from zero, like the rest of the time model
      n = q < 0 ? -Math.round(-q) : Math.round(q);
  }
  // `+ 0` turns -0 into 0: negative zero would survive in memory but come back as 0 from project.json
  return n * unit + 0;
}

export const framesToTicks = (frames: number, tb: Timebase): Ticks => frames * frameTicks(tb);
export const samplesToTicks = (samples: number, tb: Timebase): Ticks => samples * sampleTicks(tb);

export function ticksToFrames(t: Ticks, tb: Timebase, mode: Rounding = 'round'): number {
  return roundTo(t, frameTicks(tb), mode) / frameTicks(tb);
}

export function ticksToSamples(t: Ticks, tb: Timebase, mode: Rounding = 'round'): number {
  return roundTo(t, sampleTicks(tb), mode) / sampleTicks(tb);
}

export const tbTicksToSeconds = (t: Ticks, tb: Timebase): Rational => rational(t, tb.rate);

/** Exact rational seconds → ticks (rounded to a whole tick). */
export function tbSecondsToTicks(s: Rational, tb: Timebase, mode: Rounding = "round"): Ticks {
  const q = (s.num * tb.rate) / s.den;
  return roundTo(q, 1, mode);
}

/** Milliseconds → ticks, rounded to a whole number of samples. */
export function msToTicks(ms: number, tb: Timebase): Ticks {
  return roundTo((ms / 1000) * tb.rate, sampleTicks(tb));
}

export const ticksToMs = (t: Ticks, tb: Timebase): number => (t * 1000) / tb.rate;
