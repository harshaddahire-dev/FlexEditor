/** ITU-R BS.1770-4 / EBU R128 loudness: integrated, loudness range, momentary/short-term maxima and true peak. */

interface Biquad {
  b: [number, number, number];
  a: [number, number]; // a1, a2 (a0 = 1)
}

/** The two K-weighting stages for any sample rate (bilinear transform of the BS.1770 analogue prototypes). */
export function kWeighting(fs: number): [Biquad, Biquad] {
  const shelf = (() => {
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const fc = 1681.9744509555319;
    const K = Math.tan((Math.PI * fc) / fs);
    const Vh = 10 ** (G / 20);
    const Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    return { b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] } as Biquad;
  })();
  const high = (() => {
    const Q = 0.5003270373253953;
    const fc = 38.13547087613982;
    const K = Math.tan((Math.PI * fc) / fs);
    const a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] } as Biquad;
  })();
  return [shelf, high];
}

class Filter {
  private readonly z: [number, number][];
  constructor(private readonly stages: Biquad[]) {
    this.z = stages.map(() => [0, 0]);
  }
  process(x: number): number {
    let v = x;
    for (let s = 0; s < this.stages.length; s++) {
      const { b, a } = this.stages[s]!;
      const z = this.z[s]!;
      const y = b[0] * v + z[0];
      z[0] = b[1] * v - a[0] * y + z[1];
      z[1] = b[2] * v - a[1] * y;
      v = y;
    }
    return v;
  }
}

/**
 * 4× oversampled peak estimator. Between x[n] and x[n+1] the three in-between values are band-limited
 * interpolations over 12 neighbours (sinc × Hann); samples are processed with a 6-sample delay.
 */
class TruePeak {
  private static readonly TAPS = 12;
  private static readonly phases: Float64Array[] = [1, 2, 3].map((p) => {
    const h = new Float64Array(TruePeak.TAPS);
    let sum = 0;
    for (let j = 0; j < TruePeak.TAPS; j++) {
      const d = p / 4 - (j - 5); // distance from tap j (= x[n-5+j]) to the interpolation point
      const x = Math.PI * d;
      h[j] = (Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x) * (0.5 + 0.5 * Math.cos((Math.PI * d) / 6));
      sum += h[j]!;
    }
    for (let j = 0; j < TruePeak.TAPS; j++) h[j]! /= sum;
    return h;
  });
  private readonly hist = new Float64Array(TruePeak.TAPS); // oldest → newest
  peak = 0;

  push(x: number): void {
    const T = TruePeak.TAPS;
    this.hist.copyWithin(0, 1);
    this.hist[T - 1] = x;
    this.peak = Math.max(this.peak, Math.abs(x));
    for (const h of TruePeak.phases) {
      let y = 0;
      for (let j = 0; j < T; j++) y += h[j]! * this.hist[j]!;
      this.peak = Math.max(this.peak, Math.abs(y));
    }
  }
}

export interface LoudnessResult {
  /** Integrated programme loudness, LUFS (−Infinity if everything is below the gate). */
  integrated: number;
  /** Loudness range, LU. */
  range: number;
  momentaryMax: number;
  shortTermMax: number;
  /** dBTP */
  truePeak: number;
  /** Seconds measured. */
  duration: number;
}

const lufs = (ms: number): number => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : Number.NEGATIVE_INFINITY);

/** Streaming BS.1770 meter. Feed it blocks of up to two channels (channel weight 1 each). */
export class LoudnessMeter {
  private readonly filters: Filter[];
  private readonly peaks: TruePeak[];
  private readonly sub: number; // samples per 100 ms sub-block
  private fill = 0;
  private readonly acc: number[];
  /** Per sub-block: summed mean-square over channels. */
  private readonly blocks: number[] = [];
  private frames = 0;

  constructor(
    private readonly sampleRate: number,
    channels: number,
  ) {
    const stages = kWeighting(sampleRate);
    this.filters = Array.from({ length: channels }, () => new Filter([...stages]));
    this.peaks = Array.from({ length: channels }, () => new TruePeak());
    this.sub = Math.round(sampleRate / 10);
    this.acc = new Array<number>(channels).fill(0);
  }

  push(channels: readonly Float32Array[]): void {
    const n = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.filters.length; c++) {
        const x = channels[c]![i]!;
        this.peaks[c]!.push(x);
        const y = this.filters[c]!.process(x);
        this.acc[c]! += y * y;
      }
      if (++this.fill === this.sub) {
        this.blocks.push(this.acc.reduce((a, b) => a + b, 0) / this.sub);
        this.acc.fill(0);
        this.fill = 0;
      }
    }
    this.frames += n;
  }

  result(): LoudnessResult {
    const b = this.blocks;
    const window = (end: number, len: number): number => {
      let s = 0;
      for (let k = end - len + 1; k <= end; k++) s += b[k]!;
      return s / len;
    };
    // momentary: 400 ms windows hopping 100 ms; short-term: 3 s windows
    const mom: number[] = [];
    for (let k = 3; k < b.length; k++) mom.push(window(k, 4));
    const st: number[] = [];
    for (let k = 29; k < b.length; k++) st.push(window(k, 30));

    const gate = (values: number[], relDb: number): number => {
      const abs = values.filter((v) => lufs(v) > -70);
      if (!abs.length) return Number.NEGATIVE_INFINITY;
      const mean = abs.reduce((x, y) => x + y, 0) / abs.length;
      const rel = lufs(mean) + relDb;
      const kept = abs.filter((v) => lufs(v) > rel);
      return kept.length ? lufs(kept.reduce((x, y) => x + y, 0) / kept.length) : Number.NEGATIVE_INFINITY;
    };

    let range = 0;
    const absSt = st.filter((v) => lufs(v) > -70);
    if (absSt.length) {
      const rel = lufs(absSt.reduce((x, y) => x + y, 0) / absSt.length) - 20;
      const kept = absSt.filter((v) => lufs(v) > rel).map(lufs).sort((x, y) => x - y);
      if (kept.length > 1) {
        const at = (p: number) => kept[Math.min(kept.length - 1, Math.floor(p * (kept.length - 1) + 0.5))]!;
        range = at(0.95) - at(0.1);
      }
    }
    const peak = Math.max(0, ...this.peaks.map((p) => p.peak));
    return {
      integrated: gate(mom, -10),
      range,
      momentaryMax: mom.length ? lufs(Math.max(...mom)) : Number.NEGATIVE_INFINITY,
      shortTermMax: st.length ? lufs(Math.max(...st)) : Number.NEGATIVE_INFINITY,
      truePeak: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
      duration: this.frames / this.sampleRate,
    };
  }
}
