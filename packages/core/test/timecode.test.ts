import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { framesToTimecode, secondsToTimecode, timecodeBase, timecodeToFrames } from '../src/timecode';
import { rational } from '../src/time';

const NTSC = rational(30000, 1001);
const NTSC60 = rational(60000, 1001);

describe('non-drop timecode', () => {
  it('formats common rates', () => {
    expect(framesToTimecode(0, rational(24))).toBe('00:00:00:00');
    expect(framesToTimecode(24 * 3600 + 24 * 61 + 5, rational(24))).toBe('01:01:01:05');
    expect(framesToTimecode(30 * 59 + 29, rational(30))).toBe('00:00:59:29');
    expect(framesToTimecode(-45, rational(30))).toBe('-00:00:01:15');
    expect(framesToTimecode(100, rational(24000, 1001))).toBe('00:00:04:04'); // 23.976 counts at 24, never drops
  });
  it('uses 3-digit frames at ≥100 fps', () => {
    expect(framesToTimecode(125, rational(120))).toBe('00:00:01:005');
    expect(timecodeBase(rational(120))).toBe(120);
  });
});

describe('drop-frame timecode (29.97 / 59.94)', () => {
  it('skips :00 and :01 labels each minute except every tenth', () => {
    expect(framesToTimecode(1799, NTSC)).toBe('00:00:59;29');
    expect(framesToTimecode(1800, NTSC)).toBe('00:01:00;02');
    expect(framesToTimecode(17981, NTSC)).toBe('00:09:59;29');
    expect(framesToTimecode(17982, NTSC)).toBe('00:10:00;00'); // tenth minute keeps its labels
    expect(framesToTimecode(17983, NTSC)).toBe('00:10:00;01');
  });
  it('exactly one hour of wall-clock time = 107,892 frames', () => {
    expect(framesToTimecode(107_892, NTSC)).toBe('01:00:00;00');
    expect(framesToTimecode(107_891, NTSC)).toBe('00:59:59;29');
  });
  it('59.94 drops four labels per minute', () => {
    expect(framesToTimecode(3599, NTSC60)).toBe('00:00:59;59');
    expect(framesToTimecode(3600, NTSC60)).toBe('00:01:00;04');
    expect(framesToTimecode(35_964, NTSC60)).toBe('00:10:00;00');
  });
  it('can be forced off', () => {
    expect(framesToTimecode(1800, NTSC, false)).toBe('00:01:00:00');
  });
  it('rejects labels that do not exist', () => {
    expect(timecodeToFrames('00:01:00;00', NTSC)).toBeNull();
    expect(timecodeToFrames('00:01:00;01', NTSC)).toBeNull();
    expect(timecodeToFrames('00:01:00;02', NTSC)).toBe(1800);
    expect(timecodeToFrames('00:10:00;00', NTSC)).toBe(17982);
  });
  it('seconds → timecode follows wall-clock time', () => {
    // 30000 frames at 29.97 is exactly 1001 s of wall-clock time — drop-frame timecode must read 16:41 on the dot.
    expect(secondsToTimecode({ num: 1001, den: 1 }, NTSC)).toBe('00:16:41;00');
    expect(framesToTimecode(30000, NTSC)).toBe('00:16:41;00');
  });
});

describe('parsing', () => {
  it('rejects malformed input and out-of-range fields', () => {
    expect(timecodeToFrames('1:2:3', rational(24))).toBeNull();
    expect(timecodeToFrames('00:00:60:00', rational(24))).toBeNull();
    expect(timecodeToFrames('00:00:00:24', rational(24))).toBeNull();
    expect(timecodeToFrames('00:00:00:23', rational(24))).toBe(23);
    expect(timecodeToFrames('-00:00:01:00', rational(25))).toBe(-25);
  });
});

describe('round trips', () => {
  const rates = [rational(24), rational(25), rational(30), NTSC, NTSC60, rational(24000, 1001), rational(50), rational(60)];
  it('frames → timecode → frames is the identity', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2_000_000, max: 2_000_000 }), fc.constantFrom(...rates), (frames, fps) => {
        expect(timecodeToFrames(framesToTimecode(frames, fps), fps)).toBe(frames);
      }),
      { numRuns: 2000 },
    );
  });
  it('timecode labels are strictly increasing (no duplicate or reversed labels)', () => {
    for (const fps of [NTSC, NTSC60]) {
      let prev = framesToTimecode(0, fps);
      for (let f = 1; f < 40_000; f++) {
        const cur = framesToTimecode(f, fps);
        expect(cur > prev, `${prev} → ${cur} at frame ${f}`).toBe(true);
        prev = cur;
      }
    }
  });
});
