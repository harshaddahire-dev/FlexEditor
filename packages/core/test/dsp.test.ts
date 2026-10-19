import { describe, expect, it } from 'vitest';
import { BeatAnalyzer, LoudnessMeter, PeakBuilder, SilenceDetector, fft, reducePeaks } from '../src';

const SR = 48_000;
const sine = (seconds: number, hz: number, amp: number, phase = 0, sr = SR): Float32Array =>
  Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr + phase));
const feed = (push: (b: Float32Array[]) => void, ch: Float32Array[], block = 4800) => {
  for (let i = 0; i < ch[0]!.length; i += block) push(ch.map((c) => c.subarray(i, i + block)));
};
const db = (x: number) => 20 * Math.log10(x);

describe('fft', () => {
  it('puts a sine in the right bin', () => {
    const n = 1024;
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 64 * i) / n));
    const im = new Float64Array(n);
    fft(re, im);
    const mag = re.map((r, i) => Math.hypot(r, im[i]!));
    expect(mag.indexOf(Math.max(...mag.slice(0, n / 2)))).toBe(64);
    expect(mag[64]).toBeCloseTo(n / 2, 6);
  });
  it('rejects non power-of-two lengths', () => {
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
  });
});

describe('peaks', () => {
  it('records min/max per bin across channels, including a partial last bin', () => {
    const b = new PeakBuilder(4);
    b.push([Float32Array.from([0, 0.5, -0.25, 0, 0.1, 0.2]), Float32Array.from([0, 0, -0.75, 0, 0, 0])]);
    expect([...b.finish()]).toEqual([Math.round(-0.75 * 32767), Math.round(0.5 * 32767), 0, Math.round(0.2 * 32767)]);
  });
  it('reducePeaks merges neighbouring bins', () => {
    expect([...reducePeaks(Int16Array.from([-1, 2, -5, 1, 0, 9]))]).toEqual([-5, 2, 0, 9]);
  });
});

describe('SilenceDetector', () => {
  it('finds a gap to the sample and ignores short dips', () => {
    const x = new Float32Array(SR * 4);
    x.set(sine(1, 440, 0.5), 0);
    x.set(sine(1, 440, 0.5), SR * 2); // silence 1 s … 2 s
    x.set(sine(1, 440, 0.5), SR * 3);
    // a 50 ms dip at 2.5 s is not long enough (the 1 s of tone at [2,3) is replaced by tone with a hole)
    x.fill(0, SR * 2 + 24_000, SR * 2 + 24_000 + 2400);
    const d = new SilenceDetector({ sampleRate: SR, thresholdDb: -40, minSeconds: 0.3 });
    feed((c) => d.push(c), [x], 777); // odd block size: result must not depend on it
    expect(d.finish()).toEqual([{ start: SR, end: SR * 2 }]);
  });
  it('reports a trailing silence up to the last sample', () => {
    const x = new Float32Array(SR * 2);
    x.set(sine(1, 440, 0.5), 0);
    const d = new SilenceDetector({ sampleRate: SR });
    d.push([x]);
    expect(d.finish()).toEqual([{ start: SR, end: SR * 2 }]);
  });
});

describe('LoudnessMeter (BS.1770 / R128)', () => {
  const measure = (ch: Float32Array[], sr = SR) => {
    const m = new LoudnessMeter(sr, ch.length);
    feed((b) => m.push(b), ch, 4096);
    return m.result();
  };

  it('reads −23 LUFS for the EBU stereo reference sine (997 Hz, −23 dBFS per channel)', () => {
    const a = 10 ** (-23 / 20);
    const r = measure([sine(20, 997, a), sine(20, 997, a)]);
    expect(r.integrated).toBeCloseTo(-23, 1);
    expect(r.momentaryMax).toBeCloseTo(-23, 1);
    expect(r.range).toBeLessThan(0.5);
  });

  it('is linear in level and does not count silence (gating)', () => {
    const quiet = measure([sine(10, 997, 0.05), sine(10, 997, 0.05)]).integrated;
    const loud = measure([sine(10, 997, 0.1), sine(10, 997, 0.1)]).integrated;
    expect(loud - quiet).toBeCloseTo(6.02, 1);
    const padded = new Float32Array(SR * 30);
    padded.set(sine(10, 997, 0.1), SR * 10);
    expect(Math.abs(measure([padded, padded]).integrated - loud)).toBeLessThan(0.25); // edge blocks that straddle the burst pass the −10 LU gate
  });

  it('measures loudness range of a two-level programme', () => {
    const x = new Float32Array(SR * 40);
    x.set(sine(20, 997, 0.02), 0);
    x.set(sine(20, 997, 0.2), SR * 20); // +20 dB
    const r = measure([x, x]);
    expect(r.range).toBeGreaterThan(15);
    expect(r.range).toBeLessThan(21);
  });

  it('true peak sees the inter-sample peak that sample peak misses', () => {
    // fs/4 sine at 45°: every sample is ±0.707 but the waveform reaches 1.0
    const x = sine(2, SR / 4, 1, Math.PI / 4);
    const samplePeak = Math.max(...x.map(Math.abs));
    expect(db(samplePeak)).toBeCloseTo(-3.01, 1);
    expect(measure([x, x]).truePeak).toBeGreaterThan(-0.6);
    expect(measure([x, x]).truePeak).toBeLessThan(0.3);
  });

  it('gives −Infinity for digital silence', () => {
    expect(measure([new Float32Array(SR * 2)]).integrated).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('BeatAnalyzer', () => {
  const clicks = (bpm: number, seconds: number, offset = 0.13): Float32Array => {
    const x = new Float32Array(Math.round(seconds * SR));
    for (let t = offset; t < seconds - 0.05; t += 60 / bpm) {
      const at = Math.round(t * SR);
      for (let i = 0; i < 960; i++) x[at + i] = 0.8 * Math.exp(-i / 150) * Math.sin((2 * Math.PI * 1500 * i) / SR);
    }
    return x;
  };
  const run = (x: Float32Array) => {
    const a = new BeatAnalyzer(SR);
    feed((c) => a.push(c[0]!), [x], 3001);
    return a.finish();
  };

  for (const bpm of [90, 120, 140]) {
    it(`tracks a ${bpm} BPM click`, () => {
      const r = run(clicks(bpm, 24));
      expect(Math.abs(r.bpm - bpm)).toBeLessThan(1.5);
      expect(r.confidence).toBeGreaterThan(0.3);
      const period = 60 / bpm;
      // every tracked beat sits on a click within 25 ms
      const err = r.beats.map((t) => {
        const k = Math.round((t - 0.13) / period);
        return Math.abs(t - (0.13 + k * period));
      });
      expect(Math.max(...err)).toBeLessThan(0.025);
      expect(r.beats.length).toBeGreaterThan((24 / period) * 0.9);
    });
  }

  it('finds nothing in silence', () => {
    expect(run(new Float32Array(SR * 6)).bpm).toBe(0);
  });
});
