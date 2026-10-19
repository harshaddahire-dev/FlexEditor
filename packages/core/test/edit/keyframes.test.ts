import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { easeBezier, evaluateKeyframes, scaleKeyframeTimes, windowKeyframes } from '../../src/edit/keyframes';
import type { Keyframe } from '../../src/edit/types';

const k = (time: number, value: number, interpolation: Keyframe['interpolation'] = 'linear', extra: Partial<Keyframe> = {}): Keyframe => ({ time, value, interpolation, ...extra });

describe('evaluateKeyframes', () => {
  it('holds outside the range, interpolates inside', () => {
    const kfs = [k(100, 0), k(200, 10)];
    expect(evaluateKeyframes(kfs, 0, 5)).toBe(0);
    expect(evaluateKeyframes(kfs, 150, 5)).toBe(5);
    expect(evaluateKeyframes(kfs, 999, 5)).toBe(10);
    expect(evaluateKeyframes([], 10, 7)).toBe(7);
  });
  it('hold keeps the value until the next keyframe', () => {
    const kfs = [k(0, 1, 'hold'), k(100, 9)];
    expect(evaluateKeyframes(kfs, 99, 0)).toBe(1);
    expect(evaluateKeyframes(kfs, 100, 0)).toBe(9);
  });
  it('bezier ease-in-out is symmetric and monotone', () => {
    const kfs = [k(0, 0, 'bezier', { bezier: [0.42, 0, 0.58, 1] }), k(1000, 1)];
    expect(evaluateKeyframes(kfs, 500, 0)).toBeCloseTo(0.5, 5);
    expect(evaluateKeyframes(kfs, 250, 0)).toBeLessThan(0.25);
    let prev = -1;
    for (let t = 0; t <= 1000; t += 10) {
      const v = evaluateKeyframes(kfs, t, 0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it('easeBezier endpoints and the identity curve', () => {
    expect(easeBezier([0.42, 0, 0.58, 1], 0)).toBe(0);
    expect(easeBezier([0.42, 0, 0.58, 1], 1)).toBe(1);
    expect(easeBezier([1 / 3, 1 / 3, 2 / 3, 2 / 3], 0.3)).toBeCloseTo(0.3, 5);
  });
});

describe('windowKeyframes', () => {
  it('re-bases times and adds exact boundary keys for linear animation', () => {
    const kfs = [k(0, 0), k(1000, 10)];
    const w = windowKeyframes(kfs, 250, 750);
    expect(w).toEqual([k(0, 2.5), k(500, 7.5)]);
  });
  it('keeps keys that are all inside untouched (only re-based)', () => {
    expect(windowKeyframes([k(300, 1), k(400, 2)], 200, 800)).toEqual([k(100, 1), k(200, 2)]);
  });
  it('constant outside the keyed range', () => {
    expect(windowKeyframes([k(0, 3), k(100, 9)], 500, 900)).toEqual([k(0, 9)]);
    expect(windowKeyframes([k(500, 3), k(900, 9)], 0, 100)).toEqual([k(0, 3)]);
    expect(windowKeyframes([], 0, 10)).toEqual([]);
  });
  it('preserves exact key at the boundary', () => {
    const w = windowKeyframes([k(0, 0), k(500, 5), k(1000, 10)], 500, 1000);
    expect(w).toEqual([k(0, 5), k(500, 10)]);
  });

  it('animation inside the window is unchanged — linear, hold and bezier, random windows', () => {
    const interp = fc.constantFrom<Keyframe['interpolation']>('linear', 'hold', 'bezier');
    const kfArb = fc
      .uniqueArray(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 6 })
      .chain((times) =>
        fc
          .tuple(...times.map(() => fc.tuple(fc.integer({ min: -50, max: 50 }), interp, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))))
          .map((rows) => [...times].sort((a, b) => a - b).map((t, i) => k(t * 100, rows[i]![0], rows[i]![1], { easeOut: rows[i]![2], easeIn: rows[i]![3] }))),
      );
    fc.assert(
      fc.property(kfArb, fc.integer({ min: 0, max: 9000 }), fc.integer({ min: 100, max: 4000 }), (kfs, from, len) => {
        const to = from + len;
        const w = windowKeyframes(kfs, from, to);
        for (let i = 0; i <= 20; i++) {
          const rel = Math.round((len * i) / 20);
          const expected = evaluateKeyframes(kfs, from + rel, 0);
          const actual = w.length ? evaluateKeyframes(w, rel, 0) : 0;
          if (w.length) expect(actual).toBeCloseTo(expected, 4);
        }
        // keys are strictly ordered and inside [0, len]
        for (let i = 0; i < w.length; i++) {
          expect(w[i]!.time).toBeGreaterThanOrEqual(0);
          expect(w[i]!.time).toBeLessThanOrEqual(len);
          if (i) expect(w[i]!.time).toBeGreaterThan(w[i - 1]!.time);
        }
      }),
      { numRuns: 600 },
    );
  });
});

describe('scaleKeyframeTimes', () => {
  it('scales and rounds', () => {
    expect(scaleKeyframeTimes([k(0, 0), k(1000, 1)], 1, 2).map((x) => x.time)).toEqual([0, 500]);
  });
});
