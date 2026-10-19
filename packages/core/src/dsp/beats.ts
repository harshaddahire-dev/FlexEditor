import { fft, hann } from './fft';

export interface BeatResult {
  /** Median tempo of the tracked beats, beats per minute (0 when no pulse was found). */
  bpm: number;
  /** 0…1: how much stronger the onset envelope is on the beats than elsewhere. */
  confidence: number;
  /** Beat times in seconds from the start of the media. */
  beats: number[];
}

const N = 1024;
const HOP = 512;

/**
 * Tempo and beat tracking. Spectral-flux onset strength → autocorrelation tempo (with a log-normal prior around
 * 120 BPM) → dynamic-programming beat tracker (Ellis 2007), so the beat grid follows small tempo drift.
 * Feed it mono audio; it keeps only the onset envelope (≈94 values/s), not the audio.
 */
export class BeatAnalyzer {
  private readonly win = hann(N);
  private readonly buf = new Float32Array(N);
  private fill = 0;
  private prev: Float64Array | null = null;
  private readonly env: number[] = [];
  private readonly re = new Float64Array(N);
  private readonly im = new Float64Array(N);

  constructor(private readonly sampleRate: number) {}

  /** Onset envelope frames per second. */
  get fps(): number {
    return this.sampleRate / HOP;
  }

  push(mono: Float32Array): void {
    for (let i = 0; i < mono.length; i++) {
      this.buf[this.fill++] = mono[i]!;
      if (this.fill === N) {
        this.frame();
        this.buf.copyWithin(0, HOP);
        this.fill = N - HOP;
      }
    }
  }

  private frame(): void {
    for (let i = 0; i < N; i++) {
      this.re[i] = this.buf[i]! * this.win[i]!;
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    const lo = Math.max(1, Math.floor((30 * N) / this.sampleRate));
    const hi = Math.min(N / 2, Math.ceil((8000 * N) / this.sampleRate));
    const mag = new Float64Array(hi);
    let flux = 0;
    for (let k = lo; k < hi; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(this.re[k]!, this.im[k]!) / N);
      if (this.prev) flux += Math.max(0, mag[k]! - this.prev[k]!);
    }
    this.prev = mag;
    this.env.push(flux);
  }

  finish(): BeatResult {
    const env = prepare(this.env, this.fps);
    if (env.length < this.fps * 2) return { bpm: 0, confidence: 0, beats: [] };
    const bpm0 = estimateTempo(env, this.fps);
    if (bpm0 === 0) return { bpm: 0, confidence: 0, beats: [] };
    const frames = trackBeats(env, (60 * this.fps) / bpm0);
    const times = frames.map((f) => (f * HOP + N / 2) / this.sampleRate);
    const iois = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b);
    const bpm = iois.length ? 60 / iois[Math.floor(iois.length / 2)]! : bpm0;
    const onBeat = frames.reduce((s, f) => s + env[f]!, 0) / Math.max(1, frames.length);
    const mean = env.reduce((s, v) => s + v, 0) / env.length;
    return { bpm: Math.round(bpm * 10) / 10, confidence: Math.max(0, Math.min(1, 1 - mean / Math.max(onBeat, 1e-9))), beats: times };
  }
}

/** Remove the slow-moving baseline, rectify, normalise. */
function prepare(raw: number[], fps: number): Float64Array {
  const n = raw.length;
  const out = new Float64Array(n);
  const half = Math.round(fps * 0.4);
  let sum = 0;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + raw[i]!;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = Math.max(0, raw[i]! - (prefix[b]! - prefix[a]!) / (b - a));
    sum += out[i]!;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (out[i]! - mean) ** 2;
  const sd = Math.sqrt(varSum / n) || 1;
  for (let i = 0; i < n; i++) out[i]! /= sd;
  return out;
}

function estimateTempo(env: Float64Array, fps: number): number {
  const minLag = Math.floor((fps * 60) / 200);
  const maxLag = Math.ceil((fps * 60) / 55);
  const acf = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i]! * env[i - lag]!;
    acf[lag] = s / (env.length - lag);
  }
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (fps * 60) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    const v = acf[lag]! * prior;
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (best <= 0) return 0;
  // parabolic interpolation of the autocorrelation peak
  const y0 = acf[bestLag - 1]!;
  const y1 = acf[bestLag]!;
  const y2 = acf[bestLag + 1]!;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom === 0 ? 0 : (0.5 * (y0 - y2)) / denom;
  return (fps * 60) / (bestLag + Math.max(-1, Math.min(1, shift)));
}

/** Ellis (2007): best-scoring chain of onsets spaced about one period apart. Returns frame indices. */
function trackBeats(env: Float64Array, period: number, tightness = 100): number[] {
  const n = env.length;
  const score = new Float64Array(n);
  const from = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const v = score[t - d]! - tightness * Math.log(d / period) ** 2;
      if (arg < 0 || v > best) {
        best = v;
        arg = t - d;
      }
    }
    score[t] = env[t]! + (arg >= 0 ? best : 0);
    from[t] = arg;
  }
  // the chain ends at the best score within the last period
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t]! > score[end]!) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = from[t]!) {
    beats.push(t);
    if (from[t]! < 0) break;
  }
  return beats.reverse();
}
