/**
 * Rational time. Nothing in the editor stores time as a float:
 * video positions are integer frames at a sequence rate, audio positions are
 * integer samples, and anything in between is an exact {num, den} fraction.
 * Floats only appear at the very edge (UI display, Web Audio `currentTime`).
 */

export interface Rational {
  readonly num: number;
  readonly den: number;
}

export type Rounding = 'round' | 'floor' | 'ceil' | 'trunc';

export const AUDIO_SAMPLE_RATE = 48_000;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function toSafeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${what} exceeds safe integer range`);
  }
  return Number(v);
}

function assertInt(n: number, what: string): void {
  if (!Number.isInteger(n)) throw new TypeError(`${what} must be an integer, got ${n}`);
}

/** Build a reduced rational with a positive denominator. */
export function rational(num: number, den = 1): Rational {
  assertInt(num, 'numerator');
  assertInt(den, 'denominator');
  if (den === 0) throw new RangeError('denominator is zero');
  const n = BigInt(num);
  const d = BigInt(den);
  const g = gcd(n, d) || 1n;
  const sign = d < 0n ? -1n : 1n;
  return { num: toSafeNumber((sign * n) / g, 'numerator'), den: toSafeNumber((sign * d) / g, 'denominator') };
}

/** Parse "30000/1001", "25", or ffprobe's "0/0" (returns null for 0/0 or invalid). */
export function parseRational(text: string | undefined | null): Rational | null {
  if (text == null) return null;
  const m = /^\s*(-?\d+)\s*(?:\/\s*(-?\d+))?\s*$/.exec(text);
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (den === 0) return null;
  return rational(num, den);
}

/** Parse a decimal string like "12.345000" exactly (no float round-trip). */
export function parseDecimal(text: string | undefined | null): Rational | null {
  if (text == null) return null;
  const m = /^\s*(-?)(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!m) return null;
  const frac = m[3] ?? '';
  const den = 10n ** BigInt(frac.length);
  const num = BigInt(m[2]! + frac) * (m[1] === '-' ? -1n : 1n);
  const g = gcd(num, den) || 1n;
  return { num: toSafeNumber(num / g, 'numerator'), den: toSafeNumber(den / g, 'denominator') };
}

export function toNumber(r: Rational): number {
  return r.num / r.den;
}

export function equalsR(a: Rational, b: Rational): boolean {
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}

export function compareR(a: Rational, b: Rational): -1 | 0 | 1 {
  const l = BigInt(a.num) * BigInt(b.den);
  const r = BigInt(b.num) * BigInt(a.den);
  return l < r ? -1 : l > r ? 1 : 0;
}

export function addR(a: Rational, b: Rational): Rational {
  return reduceBig(BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den), BigInt(a.den) * BigInt(b.den));
}

export function subR(a: Rational, b: Rational): Rational {
  return reduceBig(BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den), BigInt(a.den) * BigInt(b.den));
}

export function mulR(a: Rational, b: Rational): Rational {
  return reduceBig(BigInt(a.num) * BigInt(b.num), BigInt(a.den) * BigInt(b.den));
}

function reduceBig(n: bigint, d: bigint): Rational {
  const g = gcd(n, d) || 1n;
  const s = d < 0n ? -1n : 1n;
  return { num: toSafeNumber((s * n) / g, 'numerator'), den: toSafeNumber((s * d) / g, 'denominator') };
}

/** Integer division of bigints with the requested rounding (den > 0). Ties round away from zero. */
function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d; // truncates toward zero
  const r = n % d;
  if (r === 0n) return q;
  switch (mode) {
    case 'trunc':
      return q;
    case 'floor':
      return n < 0n ? q - 1n : q;
    case 'ceil':
      return n < 0n ? q : q + 1n;
    case 'round': {
      const twice = (r < 0n ? -r : r) * 2n;
      if (twice < d) return q;
      return n < 0n ? q - 1n : q + 1n;
    }
  }
}

/**
 * Convert `ticks` counted at `from` ticks-per-second to ticks at `to` ticks-per-second.
 * e.g. rescale(3, fps30, 48000) → samples. Exact until the final rounding step.
 */
export function rescale(ticks: number, from: Rational, to: Rational, mode: Rounding = 'round'): number {
  assertInt(ticks, 'ticks');
  // seconds = ticks * from.den / from.num ; out = seconds * to.num / to.den
  const n = BigInt(ticks) * BigInt(from.den) * BigInt(to.num);
  const d = BigInt(from.num) * BigInt(to.den);
  return toSafeNumber(divRound(n, d, mode), 'result');
}

/** Rational seconds → integer ticks at `rate` ticks/second. */
export function secondsToTicks(seconds: Rational, rate: Rational, mode: Rounding = 'round'): number {
  const n = BigInt(seconds.num) * BigInt(rate.num);
  const d = BigInt(seconds.den) * BigInt(rate.den);
  return toSafeNumber(divRound(n, d, mode), 'result');
}

/** Integer ticks at `rate` ticks/second → exact rational seconds. */
export function ticksToSeconds(ticks: number, rate: Rational): Rational {
  assertInt(ticks, 'ticks');
  return reduceBig(BigInt(ticks) * BigInt(rate.den), BigInt(rate.num));
}

export const framesToSamples = (frames: number, fps: Rational, sampleRate = AUDIO_SAMPLE_RATE, mode: Rounding = 'round'): number =>
  rescale(frames, fps, rational(sampleRate), mode);

export const samplesToFrames = (samples: number, fps: Rational, sampleRate = AUDIO_SAMPLE_RATE, mode: Rounding = 'round'): number =>
  rescale(samples, rational(sampleRate), fps, mode);

/** Common broadcast/web frame rates, as exact rationals. */
export const STANDARD_FPS: readonly Rational[] = [
  rational(24000, 1001),
  rational(24),
  rational(25),
  rational(30000, 1001),
  rational(30),
  rational(48),
  rational(50),
  rational(60000, 1001),
  rational(60),
  rational(120),
];

/**
 * Snap a measured (possibly noisy) frame rate to the nearest standard rate if within `tolerance`
 * (relative). Falls back to the measurement rounded to 1/1000 fps.
 */
export function snapFps(measured: number, tolerance = 0.02): Rational {
  let best: Rational | null = null;
  let bestErr = Infinity;
  for (const s of STANDARD_FPS) {
    const err = Math.abs(toNumber(s) - measured) / toNumber(s);
    if (err < bestErr) {
      best = s;
      bestErr = err;
    }
  }
  if (best && bestErr <= tolerance) return best;
  return rational(Math.max(1, Math.round(measured * 1000)), 1000);
}

/** True for NTSC-family rates where drop-frame timecode applies (29.97, 59.94). */
export function isDropFrameRate(fps: Rational): boolean {
  return equalsR(fps, rational(30000, 1001)) || equalsR(fps, rational(60000, 1001));
}
