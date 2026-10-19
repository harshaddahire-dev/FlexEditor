/**
 * Waveform peaks: the minimum and maximum sample (over all channels) in every bin of `samplesPerBin` frames,
 * as 16-bit integers. A viewer builds coarser levels by reducing pairs of bins, so one level is all that is stored.
 */
export class PeakBuilder {
  private readonly out: number[] = [];
  private lo = 1;
  private hi = -1;
  private filled = 0;

  constructor(readonly samplesPerBin = 256) {}

  push(channels: readonly Float32Array[]): void {
    const n = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      for (const ch of channels) {
        const v = ch[i]!;
        if (v < this.lo) this.lo = v;
        if (v > this.hi) this.hi = v;
      }
      if (++this.filled === this.samplesPerBin) this.flush();
    }
  }

  private flush(): void {
    this.out.push(Math.round(Math.max(-1, this.lo) * 32767), Math.round(Math.min(1, this.hi) * 32767));
    this.lo = 1;
    this.hi = -1;
    this.filled = 0;
  }

  /** Interleaved [min0, max0, min1, max1, …]; a trailing partial bin is included. */
  finish(): Int16Array {
    if (this.filled) this.flush();
    return Int16Array.from(this.out);
  }
}

/** Halve the resolution: each output bin spans two input bins. */
export function reducePeaks(p: Int16Array): Int16Array {
  const bins = p.length / 2;
  const out = new Int16Array(Math.ceil(bins / 2) * 2);
  for (let i = 0; i < out.length / 2; i++) {
    const a = i * 2;
    const b = Math.min(bins - 1, a + 1);
    out[i * 2] = Math.min(p[a * 2]!, p[b * 2]!);
    out[i * 2 + 1] = Math.max(p[a * 2 + 1]!, p[b * 2 + 1]!);
  }
  return out;
}
