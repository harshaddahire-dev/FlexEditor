import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addR,
  compareR,
  equalsR,
  framesToSamples,
  isDropFrameRate,
  parseDecimal,
  parseRational,
  rational,
  rescale,
  samplesToFrames,
  secondsToTicks,
  snapFps,
  subR,
  ticksToSeconds,
} from '../src/time';

const NTSC = rational(30000, 1001);

describe('rational construction & parsing', () => {
  it('reduces and normalises sign', () => {
    expect(rational(60000, 2002)).toEqual({ num: 30000, den: 1001 });
    expect(rational(3, -6)).toEqual({ num: -1, den: 2 });
  });
  it('parses ffprobe rationals', () => {
    expect(parseRational('30000/1001')).toEqual(NTSC);
    expect(parseRational('25')).toEqual({ num: 25, den: 1 });
    expect(parseRational('0/0')).toBeNull();
    expect(parseRational('abc')).toBeNull();
    expect(parseRational(undefined)).toBeNull();
  });
  it('parses decimals exactly', () => {
    expect(parseDecimal('12.345000')).toEqual({ num: 2469, den: 200 });
    expect(parseDecimal('0.1')).toEqual({ num: 1, den: 10 });
    expect(parseDecimal('-1.5')).toEqual({ num: -3, den: 2 });
    expect(parseDecimal('nope')).toBeNull();
  });
});

describe('conversions', () => {
  it('29.97 fps: 30000 frames = 1001 seconds = 48,048,000 samples exactly', () => {
    expect(framesToSamples(30000, NTSC)).toBe(48_048_000);
    expect(samplesToFrames(48_048_000, NTSC)).toBe(30000);
  });
  it('one 29.97 frame = 1601.6 samples → rounds to 1602', () => {
    expect(framesToSamples(1, NTSC)).toBe(1602);
    expect(framesToSamples(1, NTSC, 48000, 'floor')).toBe(1601);
    expect(framesToSamples(1, NTSC, 48000, 'ceil')).toBe(1602);
  });
  it('rounding modes handle negatives and ties', () => {
    const half = rational(1, 2);
    const one = rational(1);
    expect(rescale(1, one, half, 'round')).toBe(1); // 0.5 rounds away from zero
    expect(rescale(1, one, half, 'floor')).toBe(0);
    expect(rescale(3, rational(2), one, 'round')).toBe(2); // 1.5 → 2 (away from zero)
    expect(rescale(-3, rational(2), one, 'round')).toBe(-2);
    expect(rescale(-3, rational(2), one, 'floor')).toBe(-2);
    expect(rescale(-3, rational(2), one, 'ceil')).toBe(-1);
    expect(rescale(-3, rational(2), one, 'trunc')).toBe(-1);
  });
  it('seconds <-> ticks', () => {
    expect(ticksToSeconds(1001, NTSC)).toEqual({ num: 1001 * 1001, den: 30000 });
    expect(secondsToTicks({ num: 1001, den: 1 }, NTSC)).toBe(30000);
  });
  it('rejects non-integers', () => {
    expect(() => rescale(1.5, NTSC, rational(48000))).toThrow(TypeError);
  });
  it('compare / add / sub', () => {
    expect(compareR(rational(1, 3), rational(1, 2))).toBe(-1);
    expect(equalsR(addR(rational(1, 3), rational(1, 6)), rational(1, 2))).toBe(true);
    expect(subR(rational(1, 2), rational(1, 2))).toEqual({ num: 0, den: 1 });
  });
});

describe('fps helpers', () => {
  it('snaps noisy VFR averages to standard rates', () => {
    expect(snapFps(29.97)).toEqual(NTSC);
    expect(snapFps(29.9)).toEqual(NTSC); // 0.2 % off 29.97, nearer than 30
    expect(snapFps(24.0)).toEqual(rational(24));
    expect(snapFps(59.94)).toEqual(rational(60000, 1001));
    expect(snapFps(17.5)).toEqual(rational(35, 2)); // not near a standard rate: kept to 1/1000 fps
  });
  it('knows drop-frame rates', () => {
    expect(isDropFrameRate(NTSC)).toBe(true);
    expect(isDropFrameRate(rational(60000, 1001))).toBe(true);
    expect(isDropFrameRate(rational(30))).toBe(false);
    expect(isDropFrameRate(rational(24000, 1001))).toBe(false);
  });
});

describe('properties', () => {
  const fpsArb = fc.constantFrom(NTSC, rational(24), rational(25), rational(30), rational(24000, 1001), rational(60000, 1001), rational(50));
  it('frames → samples → frames is the identity for every standard rate', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fpsArb, (frames, fps) => {
        expect(samplesToFrames(framesToSamples(frames, fps), fps)).toBe(frames);
      }),
    );
  });
  it('framesToSamples is monotonic and never off by more than half a sample', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fpsArb, (frames, fps) => {
        const exact = (frames * fps.den * 48000) / fps.num;
        expect(Math.abs(framesToSamples(frames, fps) - exact)).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(framesToSamples(frames + 1, fps)).toBeGreaterThan(framesToSamples(frames, fps));
      }),
    );
  });
  it('rescale floor <= round <= ceil', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), fpsArb, (t, fps) => {
        const r48 = rational(48000);
        const f = rescale(t, fps, r48, 'floor');
        const r = rescale(t, fps, r48, 'round');
        const c = rescale(t, fps, r48, 'ceil');
        expect(f).toBeLessThanOrEqual(r);
        expect(r).toBeLessThanOrEqual(c);
        expect(c - f).toBeLessThanOrEqual(1);
      }),
    );
  });
});
