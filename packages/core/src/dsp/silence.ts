export interface SampleRange {
  /** First sample (inclusive) and one past the last, at the file's sample rate. */
  start: number;
  end: number;
}

export interface SilenceOptions {
  sampleRate: number;
  /** Windows quieter than this (RMS over all channels, dBFS) count as silent. */
  thresholdDb?: number;
  /** Shortest run that is reported, seconds. */
  minSeconds?: number;
  /** Analysis window, milliseconds. */
  windowMs?: number;
}

/**
 * Streaming silence detector. Reports sample-exact ranges made of consecutive quiet windows that last at least
 * `minSeconds`. (Windows, not samples, decide quietness — a zero crossing is not silence.)
 */
export class SilenceDetector {
  private readonly win: number;
  private readonly minWins: number;
  private readonly limit: number;
  private acc = 0;
  private fill = 0;
  private winIndex = 0;
  private runStart = -1;
  private readonly ranges: SampleRange[] = [];
  private total = 0;

  constructor(private readonly o: SilenceOptions) {
    this.win = Math.max(1, Math.round((o.sampleRate * (o.windowMs ?? 10)) / 1000));
    this.minWins = Math.max(1, Math.ceil((o.minSeconds ?? 0.3) * o.sampleRate / this.win));
    this.limit = 10 ** ((o.thresholdDb ?? -40) / 10); // mean-square threshold
  }

  push(channels: readonly Float32Array[]): void {
    const n = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const ch of channels) s += ch[i]! * ch[i]!;
      this.acc += s / channels.length;
      if (++this.fill === this.win) this.window(this.win);
    }
    this.total += n;
  }

  private window(len: number): void {
    const quiet = this.acc / len < this.limit;
    if (quiet && this.runStart < 0) this.runStart = this.winIndex;
    if (!quiet && this.runStart >= 0) this.close(this.winIndex);
    this.winIndex++;
    this.acc = 0;
    this.fill = 0;
  }

  private close(endWin: number): void {
    if (endWin - this.runStart >= this.minWins) this.ranges.push({ start: this.runStart * this.win, end: endWin * this.win });
    this.runStart = -1;
  }

  finish(): SampleRange[] {
    if (this.fill > 0) {
      const partial = this.fill;
      const quiet = this.acc / partial < this.limit;
      if (quiet && this.runStart < 0) this.runStart = this.winIndex;
      if (!quiet && this.runStart >= 0) this.close(this.winIndex);
      this.winIndex++;
    }
    if (this.runStart >= 0) {
      const end = this.total;
      if (end - this.runStart * this.win >= this.minWins * this.win) this.ranges.push({ start: this.runStart * this.win, end });
      this.runStart = -1;
    }
    return this.ranges;
  }
}
