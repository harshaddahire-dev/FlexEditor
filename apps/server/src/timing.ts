import type { Rational } from '@cutroom/core';

export interface FrameTimingReport {
  count: number;
  /** True when presentation timestamps are not evenly spaced. */
  vfr: boolean;
  /** Most common frame duration, in time-base ticks. */
  medianDelta: number;
  minDelta: number;
  maxDelta: number;
  /** Frames whose spacing deviates from the median by more than the tolerance. */
  irregular: number;
  /** Average rate measured from first to last timestamp. */
  avgFps: number | null;
}

/**
 * Decide whether a video stream is constant or variable frame rate from its packet PTS values.
 * Timestamps are sorted first so B-frame reordering in decode order is irrelevant.
 *
 * A gap counts as irregular when it differs from the median gap by more than 20 %
 * (and by more than one tick, so millisecond-timebase rounding jitter such as 33/33/34 is ignored).
 */
export function analyzeFrameTiming(pts: readonly number[], timeBase: Rational): FrameTimingReport {
  const sorted = [...pts].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const empty: FrameTimingReport = { count: sorted.length, vfr: false, medianDelta: 0, minDelta: 0, maxDelta: 0, irregular: 0, avgFps: null };
  if (sorted.length < 3) return empty;

  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) deltas.push(sorted[i]! - sorted[i - 1]!);
  const byValue = [...deltas].sort((a, b) => a - b);
  const median = byValue[Math.floor(byValue.length / 2)]!;
  const tolerance = Math.max(1, median * 0.2);
  let irregular = 0;
  for (const d of deltas) if (Math.abs(d - median) > tolerance) irregular++;

  // N frames cover first→last plus the final frame's own duration (approximated by the median gap).
  const spanTicks = sorted[sorted.length - 1]! - sorted[0]! + median;
  const spanSeconds = (spanTicks * timeBase.num) / timeBase.den;
  return {
    count: sorted.length,
    vfr: irregular > 0,
    medianDelta: median,
    minDelta: byValue[0]!,
    maxDelta: byValue[byValue.length - 1]!,
    irregular,
    avgFps: spanSeconds > 0 ? sorted.length / spanSeconds : null,
  };
}
